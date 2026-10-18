// Pi relay page (/relay, /profiles): where the ATEM's stream goes.
//
// MediaMTX takes the ATEM's RTMP publish and forwards it natively, with no
// ffmpeg, to one destination at a time: a court relay over SRT (Court A or
// Court B, secrets in /etc/srt-relay/relays.env), or a profile over RTMP(S)
// straight to a service such as YouTube. Switching is a hot reload of
// MediaMTX's `forward` list: the ATEM's connection is never touched.
//
// The pages copy the owner's cloud relay dashboard (relay.onlygoals.tv):
// server-rendered, forms that POST and redirect back, refresh every 5 s.
// All state comes from MediaMTX's Control API on localhost.
//
// Profiles (name, destination, URL, stream key) live in relay-profiles.json
// next to gamestate.json, mode 600, gitignored. The browser only ever sees
// the last four characters of a key. The generated MediaMTX config holds the
// full forward URL and is root:mediamtx 640, written by
// /usr/local/bin/relay-target (sudo). A profile's URL goes to that script on
// stdin, never on a command line.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const express = require('express');

const API = 'http://127.0.0.1:9997';
const PROFILES_FILE = path.join(__dirname, '..', 'relay-profiles.json');
const TARGET_FILE = '/etc/srt-relay/target';
const TEMPLATE = '/etc/mediamtx/mediamtx.yml.tmpl';
const TARGET_SCRIPT = '/usr/local/bin/relay-target';
const PATH_RE = /^live(\/|$)/;           // the ATEM publishes to rtmp://10.42.0.1/live/<key>
const LATENCY_MS = 4000;                // SRT buffer to the courts; the relay's clock delay follows it
const COURTS = {
  courta: { name: 'Court A', host: 'courta.onlygoals.tv', cls: 'a' },
  courtb: { name: 'Court B', host: 'courtb.onlygoals.tv', cls: 'b' },
};
// Ingest URLs by service. The key goes after '#', which is how MediaMTX's
// forward URL carries an RTMP stream key. {key} in a custom URL places it
// elsewhere.
const DESTINATIONS = {
  'YouTube': 'rtmps://a.rtmps.youtube.com:443/live2',
  'YouTube (backup)': 'rtmps://b.rtmps.youtube.com:443/live2?backup=1',
  'Twitch': 'rtmps://ingest.global-contribute.live-video.net:443/app',
  'Facebook': 'rtmps://live-api-s.facebook.com:443/rtmp',
  'Custom': '',
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const mask = (key) => '••••' + String(key || '').slice(-4);
const fmtMbps = (bps) => (bps / 1e6).toFixed(1);
function fmtUp(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d} d ${h % 24} h`;
  if (h) return `${h} h ${m % 60} m`;
  return `${m} min`;
}

function apiGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(API + p, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`MediaMTX API ${p}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('MediaMTX API timeout')));
    req.on('error', reject);
  });
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
    if (input !== undefined) { proc.stdin.end(input); }
  });
}

