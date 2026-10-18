#!/usr/bin/env node
// Long-running Shufflepolo scoreboard-feed sync for scorebored.
//
// Follows Shufflepolo's feed contract (docs/scoreboard-feed.md in their repo)
// and is derived from their reference client (scripts/scoreboard-feed-client.mjs)
// and from the corrected copy of this script they wrote for us
// (docs/scorebored/shufflepolo_sync.js in their repo). The rules that matter:
//
//   - Realtime is the update path. Every goal, penalty, timeout and clock
//     change sends a message on one of the snapshot's `realtime.topics`; a
//     penalty reaches ONLY `feed:<id>`, so every topic is joined, on one socket.
//   - Every read sends If-None-Match; a 304 means nothing changed and nothing
//     is written or pushed. Re-reads are throttled to one per 2 seconds.
//   - One extra read at each live clock's `live_until` (full time, or a pause
//     turning into a suspension) - the one change that sends no message.
//   - A safety poll at most once per 5 minutes, for a socket that died
//     silently and the few changes that send no message.
//
// On every snapshot that actually changed (a 200), this process:
//
//   1. POSTs the followed court's current game (SHUFFLEPOLO_COURT) to the
//      scorebored server (POST /api/sync/shufflepolo/push): game id, status,
//      teams, score, clock, and the game's cumulative penalty/timeout lists.
//      server.js owns the left/right <-> team1/team2 mapping (it respects the
//      operator's sidesSwapped toggle).
//   2. Writes state files the control panel reads over REST, only when their
//      content changed:
//        state/status.json        - {state, connected, last_poll_at, last_error}
//        state/participants.json  - full roster [{id, name, seed}]
//        state/bracket.json       - current bracket, for the bracket viewer
//   3. Overwrites the app's top-level bracket.json (the schedule Next/Prev
//      Game walks) from the tournament's games list, same as the other syncs.
//
// Manual resync: write a line "resync" to this process's stdin (server.js does
// this for POST /api/sync/shufflepolo/resync). The next read skips the ETag,
// so it is a full 200 that is pushed even if nothing changed.
//
// Read-only against Shufflepolo: GETs the snapshot and listens on the socket.
//
// Usage:
//   SHUFFLEPOLO_TOURNAMENT=<uuid> [SHUFFLEPOLO_COURT=1] [SHUFFLEPOLO_FEED_URL=...] \
//     PUSH_URL=http://localhost:3000/api/sync/shufflepolo/push \
//     node shufflepolo_sync.js

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TOURNAMENT = process.env.SHUFFLEPOLO_TOURNAMENT;
const pageBracket = require('./page_bracket');

const FEED_URL = process.env.SHUFFLEPOLO_FEED_URL || 'https://xavxyvnrtqccnyonlfeu.supabase.co/functions/v1/scoreboard-feed';
const PUSH_URL = process.env.PUSH_URL || 'http://localhost:3000/api/sync/shufflepolo/push';
const COURT = Number(process.env.SHUFFLEPOLO_COURT || 1);

if (!TOURNAMENT || !Number.isInteger(COURT) || COURT < 1) {
  console.error('usage: SHUFFLEPOLO_TOURNAMENT=<uuid> [SHUFFLEPOLO_COURT=<number>] node shufflepolo_sync.js');
  process.exit(2);
}

// The feed contract's numbers ("Usage rules"). Don't lower them.
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
const PAGE_URL = `https://shufflepolo.com/t/${TOURNAMENT}`;
const PAGE_INTERVAL_MS = Number(process.env.SHUFFLEPOLO_PAGE_INTERVAL_MS) || 120000;

const log = (...parts) => console.error(`[${new Date().toISOString()}]`, ...parts);

fs.mkdirSync(STATE_DIR, { recursive: true });

// ------------------------------------------------------------------ state files

// Each file is rewritten only when its content changed - the Pi's root is an
// SD card, and a status write per read would otherwise be a write per poll.
const lastWritten = new Map();

function writeJsonIfChanged(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const digest = crypto.createHash('sha1').update(json).digest('hex');
  if (lastWritten.get(filePath) === digest) return false;
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, filePath); // write-then-rename, so a reader never sees half a file
  lastWritten.set(filePath, digest);
  return true;
}

function writeState(filename, data) {
  return writeJsonIfChanged(path.join(STATE_DIR, filename), data);
}

