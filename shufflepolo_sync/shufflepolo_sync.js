#!/usr/bin/env node
// Long-running Shufflepolo scoreboard-feed sync for scorebored.
//
// Based on Shufflepolo's own reference client
// (scripts/scoreboard-feed-client.mjs in their repo, docs/scoreboard-feed.md):
// reads the snapshot for one tournament, subscribes to its realtime change
// signal over Supabase Realtime, and re-reads whenever something changes.
// This process additionally, on every snapshot:
//
//   1. POSTs a compact live-game snapshot (score/clock) to the scorebored
//      Node server (POST /api/sync/shufflepolo/push), which merges it into
//      gameState and broadcasts it over socket.io. Node owns the
//      left/right <-> team1/team2 mapping (it respects whatever the
//      operator's sidesSwapped toggle is currently set to), same as
//      podium_sync.py's home/away handling.
//   2. Writes local state files the control panel reads over REST, mirroring
//      the challonge_sync.py / podium_sync.py pattern:
//
//       state/status.json        - {state, connected, last_poll_at, last_error}
//       state/participants.json  - full roster [{id, name, seed}]
//       state/bracket.json       - current bracket, for the bracket viewer
//
//   3. Overwrites the app's top-level bracket.json (the manual schedule file
//      Next/Prev Game reads) from the tournament's games list, same as the
//      other two syncs do — so bracket.json stays the single source
//      Next/Prev Game walks regardless of which sync (or none) is active.
//
// Read-only against Shufflepolo: the feed is read-only by design (see
// docs/scoreboard-feed.md); this script only ever GETs the snapshot and
// listens on the websocket, never writes anything back.
//
// Usage:
//   SHUFFLEPOLO_TOURNAMENT=<uuid> [SHUFFLEPOLO_FEED_URL=...] \
//     PUSH_URL=http://localhost:3000/api/sync/shufflepolo/push \
//     node shufflepolo_sync.js

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TOURNAMENT = process.env.SHUFFLEPOLO_TOURNAMENT;
const FEED_URL = process.env.SHUFFLEPOLO_FEED_URL || 'https://xavxyvnrtqccnyonlfeu.supabase.co/functions/v1/scoreboard-feed';
const PUSH_URL = process.env.PUSH_URL || 'http://localhost:3000/api/sync/shufflepolo/push';

if (!TOURNAMENT) {
  console.error('usage: SHUFFLEPOLO_TOURNAMENT=<uuid> node shufflepolo_sync.js');
  process.exit(2);
}

// The feed contract's numbers (docs/scoreboard-feed.md, "Usage rules"). Don't lower them.
const MIN_READ_INTERVAL_MS = 2_000;
const SAFETY_POLL_MS = 5 * 60_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

const SCRIPT_DIR = __dirname;
const STATE_DIR = path.join(SCRIPT_DIR, 'state');
const APP_BRACKET_FILE = path.join(SCRIPT_DIR, '..', 'bracket.json');

const DEFAULT_LEFT_COLOR = '#292929';
const DEFAULT_RIGHT_COLOR = '#ebebeb';

const snapshotUrl = `${FEED_URL}?tournament=${encodeURIComponent(TOURNAMENT)}`;

const log = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

fs.mkdirSync(STATE_DIR, { recursive: true });

// ------------------------------------------------------------------ state files

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function writeState(filename, data) {
  writeJsonAtomic(path.join(STATE_DIR, filename), data);
}

function writeStatus(state, extra = {}) {
  writeState('status.json', {
    state,
    last_poll_at: new Date().toISOString(),
    last_error: null,
    ...extra,
  });
}

function writeStatusError(error) {
  writeState('status.json', {
    state: 'error',
    last_poll_at: new Date().toISOString(),
    last_error: error,
  });
}

// ------------------------------------------------------------------ push to server.js

function pushJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

// ---------------------------------------------------------- shape -> app state