// ---------- profiles ----------

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); } catch { return []; }
}
function saveProfiles(list) {
  const tmp = PROFILES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, PROFILES_FILE);
}
function profileUrl(p) {
  const base = p.destination === 'Custom' ? (p.url || '') : DESTINATIONS[p.destination];
  if (!base) throw new Error('profile has no ingest URL');
  return base.includes('{key}') ? base.replace('{key}', p.key) : `${base}#${p.key}`;
}
function validateProfile(body, existing) {
  const name = String(body.profile_name || '').trim().slice(0, 64);
  const destination = String(body.destination || 'YouTube');
  const url = String(body.url || '').trim();
  const key = String(body.stream_key || '').trim();
  if (!name) throw new Error('A profile needs a name.');
  if (!(destination in DESTINATIONS)) throw new Error('Unknown destination.');
  if (destination === 'Custom' && !/^rtmps?:\/\/[^\s"]+$/.test(url)) throw new Error('Custom URL must start with rtmp:// or rtmps://.');
  if (!key && !existing) throw new Error('Paste the stream key.');
  if (key && /[\s"#]/.test(key)) throw new Error('The stream key must not contain spaces, quotes or #.');
  return { name, destination, url: destination === 'Custom' ? url : '', key: key || existing.key };
}

// ---------- target (what MediaMTX forwards to) ----------

function readTarget() {
  try { return fs.readFileSync(TARGET_FILE, 'utf8').trim() || 'off'; } catch { return 'off'; }
}
async function setTarget(value) {
  if (value === 'off' || COURTS[value]) {
    await run('sudo', ['-n', TARGET_SCRIPT, value]);
    return;
  }
  const p = loadProfiles().find((x) => x.id === value);
  if (!p) throw new Error('No such profile.');
  await run('sudo', ['-n', TARGET_SCRIPT, 'profile', p.id, p.name.replace(/[^\w .-]/g, '')], profileUrl(p) + '\n');
}

// ---------- status ----------

function readRtmpPort() {
  try {
    const m = fs.readFileSync(TEMPLATE, 'utf8').match(/^rtmpAddress:\s*:?(\d+)/m);
    return m ? Number(m[1]) : 1935;
  } catch { return 1935; }
}

let versionCache = null;
function mediamtxVersion() {
  if (versionCache) return Promise.resolve(versionCache);
  return run('/usr/local/bin/mediamtx', ['--version']).then((v) => (versionCache = v.trim())).catch(() => 'unknown');
}

// Court relays answer 401 on their login page when up; anything else means
// stopped or unreachable. Checked at most every 15 s so the page stays quick.
const courtUp = {};
function checkCourt(id) {
  const c = COURTS[id];
  const now = Date.now();
  if (courtUp[id] && now - courtUp[id].t < 15000) return Promise.resolve(courtUp[id].up);
  return new Promise((resolve) => {
    const req = https.request({ host: c.host, path: '/', method: 'HEAD', timeout: 4000 }, (res) => {
      res.resume(); resolve(res.statusCode === 401 || res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  }).then((up) => { courtUp[id] = { t: now, up }; return up; });
}

// Bitrates come from byte counters sampled between page loads.
const samples = {};
function rate(key, bytes) {
  const now = Date.now();
  const prev = samples[key];
  samples[key] = { t: now, bytes };
  if (!prev || bytes < prev.bytes || now - prev.t < 500) return null;
  return (bytes - prev.bytes) * 8 / ((now - prev.t) / 1000);
}

async function serviceInfo() {
  const out = await run('systemctl', ['show', 'mediamtx', '-p', 'ActiveState', '-p', 'ExecMainStartTimestamp']).catch(() => '');
  const active = /ActiveState=active/.test(out);
  const m = out.match(/ExecMainStartTimestamp=(.+)/);
  const since = m && m[1].trim() ? new Date(m[1].trim()) : null;
  return { active, since };
}

async function status() {
  const target = readTarget();
  const [svc, version, paths, conns] = await Promise.all([
    serviceInfo(), mediamtxVersion(),
    apiGet('/v3/paths/list').catch(() => null),
    apiGet('/v3/rtmpconns/list').catch(() => null),
  ]);
  const apiOk = !!paths;
  const feedPath = apiOk ? paths.items.find((p) => PATH_RE.test(p.name) && p.ready) || paths.items.find((p) => PATH_RE.test(p.name)) : null;
  const publisher = conns ? conns.items.find((c) => c.state === 'publish' && PATH_RE.test(c.path)) : null;
  let dests = [];
  if (feedPath) {
    const d = await apiGet(`/v3/paths/forward-dests/list?path=${encodeURIComponent(feedPath.name)}`).catch(() => null);
    dests = d ? d.items : [];
  }
  const dest = dests[0] || null;
  const courts = {};
  await Promise.all(Object.keys(COURTS).map((id) => checkCourt(id).then((up) => { courts[id] = up; })));

  const profiles = loadProfiles();
  let current;
  if (COURTS[target]) current = { kind: 'court', id: target, name: COURTS[target].name, detail: COURTS[target].host, cls: COURTS[target].cls, up: courts[target] };
  else if (target.startsWith('profile:')) {
    const p = profiles.find((x) => x.id === target.slice(8));
    current = p ? { kind: 'profile', id: p.id, name: p.name, detail: `${p.destination} · key ${mask(p.key)}`, cls: 'n' }
      : { kind: 'missing', id: target.slice(8), name: 'deleted profile', detail: '', cls: 'n' };
  } else current = { kind: 'off', cls: 'n' };

  const feed = feedPath && feedPath.ready ? {
    name: feedPath.name,
    tracks: feedPath.tracks.join(' + '),
    since: feedPath.readyTime ? new Date(feedPath.readyTime) : null,
    bytes: feedPath.bytesReceived,
    mbps: rate('feed', feedPath.bytesReceived),
    from: publisher ? publisher.remoteAddr : null,
    errors: feedPath.inboundFramesInError,
  } : null;

  let sending = null;
  if (dest) {
    const t = dest.typeSpecific || {};
    sending = {
      state: dest.state, lastError: dest.lastError, protocol: dest.protocol,
      since: new Date(dest.created),
      mbps: rate('dest', dest.outboundBytes || 0),
      rtt: t.msRTT, capacity: t.mbpsLinkCapacity, lost: t.packetsSendLoss, resent: t.packetsRetrans,
      dropped: t.packetsSendDrop, remote: t.remoteAddr, discarded: t.outboundFramesDiscarded,
      latencyMs: t.msSendTsbPdDelay, srt: dest.protocol === 'srt',
    };
  }
  return { ok: svc.active && apiOk, svc, version, port: readRtmpPort(), target, current, feed, sending, courts, profiles };
}

// ---------- pages ----------

const AUTOFILL = 'autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other"';

const CSS = `
    :root {
      --bg:#0c0e13; --fg:#ffffff; --dim:#ffffff; --label:#000000; --line:rgba(255,255,255,.22);
      --a:rgba(60,170,95,.75); --b:rgba(36,82,190,.75); --inset:rgba(0,0,0,.28);
    }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
    a { color:var(--fg); }
    header { display:flex; align-items:center; gap:16px; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
    header strong { margin-right:8px; }
    main { display:grid; grid-template-columns:minmax(0,1fr); gap:14px 16px; max-width:860px; margin:0 auto; padding:16px; }
    .card { border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
    .card.a { background:var(--a); }
    .card.b { background:var(--b); }
    .card.n { background:rgba(255,255,255,.07); }
    .card.n h1, .card.n h2 { color:#9aa3b5; }
    .card.n .stats span { color:#9aa3b5; }
    body, input, select, button, code, small, .badge, .tag, .stats span, .stats b { font-size:15px; }
    header strong { font-size:22px; }
    header nav { display:flex; gap:18px; margin-right:auto; flex-wrap:wrap; }
    header nav a { font-weight:700; text-decoration:none; }
    header nav a.on { text-decoration:underline; text-underline-offset:6px; text-decoration-thickness:2px; }
    label { display:block; font-weight:800; color:var(--fg); margin:10px 0 4px; }
    .head h1 { font-size:22px; margin:0; letter-spacing:.04em; color:var(--label); }
    h2, h2 .dim { font-size:17px; margin:0; letter-spacing:.05em; color:var(--label); }
    .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .grow { flex:1 1 200px; min-width:0; }
    .dim { color:var(--dim); }
    .badge { font-weight:800; letter-spacing:.08em; white-space:nowrap; color:var(--fg); }
    .badge::before { content:"● "; }
    .badge.ok::before { animation:blink 1.6s ease-in-out infinite; }
    .badge.bad::before { color:#ff3030; animation:blink .5s steps(2, jump-none) infinite; }
    @keyframes blink { 50% { opacity:.15; } }
    @media (prefers-reduced-motion: reduce) { .badge.ok::before, .badge.bad::before { animation:none; } }
    .tag { font-weight:800; font-style:italic; color:var(--fg); white-space:nowrap; }
    .item { display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:10px 0; border-top:1px solid var(--line); }
    .item:first-of-type { border-top:0; }
    .item small, .card small { display:block; color:var(--dim); overflow-wrap:anywhere; }
    .warn { padding:8px 10px; border-radius:6px; font-weight:700; background:var(--inset); border:1px solid var(--fg); margin:10px 0 0; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(105px, 1fr)); gap:10px; margin-top:10px; }
    .stats span { display:block; font-weight:800; color:var(--label); }
    input, select, button { font:inherit; padding:8px 11px; border-radius:6px; border:1px solid var(--line);
                            background:var(--inset); color:var(--fg); }
    input, select { width:100%; }
    select option { color:#111; }
    input::placeholder { color:var(--dim); }
    button { cursor:pointer; font-weight:700; border:0; background:rgba(255,255,255,.2); color:var(--fg);
             box-shadow:0 2px 0 rgba(0,0,0,.35); }
    button:hover { background:rgba(255,255,255,.3); }
    button:active { transform:translateY(1px); box-shadow:0 1px 0 rgba(0,0,0,.35); }
    button.primary { background:var(--fg); color:#111; }
    button.primary:hover { background:#fff; }
    button:disabled { opacity:.5; cursor:default; }
    form { margin:0; }
    code { overflow-wrap:anywhere; }
    summary { cursor:pointer; list-style:none; }
    summary::-webkit-details-marker { display:none; }
`;

const SCROLL_SCRIPT = `
    document.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      window.relaySubmitting = true;
      try { sessionStorage.setItem('scrollY', String(window.scrollY)); } catch (err) {}
    });
    window.addEventListener('load', function () {
      try {
        var y = sessionStorage.getItem('scrollY');
        if (y !== null) { sessionStorage.removeItem('scrollY'); window.scrollTo(0, parseInt(y, 10) || 0); }
      } catch (err) {}
    });`;
const REFRESH_SCRIPT = `
    setInterval(function () {
      var a = document.activeElement;
      if (window.relaySubmitting) return;
      if (!a || (a.tagName !== 'INPUT' && a.tagName !== 'SELECT')) location.reload();
    }, 5000);`;

function layout({ title, page, refresh, body }) {
  const nav = [['/relay', 'Relay'], ['/profiles', 'Profiles'], ['/network', 'Network'], ['/dashboard', 'Dashboard']]
    .map(([href, label]) => `<a href="${href}" class="${href === page ? 'on' : ''}">${label}</a>`).join('\n         ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Scorebored</title>
<script>${SCROLL_SCRIPT}</script>
${refresh ? `<script>${REFRESH_SCRIPT}</script>` : ''}
<style>${CSS}</style>
</head>
<body>
<header><strong>Scorebored Relay</strong>
  <nav>${nav}</nav>
  ${refresh ? '<span class="dim">refreshes every 5 s</span>' : ''}</header>
<main>
${body}
</main>
</body>
</html>
`;
}

function errBox(req) {
  const e = req.query && req.query.err;
  return e ? `<div class="warn">${esc(e)}</div>` : '';
}

function relayPage(st, req) {
  const cls = st.current.cls;
  const c = st.current;

  // Head card
  let headBadge, headNote;
  if (!st.ok) { headBadge = '<span class="badge bad">DOWN</span>'; headNote = 'MediaMTX is not running or its API is not answering.'; }
  else if (c.kind === 'off') { headBadge = '<span class="badge">OFF</span>'; headNote = 'Nothing goes out. The ATEM\'s stream is accepted and dropped here.'; }
  else if (st.sending && st.sending.state === 'forwarding') { headBadge = '<span class="badge ok">RELAYING</span>'; headNote = `Sending the ATEM's stream to ${esc(c.name)}.`; }
  else if (st.sending && st.sending.state === 'error') { headBadge = '<span class="badge bad">RETRYING</span>'; headNote = `Cannot reach ${esc(c.name)}; MediaMTX retries every 5 s.`; }
  else { headBadge = '<span class="badge">ARMED</span>'; headNote = `Forwards to ${esc(c.name)} as soon as the ATEM publishes.`; }
  const up = st.svc.since ? `Up ${fmtUp(Date.now() - st.svc.since.getTime())} · ` : '';
  const head = `
  <section class="card head ${cls}">
    <div class="row"><h1 class="grow">PI RELAY</h1>${headBadge}</div>
    <small>${up}MediaMTX ${esc(st.version)} · ATEM publishes to <code>rtmp://10.42.0.1:${st.port}/live</code></small>
    <small style="margin-top:6px">${headNote}</small>
    ${errBox(req)}
  </section>`;

  // Incoming feed
  let feed;
  if (st.feed) {
    const f = st.feed;
    feed = `
  <section class="card ${cls}">
    <div class="row"><h2 class="grow">INCOMING FEED <span class="dim">(ATEM)</span></h2><span class="badge">ONLINE</span></div>
    <small>${esc(f.tracks)} · connected ${f.since ? fmtUp(Date.now() - f.since.getTime()) : '--'}</small>
    <div class="stats">
      <div><span>Bitrate</span><b>${f.mbps == null ? '--' : fmtMbps(f.mbps)}</b> Mbps</div>
      <div><span>Received</span><b>${(f.bytes / 1e6).toFixed(0)}</b> MB</div>
      <div><span>Frame errors</span><b>${f.errors ?? 0}</b></div>
      <div><span>Path</span><code>${esc(f.name)}</code></div>
      <div><span>From</span><code>${esc(f.from || '--')}</code></div>
    </div>
  </section>`;
  } else {
    feed = `
  <section class="card ${cls}">
    <div class="row"><h2 class="grow">INCOMING FEED <span class="dim">(ATEM)</span></h2><span class="badge">OFFLINE</span></div>
    <small>Nothing connected. Start streaming on the ATEM (custom URL <code>rtmp://10.42.0.1:${st.port}/live</code>, any key).</small>
  </section>`;
  }

  // Sending to
  const s = st.sending;
  let sendBadge, item = '';
  if (c.kind === 'off') sendBadge = '<span class="badge">OFF</span>';
  else if (!st.feed) sendBadge = '<span class="badge">ARMED</span>';
  else if (s && s.state === 'forwarding') sendBadge = '<span class="badge ok">RELAYING</span>';
  else if (s && s.state === 'error') sendBadge = '<span class="badge bad">RETRYING</span>';
  else sendBadge = '<span class="badge">STARTING</span>';

  if (c.kind !== 'off') {
    let tag = 'armed';
    if (st.feed && s) tag = s.state === 'forwarding' ? 'pushing' : s.state === 'error' ? 'retrying' : 'starting';
    const detail = c.kind === 'court'
      ? `· SRT · <code>${esc(c.detail)}</code> · relay ${c.up ? 'up' : 'stopped or unreachable'}`
      : `· ${esc(c.detail)}`;
    item = `
    <div class="item">
      <div class="grow"><b>${esc(c.name)}</b> <span class="dim">${detail}</span>
        ${s && s.lastError ? `<small>Last error: ${esc(s.lastError)}</small>` : ''}</div>
      <span class="tag">${tag}</span>
      <form method="post" action="/relay/target/reconnect" ${AUTOFILL}
            title="Disconnects and reconnects to the same destination (a few seconds).">
        <button>Reset Connection</button></form>
      <form method="post" action="/relay/target/remove" ${AUTOFILL} onsubmit="return confirm('Stop sending to ${esc(c.name)}?')">
        <button>Remove</button></form>
    </div>`;
    if (c.kind === 'court' && !c.up) item += `<div class="warn">${esc(c.name)} is not answering. Start it from the cloud dashboard; the Pi keeps retrying and connects by itself.</div>`;
  }
  let stats = '';
  if (s && st.feed && c.kind !== 'off') {
    stats = s.srt ? `
    <div class="stats">
      <div><span>Bitrate</span><b>${s.mbps == null ? '--' : fmtMbps(s.mbps)}</b> Mbps</div>
      <div><span>Link capacity</span><b>${s.capacity == null ? '--' : Math.round(s.capacity)}</b> Mbps</div>
      <div><span>RTT</span><b>${s.rtt == null ? '--' : Math.round(s.rtt)}</b> ms</div>
      <div><span>Latency</span><b>${s.latencyMs == null ? '--' : Math.round(s.latencyMs)}</b> / ${LATENCY_MS} ms</div>
      <div><span>Lost</span><b>${s.lost ?? '--'}</b></div>
      <div><span>Resent</span><b>${s.resent ?? '--'}</b></div>
      <div><span>Dropped</span><b>${s.dropped ?? '--'}</b></div>
      <div><span>Discarded frames</span><b>${s.discarded ?? '--'}</b></div>
      <div><span>To</span><code>${esc(s.remote || '--')}</code></div>
    </div>` : `
    <div class="stats">
      <div><span>Bitrate</span><b>${s.mbps == null ? '--' : fmtMbps(s.mbps)}</b> Mbps</div>
      <div><span>Protocol</span><b>${esc(s.protocol.toUpperCase())}</b></div>
      <div><span>Connected</span><b>${fmtUp(Date.now() - s.since.getTime())}</b></div>
    </div>`;
  }
  const options = [];
  for (const [id, court] of Object.entries(COURTS)) {
    if (c.kind === 'court' && c.id === id) continue;
    options.push(`<option value="${id}">${court.name} · ${court.host} · ${st.courts[id] ? 'up' : 'stopped'}</option>`);
  }
  for (const p of st.profiles) {
    if (c.kind === 'profile' && c.id === p.id) continue;
    options.push(`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.destination)} · ${mask(p.key)}</option>`);
  }
  const picker = `
    <form method="post" action="/relay/target" class="row" style="margin-top:10px" ${AUTOFILL}>
      <select name="target" class="grow" style="width:auto" aria-label="Destination" ${AUTOFILL}>
        ${options.join('\n        ')}
      </select>
      <button class="primary">Switch to it</button>
    </form>
    <small style="margin-top:8px">A court relay replaces whoever is publishing to it. Direct profiles skip the cloud relay's be-right-back card and goal clips. <a href="/profiles">Profiles</a></small>`;
  const sending = `
  <section class="card ${cls}">
    <div class="row"><h2 class="grow">SENDING TO</h2>${sendBadge}</div>
    ${item}${stats}${picker}
  </section>`;

  return layout({ title: 'Relay', page: '/relay', refresh: true, body: head + feed + sending });
}

function profilesPage(st, req) {
  const inUse = st.current.kind === 'profile' ? st.current.id : null;
  const destSelect = (sel) => `
      <select name="destination" ${AUTOFILL} onchange="this.parentNode.querySelector('.custom-url').style.display = this.value === 'Custom' ? '' : 'none'">
        ${Object.keys(DESTINATIONS).map((d) => `<option${d === sel ? ' selected' : ''}>${esc(d)}</option>`).join('')}
      </select>`;
  const items = st.profiles.map((p) => `
    <div class="item">
      <div class="grow"><b>${esc(p.name)}</b> <span class="dim">· ${esc(p.destination)} · key ${mask(p.key)}</span>
        <small>${inUse === p.id ? 'In use: the Pi is sending to it' : 'Not in use'}</small></div>
      <form method="post" action="/profiles/${esc(p.id)}/delete" ${AUTOFILL} onsubmit="return confirm('Delete profile ${esc(p.name)}?')">
        <button${inUse === p.id ? ' disabled title="Remove it from Sending to first"' : ''}>Delete</button>
      </form>
    </div>
    <details><summary class="dim">Edit ${esc(p.name)}</summary>
      <form method="post" action="/profiles/${esc(p.id)}/update" style="margin-bottom:10px" ${AUTOFILL}>
        <label>Name</label>
        <input name="profile_name" value="${esc(p.name)}" required maxlength="64" ${AUTOFILL}>
        <label>Destination</label>${destSelect(p.destination)}
        <div class="custom-url" style="display:${p.destination === 'Custom' ? '' : 'none'}">
          <label>Custom URL</label>
          <input name="url" value="${esc(p.url || '')}" placeholder="rtmp://server/app  (use {key} to place the key elsewhere)" ${AUTOFILL}>
        </div>
        <label>Stream key</label>
        <input name="stream_key" type="text" style="-webkit-text-security:disc" spellcheck="false" autocapitalize="off" placeholder="Leave blank to keep ${mask(p.key)}" ${AUTOFILL}>
        <p style="margin:12px 0 0"><button class="primary">Save</button></p>
      </form>
    </details>`).join('\n');

  const body = `
  <section class="card n">
    <div class="row"><h2 class="grow">PROFILES</h2><span class="dim">${st.profiles.length}</span></div>
    <small style="margin-top:6px">Every profile appears in the Relay page's Sending to list. A profile sends the ATEM's stream straight to the service, without the cloud relay. Keys are stored on the Pi only and never shown again.</small>
    ${errBox(req)}
    ${items || '<small style="margin-top:10px">No profiles yet.</small>'}
  </section>
  <section class="card n">
    <h2>NEW PROFILE</h2>
    <form method="post" action="/profiles" ${AUTOFILL}>
      <label>Name</label>
      <input name="profile_name" placeholder="e.g. LA Bike Polo YouTube" required maxlength="64" ${AUTOFILL}>
      <label>Destination</label>${destSelect('YouTube')}
      <div class="custom-url" style="display:none">
        <label>Custom URL</label>
        <input name="url" value="" placeholder="rtmp://server/app  (use {key} to place the key elsewhere)" ${AUTOFILL}>
      </div>
      <label>Stream key</label>
      <input name="stream_key" type="text" style="-webkit-text-security:disc" spellcheck="false" autocapitalize="off" placeholder="Paste the stream key" required ${AUTOFILL}>
      <p style="margin:12px 0 0"><button class="primary">Save profile</button></p>
    </form>
  </section>`;
  return layout({ title: 'Profiles', page: '/profiles', refresh: false, body });
}

// ---------- routes ----------

function registerRelayRoutes(app) {
  const form = express.urlencoded({ extended: false });
  const back = (res, page, err) => res.redirect(303, err ? `${page}?err=${encodeURIComponent(err)}` : page);

  app.get('/relay', async (req, res) => {
    try { res.type('html').send(relayPage(await status(), req)); } catch (e) { res.status(500).type('text').send(e.message); }
  });
  app.get('/profiles', async (req, res) => {
    try { res.type('html').send(profilesPage(await status(), req)); } catch (e) { res.status(500).type('text').send(e.message); }
  });

  app.post('/relay/target', form, async (req, res) => {
    try {
      const t = String(req.body.target || '');
      await setTarget(t);
      console.log(`Relay target set to ${t}`);
      back(res, '/relay');
    } catch (e) { back(res, '/relay', e.message); }
  });
  app.post('/relay/target/remove', form, async (req, res) => {
    try { await setTarget('off'); console.log('Relay target set to off'); back(res, '/relay'); } catch (e) { back(res, '/relay', e.message); }
  });
  app.post('/relay/target/reconnect', form, async (req, res) => {
    const t = readTarget();
    try {
      const id = t.startsWith('profile:') ? t.slice(8) : t;
      await setTarget('off');
      await new Promise((r) => setTimeout(r, 1500));
      await setTarget(id);
      console.log(`Relay target ${t} reconnected`);
      back(res, '/relay');
    } catch (e) { back(res, '/relay', e.message); }
  });

  app.post('/profiles', form, (req, res) => {
    try {
      const p = validateProfile(req.body, null);
      const list = loadProfiles();
      list.push({ id: crypto.randomBytes(5).toString('hex'), ...p, created: new Date().toISOString() });
      saveProfiles(list);
      console.log(`Relay profile added: ${p.name} (${p.destination})`);
      back(res, '/profiles');
    } catch (e) { back(res, '/profiles', e.message); }
  });
  app.post('/profiles/:id/update', form, async (req, res) => {
    try {
      const list = loadProfiles();
      const i = list.findIndex((x) => x.id === req.params.id);
      if (i < 0) throw new Error('No such profile.');
      list[i] = { ...list[i], ...validateProfile(req.body, list[i]) };
      saveProfiles(list);
      if (readTarget() === `profile:${list[i].id}`) await setTarget(list[i].id);   // apply the new URL/key live
      console.log(`Relay profile updated: ${list[i].name}`);
      back(res, '/profiles');
    } catch (e) { back(res, '/profiles', e.message); }
  });
  app.post('/profiles/:id/delete', form, (req, res) => {
    try {
      if (readTarget() === `profile:${req.params.id}`) throw new Error('That profile is in use. Remove it from Sending to first.');
      const list = loadProfiles();
      const p = list.find((x) => x.id === req.params.id);
      saveProfiles(list.filter((x) => x.id !== req.params.id));
      if (p) console.log(`Relay profile deleted: ${p.name}`);
      back(res, '/profiles');
    } catch (e) { back(res, '/profiles', e.message); }
  });
}

module.exports = { registerRelayRoutes, status, setTarget, readTarget, DESTINATIONS };