// status.json's last_poll_at is deliberately coarse (whole minutes) so a
// healthy, unchanging tournament doesn't rewrite the file on every read, while
// server.js's staleness watchdog can still tell a hung process from a quiet one.
function writeStatus(state, extra = {}) {
  const minute = new Date();
  minute.setSeconds(0, 0);
  writeState('status.json', { state, last_poll_at: minute.toISOString(), last_error: null, ...extra });
}

function writeStatusError(error) {
  writeState('status.json', { state: 'error', last_poll_at: new Date().toISOString(), last_error: error });
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
      res.on('end', () => (res.statusCode < 300 ? resolve() : reject(new Error(`push HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('push timed out')));
    req.end(body);
  });
}

// ------------------------------------------------------------- clock sync

// One sample per 200. A round trip puts server_now at its midpoint, wrong by at
// most half the trip, so the fastest recent trip is kept: re-measuring on every
// read would move the clock on screen by each read's latency. A held sample's
// error bound grows with age, so a fresh read eventually wins; and a sample
// disagreeing with the held one beyond both bounds means this machine's wall
// clock was stepped (the Pi has no battery-backed clock and NTP can correct it
// mid-game), so the new sample replaces the held one at once. Straight from
// Shufflepolo's reference client.
const DRIFT_PER_MS = 1e-4; // 100 ms of extra uncertainty per 1000 s held
const STEP_SLACK_MS = 250;
let bestSample = null;

function observeServerTime(serverNow, sentAtMs, receivedAtMs) {
  const sample = {
    offsetMs: Date.parse(serverNow) - (sentAtMs + receivedAtMs) / 2,
    uncertaintyMs: (receivedAtMs - sentAtMs) / 2,
    atMs: receivedAtMs,
  };
  if (Number.isNaN(sample.offsetMs)) return;
  if (!bestSample) { bestSample = sample; return; }
  const heldUncertainty = bestSample.uncertaintyMs + (receivedAtMs - bestSample.atMs) * DRIFT_PER_MS;
  const stepped = Math.abs(sample.offsetMs - bestSample.offsetMs) > sample.uncertaintyMs + heldUncertainty + STEP_SLACK_MS;
  if (stepped) log(`clock step detected (${Math.round(sample.offsetMs - bestSample.offsetMs)} ms); re-measured`);
  if (stepped || sample.uncertaintyMs < heldUncertainty) bestSample = sample;
}

const clockOffsetMs = () => (bestSample ? Math.round(bestSample.offsetMs) : null);

// ---------------------------------------------------------- shape -> app state

// The followed court's current game. The feed picks it (the live game if there
// is one, else the next one after the last finished, else the last of the day),
// so this needs no selection logic. Games in `courts` carry no clock: a live
// game's clock comes from its entry in `live`, a suspended one's from `suspended`.
let warnedNoCourt = false;
function currentGameOnCourt(snapshot) {
  const court = (snapshot.courts || []).find((c) => c.number === COURT);
  if (!court) {
    if (!warnedNoCourt) log(`court ${COURT} is not in this tournament (it has ${(snapshot.courts || []).length})`);
    warnedNoCourt = true;
    return null;
  }
  warnedNoCourt = false;
  return court.current_game || null;
}

function clockFor(snapshot, game) {
  if (!game) return null;
  const withClock = [...(snapshot.live || []), ...(snapshot.suspended || [])].find((g) => g.id === game.id);
  return withClock ? withClock.clock : null;
}

// The push is the followed court's game as the feed describes it, plus the
// clock offset. has_game is true only while that game is live: server.js
// clears the clock and the banners otherwise. Event lists are passed through
// whole; null (not included in this read) stays null so server.js never
// mistakes it for "no events". Unknown status values are passed through:
// server.js treats anything but "live" as not live, as the contract asks.
function buildPush(snapshot) {
  const game = currentGameOnCourt(snapshot);
  if (!game) return { connected: true, has_game: false, court: COURT, game_id: null, status: null };
  const side = (t) => ({ team_id: t.team_id, name: t.name, score: t.score });
  return {
    connected: true,
    has_game: game.status === 'live',
    court: COURT,
    game_id: game.id,
    status: game.status,
    clock_offset_ms: clockOffsetMs(),
    team1: side(game.team1),
    team2: side(game.team2),
    clock: clockFor(snapshot, game),
    goals: game.goals ?? null,
    penalties: game.penalties ?? null,
    timeouts: game.timeouts ?? null,
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

// The feed's flat `games` list (already in play order) as the app's
// bracket.json matchup shape: {group} headers before each section's games.
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

// Bracket games read from the public tournament page (see page_bracket.js):
// the feed omits unplayed bracket games, the page draws the whole ladder.
let pageGames = [];        // last good parse, never replaced by an empty one
let pageGamesJson = '[]';
let pageReadAt = null;
let lastSnapshot = null;
let pageTimer = null;

async function refreshPageBracket() {
  try {
    const games = await pageBracket.readBracketGames(PAGE_URL);
    if (games.length === 0) { log('page bracket: no game cards found, keeping previous'); return; }
    pageReadAt = new Date().toISOString();
    const json = JSON.stringify(games);
    if (json !== pageGamesJson) {
      pageGames = games; pageGamesJson = json;
      log(`page bracket: ${games.length} games (${games.filter((g) => g.score1 !== null).length} scored)`);
      if (lastSnapshot) writeBracketState(lastSnapshot);
    }
  } catch (error) {
    log('page bracket failed:', error.message);
  }
}

function startPageBracket() {
  refreshPageBracket();
  pageTimer = setInterval(refreshPageBracket, PAGE_INTERVAL_MS);
}

// Bracket-phase matchups from the page: every game of the ladder in play
// order, TBD where a slot is still empty. Feed games are the source for the
// group stage only (their bracket entries exist only once played).
function buildPageMatchups() {
  const out = [];
  let currentGroup = null;
  for (const g of [...pageGames].sort((a, b) => (a.number || 0) - (b.number || 0))) {
    const label = g.bracket || 'Bracket';
    if (label !== currentGroup) { out.push({ group: label }); currentGroup = label; }
    out.push({
      round: g.round,
      identifier: g.id,
      suggested_play_order: g.number,
      time: g.time || undefined,
      left: g.team1 || 'TBD',
      right: g.team2 || 'TBD',
      lc: DEFAULT_LEFT_COLOR,
      rc: DEFAULT_RIGHT_COLOR,
    });
  }
  return out;
}

function writeBracketState(snapshot) {
  lastSnapshot = snapshot;
  // No updated_at here on purpose: it would make every write a change.
  writeState('bracket.json', {
    tournament_state: snapshot.tournament.archived ? 'archived' : 'live',
    tournament: snapshot.tournament,
    games: snapshot.games,
    page_games: pageGames,
    page_read_at: pageReadAt,
  });
  const groupGames = snapshot.games.filter((g) => g.context !== 'bracket');
  const bracketMatchups = pageGames.length
    ? buildPageMatchups()
    : buildAppBracketMatchups(snapshot.games.filter((g) => g.context === 'bracket'));
  writeJsonIfChanged(APP_BRACKET_FILE, {
    matchups: [...buildAppBracketMatchups(groupGames), ...bracketMatchups],
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
let lastEtag = null;

/** At most one read per MIN_READ_INTERVAL_MS, plus one trailing read after a burst. */
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

/** Same throttle, but the read skips the ETag so it is a full 200 that is pushed. */
function manualResync() {
  log('manual resync requested');
  lastEtag = null;
  requestRead();
}

async function read() {
  clearTimeout(trailingTimer);
  trailingTimer = null;
  reading = true;
  lastReadAt = Date.now();
  try {
    const sentAt = Date.now();
    const response = await fetch(snapshotUrl, lastEtag ? { headers: { 'If-None-Match': lastEtag } } : {});
    if (response.status === 304) {
      writeStatus('live', { connected: true });
    } else {
      const body = await response.json();
      const receivedAt = Date.now();
      if (!response.ok) {
        // 404 while connected means the tournament was unpublished; keep the
        // last good state on screen and keep listening.
        log(`snapshot ${response.status} ${body.error || ''}`);
        writeStatusError(`HTTP ${response.status}: ${body.error || 'unknown'}`);
      } else {
        observeServerTime(body.server_now, sentAt, receivedAt);
        writeParticipants(body);
        writeBracketState(body);
        const push = buildPush(body);
        await pushJson(PUSH_URL, push);
        // Only after the push landed: a failed push is retried by the next read.
        lastEtag = response.headers.get('etag');
        writeStatus('live', { connected: true });
        log(`snapshot: ${body.live.length} live, ${(body.suspended || []).length} suspended, ${body.up_next.length} up next; court ${COURT}: ${push.game_id ? `${push.team1.name} v ${push.team2.name} (${push.status})` : 'no game'}`);
        armLiveUntil(body);
        ensureSubscribed(body.realtime);
      }
    }
  } catch (error) {
    log('snapshot failed:', error.message);
    writeStatusError(error.message);
  }
  reading = false;

  if (connectedTo === null) {
    // Nothing will signal us until the first successful read: retry on the backoff.
    setTimeout(requestRead, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  } else if (readAgain) {
    readAgain = false;
    requestRead();
  }
}

// A game stops being live at its clock's live_until - full time, or a pause
// turning into a suspension - and nothing sends a message when it does, so
// read once at each, counted against the server's clock. A 304 keeps the
// timers armed from the last 200.
let liveUntilTimers = [];
function armLiveUntil(snapshot) {
  for (const timer of liveUntilTimers) clearTimeout(timer);
  liveUntilTimers = [];
  const offsetMs = clockOffsetMs() ?? 0;
  for (const game of snapshot.live) {
    if (!game.clock || !game.clock.live_until) continue;
    const due = Date.parse(game.clock.live_until) - offsetMs - Date.now();
    liveUntilTimers.push(setTimeout(requestRead, Math.max(0, due) + 500));
  }
}

// -------------------------------------------------------------- the socket

let client = null;
let generation = null; // the live set of channels; a status callback from an older set is ignored
let connectedTo = null;
let backoffMs = BACKOFF_START_MS;
let reconnectTimer = null;

// Every topic to join. `games:<id>` carries scores, clocks and games; `feed:<id>`
// carries goals, penalties and timeouts. A penalty reaches only `feed:<id>`.
const topicsOf = (realtime) => realtime.topics || [realtime.topic];

/** One socket per process. Reconnects only when the snapshot's realtime details change. */
function ensureSubscribed(realtime) {
  const key = `${realtime.url}|${realtime.api_key}|${topicsOf(realtime).join(',')}`;
  if (connectedTo === key) return;
  connectedTo = key;
  connect(realtime).catch((error) => log('connect failed:', error.message));
}

async function connect(realtime) {
  clearTimeout(reconnectTimer);
  generation = null;
  if (client) await client.removeAllChannels();

  client = createClient(realtime.url, realtime.api_key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const thisGeneration = {};
  generation = thisGeneration;
  const topics = topicsOf(realtime);
  const joined = new Set();

  for (const topic of topics) {
    const channel = client.channel(topic, { config: { private: true } });
    // Every message is only a signal: never parse it, just re-read.
    channel.on('broadcast', { event: '*' }, () => requestRead());
    channel.subscribe((status, error) => {
      if (generation !== thisGeneration) return;
      if (status === 'SUBSCRIBED') {
        log('subscribed', topic);
        joined.add(topic);
        if (joined.size === topics.length) backoffMs = BACKOFF_START_MS;
        // Messages sent while we were not listening are not replayed.
        requestRead();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        log(`channel ${topic} ${status}${error ? `: ${error.message}` : ''}; retrying in ${backoffMs / 1000}s`);
        // Drop every channel so the library's own rejoin loop stops; we own
        // the backoff, and rejoin them all together.
        generation = null;
        client.removeAllChannels().catch(() => {});
        reconnectTimer = setTimeout(() => connect(realtime).catch((e) => log('reconnect failed:', e.message)), backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    });
  }
}

// ------------------------------------------------------------------- start

writeStatus('connecting', { connected: false });
setInterval(requestRead, SAFETY_POLL_MS);
requestRead();
startPageBracket();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.split(/\r?\n/).some((line) => line.trim() === 'resync')) manualResync();
});
process.stdin.on('error', () => {});

// A crash here must be visible in the journal, and SyncManager restarts us.
process.on('unhandledRejection', (error) => {
  log('unhandled rejection:', error && error.message ? error.message : error);
  process.exit(1);
});

function shutdown() {
  if (pageTimer) clearInterval(pageTimer);
  writeState('status.json', { state: 'stopped', last_poll_at: new Date().toISOString(), last_error: null, connected: false });
  generation = null;
  if (client) client.removeAllChannels().finally(() => process.exit(0));
  else process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