// bestClockOffsetMs holds this process's most accurate clock-sync reading
// (Shufflepolo server time minus our own), kept across reads rather than
// recomputed fresh each time - per the round-trip-timing analysis a
// Shufflepolo dev gave us: offset should be measured as
// server_now - (t0+t1)/2 (t0/t1 bracketing the HTTP request), and once
// measured, a reading from a SLOWER round trip should never replace one
// from a faster round trip, since the slower one carries more timing
// uncertainty, not fresher information. Plain Date.now() throughout, not
// monotonic time, because this value is only ever used to interpret an
// ISO wall-clock timestamp (running_since) the same way the server
// computed it - it's a wall-clock-to-wall-clock offset, not a duration.
let bestClockOffsetMs = null;
let bestClockOffsetRoundTripMs = Infinity;

function updateClockOffset(serverNowIso, t0, t1) {
  const serverNowMs = Date.parse(serverNowIso);
  if (isNaN(serverNowMs)) return;
  const roundTripMs = t1 - t0;
  const midpointMs = (t0 + t1) / 2;
  const offsetMs = serverNowMs - midpointMs;
  if (bestClockOffsetMs === null || roundTripMs < bestClockOffsetRoundTripMs) {
    bestClockOffsetMs = offsetMs;
    bestClockOffsetRoundTripMs = roundTripMs;
  }
}

function buildLiveSnapshot(snapshot) {
  const live = snapshot.live && snapshot.live[0];
  if (!live) {
    return { connected: true, has_game: false };
  }
  return {
    connected: true,
    has_game: true,
    // The measured offset (Shufflepolo server time minus ours), not raw
    // server_now - a consumer several hops downstream (this process's own
    // POST to the Node server, then that server's own socket broadcast)
    // would otherwise be computing "now minus server_now" against a
    // server_now that's already stale by however long those extra hops
    // took, silently re-introducing the exact per-hop timing error this
    // was meant to eliminate. offset_ms is measured ONCE, right here,
    // close to the actual HTTP round trip, and carried through as a
    // precomputed number the rest of the pipeline only ever adds.
    clock_offset_ms: bestClockOffsetMs,
    team1: { name: live.team1.name, score: live.team1.score },
    team2: { name: live.team2.name, score: live.team2.score },
    clock: live.clock,
    // Raw per-event lists (cumulative for the game, keyed by `id`) - passed
    // through as-is so server.js can diff them against the previous push
    // and derive kill-feed entries (goal scorer, penalty severity/player).
    // team_id tags each event; server.js maps that to home/away itself.
    team1_id: live.team1.team_id,
    team2_id: live.team2.team_id,
    goals: live.goals || [],
    penalties: live.penalties || [],
    timeouts: live.timeouts || [],
  };
}

function roundLabel(game) {
  if (game.phase && game.phase.type) {
    const labels = {
      winners: 'Winners',
      losers: 'Losers',
      consolation: game.phase.loss_tier === 1 ? '1 Loss' : `${game.phase.loss_tier} Losses`,
      final: 'Grand Final',
      final_reset: 'Final Reset',
      ladder: 'Finals',
      third_place: 'Third Place',
    };
    return labels[game.phase.type] || game.section || `Round ${game.round}`;
  }
  return game.section || `Round ${game.round}`;
}

// Converts the feed's flat `games` list into the app's bracket.json matchup
// shape: a flat list with `{group: label}` headers before each section's
// games, same structure challonge_sync.py / podium_sync.py already produce
// and the manual schedule editor understands. `games` already comes back in
// play order (day, start time, court) per the feed contract.
function buildAppBracketMatchups(games) {
  const out = [];
  let currentGroup = null;
  for (const game of games) {
    const label = roundLabel(game);
    if (label !== currentGroup) {
      out.push({ group: label });
      currentGroup = label;
    }
    out.push({
      round: game.round,
      identifier: game.id,
      left: game.team1.name || 'TBD',
      right: game.team2.name || 'TBD',
      lc: DEFAULT_LEFT_COLOR,
      rc: DEFAULT_RIGHT_COLOR,
    });
  }
  return out;
}

function writeBracketState(snapshot) {
  writeState('bracket.json', {
    tournament_state: snapshot.tournament.archived ? 'archived' : 'live',
    games: snapshot.games,
    updated_at: new Date().toISOString(),
  });
  writeJsonAtomic(APP_BRACKET_FILE, {
    matchups: buildAppBracketMatchups(snapshot.games),
    source: 'shufflepolo',
  });
}

function writeParticipants(snapshot) {
  const teams = snapshot.teams || [];
  writeState('participants.json', teams.map((t) => ({ id: t.id, name: t.name, seed: t.seed })));
}

// --------------------------------------------------------- throttled reads

let lastReadAt = 0;
let reading = false;
let readAgain = false;
let trailingTimer = null;

function requestRead() {
  if (reading) {
    readAgain = true;
    return;
  }
  const wait = lastReadAt + MIN_READ_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    void read();
  } else if (!trailingTimer) {
    trailingTimer = setTimeout(read, wait);
  }
}

async function read() {
  clearTimeout(trailingTimer);
  trailingTimer = null;
  reading = true;
  lastReadAt = Date.now();
  try {
    const t0 = Date.now();
    const response = await fetch(snapshotUrl);
    const body = await response.json();
    const t1 = Date.now();
    if (!response.ok) {
      // 404 while connected means the tournament was unpublished; keep the
      // last good state on screen and keep listening.
      log(`snapshot ${response.status} ${body.error || ''}`);
      writeStatusError(`HTTP ${response.status}: ${body.error || 'unknown'}`);
    } else {
      updateClockOffset(body.server_now, t0, t1);
      writeParticipants(body);
      writeBracketState(body);
      await pushJson(PUSH_URL, buildLiveSnapshot(body));
      writeStatus('live', { connected: true });
      log(`snapshot: ${body.live.length} live, ${body.up_next.length} up next`);
      ensureSubscribed(body.realtime);
    }
  } catch (error) {
    log('snapshot failed:', error.message);
    writeStatusError(error.message);
  }
  reading = false;

  if (connectedTo === null) {
    setTimeout(requestRead, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  } else if (readAgain) {
    readAgain = false;
    requestRead();
  }
}

// -------------------------------------------------------------- the socket

let client = null;
let channel = null;
let connectedTo = null;
let backoffMs = BACKOFF_START_MS;
let reconnectTimer = null;

function ensureSubscribed(realtime) {
  const key = `${realtime.url}|${realtime.api_key}|${realtime.topic}`;
  if (connectedTo === key) return;
  connectedTo = key;
  connect(realtime);
}

async function connect(realtime) {
  clearTimeout(reconnectTimer);
  if (client) await client.removeAllChannels();

  client = createClient(realtime.url, realtime.api_key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  channel = client.channel(realtime.topic, { config: { private: true } });

  // Every message is only a signal: never parse it, just re-read.
  channel.on('broadcast', { event: '*' }, () => requestRead());

  const thisChannel = channel;
  channel.subscribe((status, error) => {
    if (thisChannel !== channel) return;
    if (status === 'SUBSCRIBED') {
      log('subscribed', realtime.topic);
      backoffMs = BACKOFF_START_MS;
      requestRead();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      log(`channel ${status}${error ? `: ${error.message}` : ''}; retrying in ${backoffMs / 1000}s`);
      channel = null;
      void client.removeAllChannels();
      reconnectTimer = setTimeout(() => connect(realtime), backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  });
}

// ------------------------------------------------------------------- start

writeStatus('connecting', { connected: false });
setInterval(requestRead, SAFETY_POLL_MS);
requestRead();

function shutdown() {
  writeStatus('stopped', { connected: false });
  channel = null;
  if (client) client.removeAllChannels().finally(() => process.exit(0));
  else process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
