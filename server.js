const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { exec } = require('child_process');
const { SyncManager } = require('./lib/sync');
const { startSpeedifyStats, registerSpeedifySocketHandlers } = require('./lib/speedify');
const { registerRtmpSocketHandlers } = require('./lib/rtmp');
const { registerSrtSocketHandlers } = require('./lib/srt');
const { registerRelayRoutes } = require('./lib/relay');
const { createAtemControl } = require('./lib/atem');
const { registerNetworkSocketHandlers } = require('./lib/network');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'gamestate.json');
const BRACKET_FILE = path.join(__dirname, 'bracket.json');
const PRESETS_DIR = path.join(__dirname, 'presets');
const LOGOS_DIR = path.join(__dirname, 'public', 'logos');
const OVERLAYS_DIR = path.join(__dirname, 'overlays');
// An overlay JSON with `locked: true` is a default that ships with the repo
// (overlays/overlay_daca270d.json, the Scorebug): every editor-driven
// mutation route answers 423 for it, so the only way to change it is to
// edit the file itself (then POST /api/display/reload).

// ATEM Configuration
const ATEM_IP = process.env.ATEM_IP || '10.42.0.100'; // Default ATEM IP
const GRAPHICS_INPUT = parseInt(process.env.GRAPHICS_INPUT || '1'); // Input number for graphics/scoreboard
const DOWNSTREAM_KEY = parseInt(process.env.DOWNSTREAM_KEY || '1'); // Which downstream key to control

// Default game state
const defaultGameState = {
  leftTeam: 'Team 1',
  rightTeam: 'Team 2',
  leftScore: 0,
  rightScore: 0,
  leftColor: '#292929',
  rightColor: '#ebebeb',
  leftScoreTextColor: '#ffffff',
  rightScoreTextColor: '#212121',
  sidesSwapped: false,
  textColor: '#ffffff',
  backgroundColor: '#808080',
  clock: null,
  penalties: null,
  timeouts: null,
  activeTimeout: null,
  status: null,
  has_game: false,
  // Which provider game the live fields describe (Shufflepolo's game id;
  // null for Podium/manual). Lets a display tell "new game" from "same game".
  gameId: null,
  // The current game's penalties, {gameId, items: [{id, side, player,
  // severity}]} or null. Displays announce an id they have not shown yet;
  // see overlay-bind.js. Not a log: it is whatever the provider reports now.
  penaltyLog: null,
  // What /display currently renders: either a preset (the legacy
  // element-based canvas system, kept working for existing presets but no
  // longer editable - /editor is retired) or an overlay (pasted HTML/CSS,
  // authored in /overlay-editor). null activeId falls back to /display's
  // built-in minimal layout, same as before this was generalized beyond
  // presets alone.
  activeKind: null, // 'preset' | 'overlay' | null
  activeId: null,
  // Shows/hides display.html's on-screen diagnostic panel (socket status,
  // render count, active item) remotely from /control - off by default
  // since it's plain readable text sitting over the live HDMI output, not
  // something to leave on for a real broadcast. See setDebugOverlay.
  debugOverlay: false,
  // Takes the scorebug (preset or overlay) off /display entirely, leaving
  // the stage black so the ATEM's luma key shows clean program. The
  // active item is kept, so showing it again is one click with no
  // re-pick. From the Scorebug panel on /control and /dashboard; see
  // setScorebugHidden.
  scorebugHidden: false,
  ladder: { active: false, tournament: null }, // bracket ladder layer on /display (setLadder); tournament uuid or null = the sync's
  commercialBreak: {
    active: false,
    videoPath: '',
    startTime: null
  },
  barsActive: false,
  barsAudioSnapshot: [],
  atemStatus: {
    connected: false,
    ip: ATEM_IP,
    currentInput: 1,
    downstreamKeyEnabled: false,
    upstreamKeyEnabled: false
  },
  loadedMatchupIndex: null
};

// Load saved state or use default
let gameState = loadGameState();

// Identifies this process instance, fresh on every boot (never persisted
// meaningfully - loadGameState may read a stale one back from disk, but
// it's immediately overwritten here). Rides along on every gameUpdate push
// since it's just a field on the one persistent gameState object. Lets a
// client (the kiosk display, in particular) tell "the server restarted"
// apart from "my socket reconnected after a network blip" - see
// display.html's reloadIfServerRestarted().
gameState._serverInstanceId = crypto.randomUUID();

function loadGameState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const saved = JSON.parse(data);
      // Retired fields from the kill-feed era; a saved state may still carry them.
      for (const key of ['feed', '_rawEvents', '_lastGoal']) delete saved[key];
      console.log('Loaded saved game state:', saved);
      return { ...defaultGameState, ...saved };
    }
  } catch (error) {
    console.error('Error loading game state:', error);
  }
  console.log('Using default game state');
  return { ...defaultGameState };
}

function saveGameState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(gameState, null, 2));
    console.log('Game state saved');
  } catch (error) {
    console.error('Error saving game state:', error);
  }
}

// Every mutation site goes through this rather than calling saveGameState()/
// io.emit() directly. The state is saved and broadcast only when it actually
// changed: a sync push carrying the same game, score, clock and events as the
// last one costs nothing downstream - no SD-card write, no socket broadcast
// to every display. The comparison is the serialized state, so a mutation
// that changes nothing (the common case for a re-read) is a no-op.
let lastCommittedJson = null;
function commitGameState(mutate) {
  mutate();
  const json = JSON.stringify(gameState);
  if (json === lastCommittedJson) return false;
  lastCommittedJson = json;
  saveGameState();
  io.emit('gameUpdate', gameState);
  return true;
}

function getAvailableVideos() {
  const videosDir = path.join(__dirname, 'public', 'videos');
  try {
    if (!fs.existsSync(videosDir)) {
      return [];
    }
    const files = fs.readdirSync(videosDir);
    return files
      .filter(file => file.toLowerCase().endsWith('.mp4'))
      .map(file => ({
        filename: file,
        path: `/videos/${file}`,
        name: file.replace('.mp4', '').replace(/[-_]/g, ' ')
      }));
  } catch (error) {
    console.error('Error reading videos directory:', error);
    return [];
  }
}

const atemControl = createAtemControl({
  io,
  gameState,
  saveGameState,
  atemIp: ATEM_IP,
  graphicsInput: GRAPHICS_INPUT,
  downstreamKey: DOWNSTREAM_KEY,
});
const {
  connectToAtem,
  switchToGraphicsInput,
  switchToPreviousInput,
  setDownstreamKey,
  fadeDownstreamKey,
} = atemControl;

// ── Tournament-sync integrations ──
// Three standalone, toggleable, read-only-against-the-platform providers
// (Challonge, Podium, Shufflepolo), unified behind lib/sync.js's SyncManager
// for the parts that are identical across all three: subprocess lifecycle,
// config load/save, state-file reads. What varies per provider (config
// fields, env vars, how a live push gets applied to gameState) is defined
// here, next to each provider's REST/socket wiring below.

const syncProviders = {};

syncProviders.challonge = new SyncManager({
  name: 'challonge',
  dir: path.join(__dirname, 'challonge'),
  script: path.join(__dirname, 'challonge', 'challonge_sync.py'),
  command: 'python3',
  configFile: path.join(__dirname, 'challonge-config.json'),
  configDefaults: { apiKey: '', tourney: '', enabled: false },
  requiredFields: ['apiKey', 'tourney'],
  stateDir: path.join(__dirname, 'challonge', 'state'),
  buildEnv: (config) => ({
    CHALLONGE_API_KEY: config.apiKey,
    CHALLONGE_TOURNEY: config.tourney,
  }),
  maskConfig: (config) => ({
    apiKey: config.apiKey ? '••••••••' : '',
    tourney: config.tourney,
    enabled: config.enabled,
  }),
});

syncProviders.podium = new SyncManager({
  name: 'podium',
  dir: path.join(__dirname, 'podium_sync'),
  script: path.join(__dirname, 'podium_sync', 'podium_sync.py'),
  command: 'python3',
  configFile: path.join(__dirname, 'podium-config.json'),
  configDefaults: { apiKey: '', tournament: '', court: '', enabled: false },
  requiredFields: ['apiKey', 'tournament', 'court'],
  stateDir: path.join(__dirname, 'podium_sync', 'state'),
  buildEnv: (config) => ({
    PODIUM_API_KEY: config.apiKey,
    PODIUM_TOURNAMENT: config.tournament,
    PODIUM_COURT: config.court,
    PUSH_URL: `http://localhost:${PORT}/api/sync/podium/push`,
  }),
  maskConfig: (config) => ({
    apiKey: config.apiKey ? '••••••••' : '',
    tournament: config.tournament,
    court: config.court,
    enabled: config.enabled,
  }),
});
// Podium pushes live game state (score/clock/penalties) rather than being
// polled, unlike Challonge. On process exit, clear the live fields it owns
// rather than leaving a stale clock/penalties on screen.
syncProviders.podium.onExit = () => {
  commitGameState(() => {
    gameState.clock = null;
    gameState.penalties = null;
    gameState.timeouts = null;
    gameState.activeTimeout = null;
    gameState.status = null;
  });
};

syncProviders.shufflepolo = new SyncManager({
  name: 'shufflepolo',
  dir: path.join(__dirname, 'shufflepolo_sync'),
  script: path.join(__dirname, 'shufflepolo_sync', 'shufflepolo_sync.js'),
  command: 'node',
  configFile: path.join(__dirname, 'shufflepolo-config.json'),
  configDefaults: { tournamentId: '', court: '1', feedUrl: '', enabled: false },
  requiredFields: ['tournamentId'],
  stateDir: path.join(__dirname, 'shufflepolo_sync', 'state'),
  // The sync writes status.json on every read, including the 5-minute safety
  // poll; a status older than this means the process is hung, not quiet.
  staleAfterMs: 15 * 60_000,
  // Accepts a pasted tournament page URL (https://shufflepolo.com/t/<uuid>)
  // as well as a bare UUID, since that's the only place the UUID is visible
  // to the operator (Shufflepolo's feed has no list/lookup endpoint).
  normalizeField: (key, value) => {
    if (key !== 'tournamentId') return value;
    const match = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : value;
  },
  buildEnv: (config) => ({
    SHUFFLEPOLO_TOURNAMENT: config.tournamentId,
    SHUFFLEPOLO_COURT: String(config.court || 1),
    ...(config.feedUrl ? { SHUFFLEPOLO_FEED_URL: config.feedUrl } : {}),
    PUSH_URL: `http://localhost:${PORT}/api/sync/shufflepolo/push`,
  }),
  // No API key - the feed is public/anonymous, nothing to mask.
  maskConfig: (config) => ({
    tournamentId: config.tournamentId,
    court: config.court,
    feedUrl: config.feedUrl,
    enabled: config.enabled,
  }),
});
syncProviders.shufflepolo.onExit = () => {
  commitGameState(() => applyShufflepoloSnapshot({ has_game: false, game_id: gameState.gameId }));
};

// One-off read-only lookup of all tournaments visible to an API key, so the
// bracket page UI can offer a picker instead of requiring a hand-typed slug.
// Challonge-specific - no generic equivalent for the other providers.
function listChallongeTournaments(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.challonge.com/v2.1/tournaments.json', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/json',
        'Authorization-Type': 'v1',
        'Authorization': apiKey,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) challonge-scoreboard-script/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Challonge API returned HTTP ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(body);
          const tournaments = parsed.data.map(t => ({
            id: t.id,
            slug: t.attributes.url,
            name: t.attributes.name,
            state: t.attributes.state,
            tournament_type: t.attributes.tournament_type,
          }));
          resolve(tournaments);
        } catch (e) {
          reject(new Error('Failed to parse Challonge response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Challonge API request timed out')));
    req.end();
  });
}

// Applies a live snapshot from podium_sync.py to gameState, honoring
// whatever sidesSwapped is currently set to — same left/right mapping
// loadMatchupByIndex uses, so the director's swap control stays authoritative
// regardless of which physical side Podium calls "home".
function applyPodiumSnapshot(snapshot) {
  gameState.gameId = null;
  gameState.clock = snapshot.clock || null;
  gameState.status = snapshot.has_game ? snapshot.status : null;

  if (!snapshot.has_game) {
    gameState.penalties = null;
    gameState.timeouts = null;
    gameState.activeTimeout = null;
    gameState.penaltyLog = null;
    return;
  }

  const homePenalties = (snapshot.penalties && snapshot.penalties.home) || [];
  const awayPenalties = (snapshot.penalties && snapshot.penalties.away) || [];
  const homeTimeouts = snapshot.home.timeouts_left;
  const awayTimeouts = snapshot.away.timeouts_left;
  // podium_sync.py's active_timeout.side is "home"/"away", same vocabulary
  // as penalties - mapped the same sidesSwapped-respecting way below.
  const at = snapshot.active_timeout;
  const homeSide = gameState.sidesSwapped ? 'right' : 'left';
  const awaySide = gameState.sidesSwapped ? 'left' : 'right';

  if (gameState.sidesSwapped) {
    gameState.leftTeam = snapshot.away.name;
    gameState.rightTeam = snapshot.home.name;
    gameState.leftScore = snapshot.away.score;
    gameState.rightScore = snapshot.home.score;
    gameState.penalties = { left: awayPenalties, right: homePenalties };
    gameState.timeouts = { left: awayTimeouts, right: homeTimeouts };
  } else {
    gameState.leftTeam = snapshot.home.name;
    gameState.rightTeam = snapshot.away.name;
    gameState.leftScore = snapshot.home.score;
    gameState.rightScore = snapshot.away.score;
    gameState.penalties = { left: homePenalties, right: awayPenalties };
    gameState.timeouts = { left: homeTimeouts, right: awayTimeouts };
  }
  gameState.activeTimeout = at ? { side: at.side === 'home' ? homeSide : awaySide, remainingSeconds: at.remaining_seconds } : null;
  // Podium reports the penalties active right now, each with a stable id -
  // enough for a display to announce the ones it has not shown yet.
  const toLog = (list, side) => list.filter(p => p.id != null).map(p => ({ id: p.id, side, player: p.player || null, severity: p.severity || null }));
  gameState.penaltyLog = { gameId: null, items: [...toLog(homePenalties, homeSide), ...toLog(awayPenalties, awaySide)] };
}

// Shufflepolo's penalty `code` -> the severity vocabulary shared with
// Podium (which reports this as `severity` directly). See
// shufflepolo_sync/state/bracket.json for confirmed real-world codes.
const SHUFFLEPOLO_PENALTY_CODE = {
  bt: 'turnover',
  mi: 'minor',
  ma: 'major',
  pm: 'ejection',
};

// Applies a push from shufflepolo_sync.js: the followed court's current game
// as Shufflepolo's feed describes it (see buildPush there). Shufflepolo
// reports team1/team2 (not home/away like Podium), but the same
// sidesSwapped-respecting mapping applies. has_game is true only while that
// game is live; otherwise the last names and score stay on screen and every
// time-bound field (clock, penalties, timeouts, banners) is cleared.
function applyShufflepoloSnapshot(snapshot) {
  const live = !!snapshot.has_game;
  gameState.gameId = snapshot.game_id || null;
  gameState.has_game = live;
  gameState.status = live ? 'in_progress' : null;
  // clock_offset_ms (Shufflepolo's clock minus this machine's, measured by
  // shufflepolo_sync.js at the real HTTP round trip) rides along on the clock
  // object so display code that spreads the clock carries it for free - see
  // computeClockDisplay in scorebug-render.js. Nothing downstream re-derives it.
  gameState.clock = live && snapshot.clock ? { ...snapshot.clock, clock_offset_ms: snapshot.clock_offset_ms ?? null } : null;

  if (!live) {
    gameState.penalties = null;
    gameState.timeouts = null;
    gameState.activeTimeout = null;
    gameState.penaltyLog = null;
    return;
  }

  const [leftTeam, rightTeam] = gameState.sidesSwapped ? [snapshot.team2, snapshot.team1] : [snapshot.team1, snapshot.team2];
  gameState.leftTeam = leftTeam.name;
  gameState.rightTeam = rightTeam.name;
  gameState.leftScore = leftTeam.score ?? 0;
  gameState.rightScore = rightTeam.score ?? 0;
  const sideFor = (teamId) => (teamId === leftTeam.team_id ? 'left' : 'right');

  // Per the feed contract, an event list is null when this read did not
  // include it ("not included", never "none"): keep what we had in that case.
  if (Array.isArray(snapshot.penalties)) {
    const penalties = snapshot.penalties.map(p => ({
      id: p.id,
      side: sideFor(p.team_id),
      player: p.player ? p.player.name : null,
      severity: SHUFFLEPOLO_PENALTY_CODE[p.code] || p.code,
    }));
    gameState.penalties = { left: penalties.filter(p => p.side === 'left'), right: penalties.filter(p => p.side === 'right') };
    gameState.penaltyLog = { gameId: gameState.gameId, items: penalties };
  }
  if (Array.isArray(snapshot.timeouts)) {
    const timeouts = snapshot.timeouts.map(t => ({ id: t.id, side: sideFor(t.team_id), at: t.at }));
    const used = (side) => timeouts.filter(t => t.side === side).length;
    gameState.timeouts = {
      left: Math.max(0, SHUFFLEPOLO_TIMEOUTS_PER_TEAM - used('left')),
      right: Math.max(0, SHUFFLEPOLO_TIMEOUTS_PER_TEAM - used('right')),
    };
    if (gameState.clock && gameState.clock.status === 'running') {
      for (const t of timeouts) endedTimeoutIds.add(t.id);
    }
    gameState.activeTimeout = computeShufflepoloActiveTimeout(timeouts, gameState.clock);
  }
}

// Platform constants from Shufflepolo's own game console (src/lib/gameConsole.ts
// and the call_game_event database function): every tournament, not a house rule.
const SHUFFLEPOLO_TIMEOUT_SECONDS = 120;
const SHUFFLEPOLO_TIMEOUTS_PER_TEAM = 2;

// Timeouts that are over. Shufflepolo's console stops the clock when a timeout
// is called and ends the timeout when the clock is started again, so "the
// clock has run since this timeout was called" is the end signal; the feed
// carries no end time of its own. In-memory only: after a restart the 120 s
// window below already hides any timeout older than that.
const endedTimeoutIds = new Set();

function computeShufflepoloActiveTimeout(timeouts, clock) {
  if (!timeouts.length || !clock || clock.status === 'running') return null;
  const newest = timeouts[timeouts.length - 1];
  if (!newest.at || endedTimeoutIds.has(newest.id)) return null;
  // `at` is on Shufflepolo's clock; compare on that clock too, since this
  // machine's wall clock may be off by far more than the offset (no RTC).
  const nowOnServer = Date.now() + (clock.clock_offset_ms || 0);
  const remaining = SHUFFLEPOLO_TIMEOUT_SECONDS - (nowOnServer - Date.parse(newest.at)) / 1000;
  return remaining > 0 ? { side: newest.side, remainingSeconds: Math.ceil(remaining) } : null;
}

for (const manager of Object.values(syncProviders)) {
  manager.loadConfig();
  if (manager.config.enabled) manager.start();
}

app.use(express.static('public'));

// The dashboard is the landing page. A redirect (302) rather than a
// sendFile so the address bar shows the real route; the kiosk's wait loop
// (`curl -sf http://localhost:3000/`, launch-display.sh) still passes
// because -f only fails on 4xx/5xx, and Companion only uses the REST routes.
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// Retired SVG scorebug overlay, kept reachable in case the new barebones
// one needs a quick fallback during the visual redesign.
app.get('/display-legacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display-legacy.html'));
});

app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

// /editor (the element-based shape/text canvas) is retired - overlay-editor
// is the only scorebug authoring page now. /editor itself 404s like any
// other removed route; existing presets still render on /display (and are
// still selectable as "active") via the preset API routes further down,
// which are kept for backward compatibility, just with no page left to
// edit them from.
app.get('/overlay-editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay-editor.html'));
});

// Pi relay pages (/relay, /profiles): MediaMTX forward target and stream-key profiles. lib/relay.js.
registerRelayRoutes(app);

app.get('/network', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'network.html'));
});

app.get('/apchannel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'apchannel.html'));
});

// Bracket ladder for any pasted shufflepolo.com tournament link, independent
// of the tournament the sync follows. Renders the public page headless (see
// shufflepolo_sync/page_bracket.js), cached per tournament for LADDER_TTL_MS;
// concurrent requests for the same tournament share one render. Only
// shufflepolo.com/t/<uuid> is ever rendered.
const pageBracket = require('./shufflepolo_sync/page_bracket');
const LADDER_TTL_MS = 120000;
const ladderCache = new Map(); // tournament id -> { at, data, pending }
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// "Next up" card: live[] / up_next[] from the scoreboard feed (same endpoint
// the sync polls), cached briefly so the ladder's 30 s reload stays cheap.
const LADDER_FEED_URL = process.env.SHUFFLEPOLO_FEED_URL || 'https://xavxyvnrtqccnyonlfeu.supabase.co/functions/v1/scoreboard-feed';
const LADDER_FEED_TTL_MS = 15000;
const ladderFeedCache = new Map(); // tournament id -> { at, data }
async function ladderFeed(id) {
  const c = ladderFeedCache.get(id);
  if (c && Date.now() - c.at < LADDER_FEED_TTL_MS) return c.data;
  try {
    const r = await fetch(`${LADDER_FEED_URL}?tournament=${id}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
    const b = await r.json();
    const data = { live: b.live || [], suspended: b.suspended || [], up_next: b.up_next || [], time_zone: b.tournament && b.tournament.time_zone, server_now: b.server_now };
    ladderFeedCache.set(id, { at: Date.now(), data });
    return data;
  } catch (e) {
    return c ? c.data : { live: [], suspended: [], up_next: [], feed_error: e.message };
  }
}

app.get('/api/ladder', async (req, res) => {
  const m = UUID_RE.exec(String(req.query.t || ''));
  if (!m) return res.status(400).json({ error: 'pass a shufflepolo.com/t/<uuid> link or the uuid as ?t=' });
  const id = m[0].toLowerCase();
  const url = `https://shufflepolo.com/t/${id}`;
  const entry = ladderCache.get(id);
  const now = Date.now();
  const feed = await ladderFeed(id);
  const send = (data) => res.json({ ...data, ...feed });
  if (entry && entry.data && now - entry.at < LADDER_TTL_MS) return send(entry.data);
  if (entry && entry.pending) return entry.pending.then(send, (e) => res.status(502).json({ error: e.message }));
  const pending = pageBracket.readBracketPage(url).then((page) => {
    const data = {
      tournament: { id, name: page.title, url },
      page_games: page.games,
      teams: page.teams,
      page_read_at: new Date().toISOString(),
    };
    // keep the previous games if this render came back empty (page glitch)
    if (page.games.length === 0 && entry && entry.data && entry.data.page_games.length) data.page_games = entry.data.page_games;
    ladderCache.set(id, { at: Date.now(), data, pending: null });
    return data;
  }).catch((e) => { ladderCache.set(id, { at: 0, data: entry && entry.data, pending: null }); throw e; });
  ladderCache.set(id, { at: entry ? entry.at : 0, data: entry && entry.data, pending });
  pending.then(send, (e) => res.status(502).json({ error: e.message }));
});

app.get('/ladder', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bracket-ladder.html'));
});

app.get('/bracket', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bracket.html'));
});

app.get('/teams', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teams.html'));
});

// Placeholder data viewers, one per sync provider — see
// public/sync-data-viewer.html's own note on why this isn't one unified
// bracket renderer (the three providers' bracket.json shapes don't match).
app.get('/bracket-viewer/:provider', (req, res) => {
  if (!syncProviders[req.params.provider]) return res.status(404).send('Unknown sync provider');
  res.sendFile(path.join(__dirname, 'public', 'sync-data-viewer.html'));
});

// ── Generic tournament-sync REST routes ──
// One shape for all three providers (challonge/podium/shufflepolo). Provider-
// specific extras that don't fit (e.g. Challonge's tournament listing) stay
// as additive routes layered on top instead of forcing everything in here.

function getSyncProvider(req, res) {
  const manager = syncProviders[req.params.provider];
  if (!manager) {
    res.status(404).json({ error: `Unknown sync provider "${req.params.provider}"` });
    return null;
  }
  return manager;
}

app.get('/api/sync/:provider/config', (req, res) => {
  const manager = getSyncProvider(req, res);
  if (!manager) return;
  res.json(manager.maskedConfig());
});

app.get('/api/sync/:provider/status', (req, res) => {
  const manager = getSyncProvider(req, res);
  if (!manager) return;
  res.json(manager.readStateFile('status.json') || { state: manager.config.enabled ? 'starting' : 'off', connected: false, last_poll_at: null, last_event_at: null, last_error: null });
});

app.get('/api/sync/:provider/participants', (req, res) => {
  const manager = getSyncProvider(req, res);
  if (!manager) return;
  const data = manager.readStateFile('participants.json');
  if (!data) return res.status(404).json({ error: `No ${req.params.provider} participant data yet` });
  res.json(data);
});

app.get('/api/sync/:provider/bracket', (req, res) => {
  const manager = getSyncProvider(req, res);
  if (!manager) return;
  const data = manager.readStateFile('bracket.json');
  if (!data) return res.status(404).json({ error: `No ${req.params.provider} bracket data yet` });
  res.json(data);
});

// podium_sync.py / shufflepolo_sync.js post here on every live event. No
// auth beyond binding to localhost — this is a same-host IPC channel, not a
// public API. Challonge has no push route - it's polled, not pushed to.
const SYNC_PUSH_HANDLERS = {
  podium: applyPodiumSnapshot,
  shufflepolo: applyShufflepoloSnapshot,
};

app.post('/api/sync/:provider/push', express.json(), (req, res) => {
  const applySnapshot = SYNC_PUSH_HANDLERS[req.params.provider];
  if (!applySnapshot) {
    return res.status(404).json({ error: `"${req.params.provider}" does not accept pushes` });
  }
  try {
    commitGameState(() => applySnapshot(req.body));
    res.json({ ok: true });
  } catch (error) {
    console.error(`Error applying ${req.params.provider} push:`, error);
    res.status(400).json({ error: error.message });
  }
});

// Asks a running sync subprocess for a full re-read and push, even if nothing
// changed on the platform - recovers a display that dropped an update locally.
app.post('/api/sync/:provider/resync', (req, res) => {
  const manager = syncProviders[req.params.provider];
  if (!manager) return res.status(404).json({ error: `Unknown provider "${req.params.provider}"` });
  res.json({ ok: manager.resync() });
});

// Same as the socket's reloadDisplay, over HTTP (curl-able from a shell).
app.post('/api/display/reload', (req, res) => {
  io.emit('reloadDisplay');
  res.json({ ok: true });
});

// Same as the socket's toggleSync, over HTTP - for scripts such as
// simulate-game-states.js that need the server (not themselves) to stop and
// later restart a provider's supervised child.
app.post('/api/sync/:provider/toggle', express.json(), (req, res) => {
  const manager = syncProviders[req.params.provider];
  if (!manager) return res.status(404).json({ error: `Unknown provider "${req.params.provider}"` });
  manager.toggle(!!req.body.enabled);
  res.json({ ok: true, enabled: manager.config.enabled, running: manager.isRunning() });
});

app.get('/api/bracket', (req, res) => {
  try {
    if (fs.existsSync(BRACKET_FILE)) {
      const data = fs.readFileSync(BRACKET_FILE, 'utf8');
      res.json(JSON.parse(data));
    } else {
      res.status(404).json({ error: 'No saved bracket' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bracket', express.json(), (req, res) => {
  try {
    fs.writeFileSync(BRACKET_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/videos', (req, res) => {
  const videos = getAvailableVideos();
  res.json(videos);
});

// ── Scorebug presets ──
// One JSON file per preset in presets/, named <id>.json. A directory rather
// than a single array file (like bracket.json) so concurrent saves/deletes
// never need a read-modify-write of a shared array, and delete is a plain
// unlink.
//
// Each preset holds its own version history (preset.versions[], 1-indexed
// by `version`) rather than being a single mutable document. Saving in the
// editor always APPENDS a new version - it never overwrites one - so a
// draft never clobbers what's actually on air. preset.activeVersion is
// which version this preset currently points to when IT is the live
// preset (gameState.activePresetId); switching the live preset or rolling
// back to an older version both just update this field via
// PUT /api/presets/:id/active-version, same instant-cut broadcast
// semantics as everything else in gameState.

function presetPath(id) {
  return path.join(PRESETS_DIR, `${id}.json`);
}

function isValidPresetId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
}

function nextUnnamedPresetName() {
  const files = fs.existsSync(PRESETS_DIR) ? fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')) : [];
  let highest = 0;
  for (const f of files) {
    try {
      const preset = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
      const m = /^Unnamed-Preset_(\d+)$/.exec(preset.name || '');
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    } catch (e) { /* skip unreadable files */ }
  }
  return 'Unnamed-Preset_' + String(highest + 1).padStart(2, '0');
}

function activeVersionOf(preset) {
  return (preset.versions || []).find(v => v.version === preset.activeVersion) || null;
}

app.get('/api/presets', (req, res) => {
  try {
    if (!fs.existsSync(PRESETS_DIR)) return res.json([]);
    const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
    const summaries = files.map(f => {
      const preset = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
      return {
        id: preset.id,
        name: preset.name,
        updatedAt: preset.updatedAt,
        versionCount: (preset.versions || []).length,
        activeVersion: preset.activeVersion,
      };
    });
    res.json(summaries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/presets/:id', (req, res) => {
  if (!isValidPresetId(req.params.id)) return res.status(400).json({ error: 'Invalid preset id' });
  try {
    const filePath = presetPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No such preset' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Creates a new preset with one version (version 1). Body carries that
// first version's {canvas, elements}; name defaults to an auto-numbered
// Unnamed-Preset_NN when not given or blank.
app.post('/api/presets', express.json(), (req, res) => {
  try {
    fs.mkdirSync(PRESETS_DIR, { recursive: true });
    const id = 'preset_' + crypto.randomBytes(4).toString('hex');
    const now = new Date().toISOString();
    const name = (req.body.name || '').trim() || nextUnnamedPresetName();
    const preset = {
      id,
      name,
      versions: [{ version: 1, canvas: req.body.canvas, elements: req.body.elements || [], createdAt: now }],
      activeVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(presetPath(id), JSON.stringify(preset, null, 2));
    res.json(preset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Appends a new version. Never overwrites an existing version, so this is
// always a non-destructive "save as draft" - rolling it out live is a
// separate, explicit step (PUT .../active-version).
app.post('/api/presets/:id/versions', express.json(), (req, res) => {
  if (!isValidPresetId(req.params.id)) return res.status(400).json({ error: 'Invalid preset id' });
  try {
    const filePath = presetPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No such preset' });
    const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const now = new Date().toISOString();
    const nextVersion = preset.versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
    preset.versions.push({ version: nextVersion, canvas: req.body.canvas, elements: req.body.elements || [], createdAt: now });
    if (typeof req.body.name === 'string' && req.body.name.trim()) preset.name = req.body.name.trim();
    preset.updatedAt = now;
    fs.writeFileSync(filePath, JSON.stringify(preset, null, 2));
    res.json(preset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Points this preset at a specific version - used both for "I like this
// draft, use it" right after saving, and for rolling back to any older
// version later. Does NOT by itself make the preset live on the broadcast;
// that's gameState.activePresetId (POST /api/presets/:id/versions above
// leaves that untouched), set via the existing setActivePreset socket
// event. If this preset happens to already be the live one, re-pointing
// its activeVersion here is what the live display actually re-renders
// from on its next poll/gameUpdate.
app.put('/api/presets/:id/active-version', express.json(), (req, res) => {
  if (!isValidPresetId(req.params.id)) return res.status(400).json({ error: 'Invalid preset id' });
  const version = parseInt(req.body.version, 10);
  if (!Number.isInteger(version)) return res.status(400).json({ error: 'Invalid version' });
  try {
    const filePath = presetPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No such preset' });
    const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!preset.versions.some(v => v.version === version)) return res.status(404).json({ error: 'No such version' });
    preset.activeVersion = version;
    preset.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(preset, null, 2));
    res.json(preset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/presets/:id', (req, res) => {
  if (!isValidPresetId(req.params.id)) return res.status(400).json({ error: 'Invalid preset id' });
  try {
    const filePath = presetPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No such preset' });
    fs.unlinkSync(filePath);
    // If this preset was live, clear the active pointer rather than
    // leaving gameState.activeId dangling at a file that no longer exists
    // - /display would otherwise keep trying to fetch it on every
    // gameUpdate and silently fail into a blank/stale stage instead of
    // its built-in fallback layout.
    if (gameState.activeKind === 'preset' && gameState.activeId === req.params.id) {
      commitGameState(() => { gameState.activeKind = null; gameState.activeId = null; });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Standalone overlays ──
// The only visual-authoring system now that the element-based preset
// canvas (/editor) has been retired: an overlay is a set of independent
// HTML/CSS BLOCKS (own <style>, own markup, own Resolve-style transform -
// think "layers," the same mental model logos already use) plus any
// number of PNG logos, all composited onto one 1920x1080 canvas. Each
// block is fully isolated from every other block (and from the author's
// own markup collisions - two blocks can both use a class called
// .container with different rules and never conflict) by rendering in its
// OWN iframe, server-composited; see GET /overlay/:id (the composite
// page: one <iframe> per block + logo <img>s, stacked by z) and
// GET /overlay/:id/block/:blockId (one block's actual document, with the
// live-binding scripts injected - this is what each iframe's src points
// at).
//
// Live data binding is opt-in, per block - it works by scanning a block's
// markup for [data-role] (optionally [data-side]) attributes using the
// same role vocabulary resolveBinding() already understands (teamName,
// score, clock, penalties, timeouts, ...) and writing resolved text
// into those nodes on every gameUpdate. Anything without a data-role is
// left completely alone - so a block can be purely decorative, partially
// live, or fully live, author's choice, with no required structure beyond
// valid HTML.
//
// Versioned exactly like the old preset system was: versions[] + an
// activeVersion pointer, saving always APPENDS a new version (never
// overwrites), and gameState.activeId (see setActive) points at one
// overlay whose activeVersion is what /display currently renders - same
// "set active" / rollback semantics presets used to have. A version
// snapshots ALL of that version's blocks together (so rolling back
// restores every block's content as of that save, not just one).
//
// blockTransforms (keyed by block id) and `logos` both live at the
// OVERLAY level, not per-version - they're positioning/presentation data
// independent of whichever markup version happens to be active, same
// reasoning logos already used before blocks existed. A block's own id is
// stable across versions (only its `html` changes when you edit it), so
// its transform and a rolled-back-to version both still line up correctly.

function overlayPath(id) {
  return path.join(OVERLAYS_DIR, `${id}.json`);
}

function isValidOverlayId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
}

function nextUnnamedOverlayName() {
  const files = fs.existsSync(OVERLAYS_DIR) ? fs.readdirSync(OVERLAYS_DIR).filter(f => f.endsWith('.json')) : [];
  let highest = 0;
  for (const f of files) {
    try {
      const overlay = JSON.parse(fs.readFileSync(path.join(OVERLAYS_DIR, f), 'utf8'));
      const m = /^Unnamed-Overlay_(\d+)$/.exec(overlay.name || '');
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    } catch (e) { /* skip unreadable files */ }
  }
  return 'Unnamed-Overlay_' + String(highest + 1).padStart(2, '0');
}

function overlayActiveVersionOf(overlay) {
  return (overlay.versions || []).find(v => v.version === overlay.activeVersion) || null;
}

// Resolves the BLOCKS an overlay currently serves - its active version's
// blocks array, falling back to the newest version if activeVersion
// somehow doesn't match any stored version (shouldn't happen, but matches
// the defensive style of activeVersionOf's preset equivalent).
function overlayActiveBlocks(overlay) {
  const active = overlayActiveVersionOf(overlay);
  if (active) return active.blocks || [];
  const versions = overlay.versions || [];
  return versions.length ? (versions[versions.length - 1].blocks || []) : [];
}

function overlayActiveBlock(overlay, blockId) {
  return overlayActiveBlocks(overlay).find(b => b.id === blockId) || null;
}

app.get('/api/overlays', (req, res) => {
  try {
    if (!fs.existsSync(OVERLAYS_DIR)) return res.json([]);
    const files = fs.readdirSync(OVERLAYS_DIR).filter(f => f.endsWith('.json'));
    const summaries = files.map(f => {
      // readOverlayOrNull (not a raw read) so a pre-versioning overlay on
      // disk gets migrated to versions[]/activeVersion before its summary
      // is computed - otherwise this list would show versionCount: 0 for
      // any overlay saved before that migration existed, even though
      // GET /api/overlays/:id on the same file correctly shows versions.
      const id = f.slice(0, -'.json'.length);
      const overlay = readOverlayOrNull(id);
      return {
        id: overlay.id,
        name: overlay.name,
        updatedAt: overlay.updatedAt,
        versionCount: (overlay.versions || []).length,
        activeVersion: overlay.activeVersion,
        rating: Number.isInteger(overlay.rating) ? overlay.rating : 0,
        locked: !!overlay.locked,
      };
    });
    res.json(summaries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/overlays/:id', (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Creates a new overlay with one version (version 1). Body carries that
// first version's { html }; name defaults to an auto-numbered
// Unnamed-Overlay_NN when not given or blank - same convention presets used.
// Creates a new overlay with one version (version 1) holding ONE block
// seeded from the pasted HTML - simplest possible starting point; add more
// blocks afterward via POST .../blocks. Body carries { name, html } for
// that first block (html defaults to empty, same as before blocks existed).
app.post('/api/overlays', express.json({ limit: '2mb' }), (req, res) => {
  try {
    fs.mkdirSync(OVERLAYS_DIR, { recursive: true });
    const id = 'overlay_' + crypto.randomBytes(4).toString('hex');
    const now = new Date().toISOString();
    const name = (req.body.name || '').trim() || nextUnnamedOverlayName();
    const blockId = 'block_' + crypto.randomBytes(4).toString('hex');
    const overlay = {
      id, name,
      versions: [{ version: 1, blocks: [{ id: blockId, name: 'Block 1', html: req.body.html || '' }], createdAt: now }],
      activeVersion: 1,
      logos: [],
      blockTransforms: { [blockId]: { ...DEFAULT_HTML_TRANSFORM } },
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(overlayPath(id), JSON.stringify(overlay, null, 2));
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Appends a new version - never overwrites, so a draft never clobbers
// what's actually on air (same contract as POST /api/presets/:id/versions).
// Does not touch activeVersion or logos.
// Body: { blocks: [{id, name, html}, ...], name? }. blocks is the FULL set
// of this overlay's blocks as of this save (content only - transforms live
// separately in blockTransforms, untouched by this route) - a version
// snapshots every block together so rolling back later restores all of
// them consistently, not just whichever one happened to be edited. Any
// block id here that isn't already in blockTransforms gets a default
// transform assigned (see readOverlayOrNull's same fill-in-the-gaps logic)
// so a brand new block added in this save still renders somewhere sane.
app.post('/api/overlays/:id/versions', express.json({ limit: '2mb' }), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  if (!Array.isArray(req.body.blocks)) return res.status(400).json({ error: 'blocks array required' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const now = new Date().toISOString();
    const blocks = req.body.blocks.map(b => ({
      id: typeof b.id === 'string' && b.id ? b.id : 'block_' + crypto.randomBytes(4).toString('hex'),
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Block',
      html: typeof b.html === 'string' ? b.html : '',
    }));
    // No time-based versioning: an overlay has exactly one version, and a
    // save overwrites it in place. (The versions array is kept for the file
    // shape and the ?version= block routes; it is always [v1].)
    const createdAt = (overlay.versions[0] && overlay.versions[0].createdAt) || now;
    overlay.versions = [{ version: 1, blocks, createdAt, updatedAt: now }];
    overlay.activeVersion = 1;
    if (typeof req.body.name === 'string' && req.body.name.trim()) overlay.name = req.body.name.trim();
    // Fill in a default transform for any block id not already tracked
    // (a brand new block added in this save) - same z-stacking convention
    // as readOverlayOrNull and POST /logos.
    let maxZ = -1;
    for (const t of Object.values(overlay.blockTransforms)) if (Number.isFinite(t.z)) maxZ = Math.max(maxZ, t.z);
    for (const l of overlay.logos) if (Number.isFinite(l.z)) maxZ = Math.max(maxZ, l.z);
    for (const block of blocks) {
      if (!overlay.blockTransforms[block.id]) overlay.blockTransforms[block.id] = { ...DEFAULT_HTML_TRANSFORM, z: ++maxZ };
    }
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Points this overlay at a specific version - "I like this draft, use it"
// right after saving, or rolling back to an older version later. Does NOT
// by itself make the overlay live on the broadcast; that's
// gameState.activeId/activeKind (set via the setActive socket event). If
// this overlay happens to already be the live one, re-pointing its
// activeVersion here is what /overlay/:id actually serves on next load.
// Copies an overlay (the locked Scorebug default included) to a new,
// unlocked overlay: name from the body or "<name> copy", blocks from the body
// (the editor sends its edited code) or the source's, transforms and logos
// carried over. This is how the editor "saves" an edit to the locked default.
app.post('/api/overlays/:id/duplicate', express.json({ limit: '2mb' }), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const source = readOverlayOrNull(req.params.id);
    if (!source) return res.status(404).json({ error: 'No such overlay' });
    const now = new Date().toISOString();
    const id = 'overlay_' + crypto.randomBytes(4).toString('hex');
    const name = (typeof req.body.name === 'string' && req.body.name.trim()) || `${source.name} copy`;
    const sourceBlocks = (source.versions.find(v => v.version === source.activeVersion) || source.versions[0] || { blocks: [] }).blocks;
    const blocks = (Array.isArray(req.body.blocks) ? req.body.blocks : sourceBlocks).map(b => ({
      id: typeof b.id === 'string' && b.id ? b.id : 'block_' + crypto.randomBytes(4).toString('hex'),
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Block',
      html: typeof b.html === 'string' ? b.html : '',
    }));
    const blockTransforms = {};
    for (const block of blocks) {
      blockTransforms[block.id] = { ...(source.blockTransforms && source.blockTransforms[block.id] ? source.blockTransforms[block.id] : DEFAULT_HTML_TRANSFORM) };
    }
    const overlay = {
      id, name,
      versions: [{ version: 1, blocks, createdAt: now }],
      activeVersion: 1,
      logos: JSON.parse(JSON.stringify(source.logos || [])),
      blockTransforms,
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(overlayPath(id), JSON.stringify(overlay, null, 2));
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Operator's 0-3 star rating, for sorting through templates in the editor.
// Metadata, not content, so it is allowed on the locked default too.
app.put('/api/overlays/:id/rating', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  const rating = parseInt(req.body.rating, 10);
  if (!Number.isInteger(rating) || rating < 0 || rating > 3) return res.status(400).json({ error: 'rating must be 0-3' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    overlay.rating = rating;
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/overlays/:id/active-version', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  const version = parseInt(req.body.version, 10);
  if (!Number.isInteger(version)) return res.status(400).json({ error: 'Invalid version' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (!overlay.versions.some(v => v.version === version)) return res.status(404).json({ error: 'No such version' });
    overlay.activeVersion = version;
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/overlays/:id', (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const filePath = overlayPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No such overlay' });
    const existing = readOverlayOrNull(req.params.id);
    if (existing && existing.locked) return res.status(423).json({ error: 'This overlay is a locked default and cannot be deleted from the editor.' });
    fs.unlinkSync(filePath);
    // If this overlay was live, clear the active pointer rather than
    // leaving gameState.activeId dangling at a URL that now 404s -
    // /display's #overlayFrame would otherwise keep pointing at a dead
    // page instead of falling back to the built-in layout.
    if (gameState.activeKind === 'overlay' && gameState.activeId === req.params.id) {
      commitGameState(() => { gameState.activeKind = null; gameState.activeId = null; });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Overlay logo layer ──
// Logos sit in their own array on the overlay, entirely separate from the
// pasted `html` field - so uploading/moving/removing a logo never touches
// (or risks mangling) the author's own markup, and the HTML textarea in
// the editor never needs to round-trip <img> tags it didn't write. Each
// entry is {id, assetId, x, y, w, h, z} in the same 1920x1080 coordinate
// space as everything else (gameState, preset elements); assetId points at
// a file already uploaded via POST /api/logos (same luma-key-safe PNG
// normalization as the preset editor's logo elements - nothing
// overlay-specific to redo there).
// Migrates an overlay saved before versioning existed (flat {html} field,
// no versions[]/activeVersion) into the current shape on first read, in
// place on disk - so an overlay created before this change keeps working
// without a separate manual migration step.
// Migrates an overlay through each shape this app has used, in place on
// disk, the first time it's read after an update that changed the shape -
// so an overlay created at any earlier point keeps working with no
// separate manual migration step. Each stage is independently
// idempotent/skippable (checks what's already present before acting), so
// an overlay already on the latest shape round-trips through this
// untouched.
function readOverlayOrNull(id) {
  const filePath = overlayPath(id);
  if (!fs.existsSync(filePath)) return null;
  const overlay = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let dirty = false;

  if (!Array.isArray(overlay.logos)) { overlay.logos = []; dirty = true; }

  // Stage 1 (oldest shape): no versions[] at all, just a flat top-level
  // html string - wrap it as version 1 with a single unnamed block.
  if (!Array.isArray(overlay.versions)) {
    overlay.versions = [{
      version: 1,
      blocks: [{ id: 'block_' + crypto.randomBytes(4).toString('hex'), name: 'Block 1', html: overlay.html || '' }],
      createdAt: overlay.createdAt || new Date().toISOString(),
    }];
    overlay.activeVersion = 1;
    delete overlay.html;
    dirty = true;
  }

  // Stage 2 (single-block-per-version shape, before multi-block support):
  // each version has a flat `html` string instead of a `blocks` array, and
  // the overlay has one overlay-level `htmlTransform` instead of
  // `blockTransforms` keyed by block id. Every version gets wrapped into
  // the SAME single block id (generated once, reused across all of that
  // overlay's versions) so rolling back between pre-migration versions
  // still swaps that one block's content, rather than each version
  // getting its own disconnected block identity.
  if (overlay.versions.some(v => typeof v.html === 'string' && !Array.isArray(v.blocks))) {
    const migratedBlockId = 'block_' + crypto.randomBytes(4).toString('hex');
    overlay.versions = overlay.versions.map(v => {
      if (Array.isArray(v.blocks)) return v; // already migrated (shouldn't happen mid-array, but don't double-wrap)
      return { version: v.version, blocks: [{ id: migratedBlockId, name: 'Block 1', html: v.html || '' }], createdAt: v.createdAt };
    });
    overlay.blockTransforms = { [migratedBlockId]: { ...DEFAULT_HTML_TRANSFORM, ...(overlay.htmlTransform || {}) } };
    delete overlay.htmlTransform;
    dirty = true;
  }

  if (!overlay.blockTransforms || typeof overlay.blockTransforms !== 'object') {
    overlay.blockTransforms = {};
    dirty = true;
  }
  // Any block missing a transform (newly added block, or a gap from a
  // partial migration) gets a default one, keyed by its own id - z stacks
  // new blocks above whatever's already there, same convention
  // POST /logos uses for z-ordering new logos.
  const activeBlocks = overlayActiveBlocks(overlay);
  let maxZ = -1;
  for (const z of Object.values(overlay.blockTransforms)) if (Number.isFinite(z.z)) maxZ = Math.max(maxZ, z.z);
  for (const l of overlay.logos) if (Number.isFinite(l.z)) maxZ = Math.max(maxZ, l.z);
  for (const block of activeBlocks) {
    if (!overlay.blockTransforms[block.id]) {
      overlay.blockTransforms[block.id] = { ...DEFAULT_HTML_TRANSFORM, z: ++maxZ };
      dirty = true;
    }
  }

  if (dirty) fs.writeFileSync(filePath, JSON.stringify(overlay, null, 2));
  return overlay;
}

function writeOverlay(overlay) {
  overlay.updatedAt = new Date().toISOString();
  fs.writeFileSync(overlayPath(overlay.id), JSON.stringify(overlay, null, 2));
  // Logos, the whole-block transform, and active-version changes don't go
  // through commitGameState/gameUpdate (they're not part of gameState at
  // all) - so without this, /display's #overlayFrame has no signal that
  // the overlay it's already showing just changed, and would keep
  // displaying stale content until something else happens to reassign its
  // src (switching away and back, or a manual reload). Only broadcast when
  // the edited overlay IS the one currently live, so routine edits to a
  // draft/inactive overlay don't cause the live display to reload for no
  // visible reason.
  if (gameState.activeKind === 'overlay' && gameState.activeId === overlay.id) {
    io.emit('overlayContentChanged', { id: overlay.id });
  }
}

// Logo transform fields follow DaVinci Resolve's Transform panel convention
// rather than a top-left x/y/w/h box, since that's the control scheme
// being matched here: zoomX/zoomY are a percentage of the uploaded image's
// native size (100 = native), posX/posY are an offset in px from the
// 1920x1080 canvas's CENTER (not the top-left corner - positive x is
// right, positive y is down, matching Resolve), and rotation is in
// degrees. nativeW/nativeH (the uploaded PNG's actual pixel size, from
// sharp's own metadata at upload time) are stored once and never
// recomputed, since zoom% is meaningless without them.
app.post('/api/overlays/:id/logos', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  const { assetId, nativeW, nativeH } = req.body || {};
  if (typeof assetId !== 'string' || !assetId) return res.status(400).json({ error: 'assetId required' });
  if (!Number.isFinite(nativeW) || !Number.isFinite(nativeH)) return res.status(400).json({ error: 'nativeW/nativeH required' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    // Default zoom brings a large source image down to a sane on-screen
    // size (capped at 300px on its longest side) rather than pasting it
    // in at full native resolution, which for a modern phone photo would
    // be far larger than the whole 1920x1080 canvas.
    const maxDim = 300;
    const defaultZoom = Math.min(100, (maxDim / Math.max(nativeW, nativeH)) * 100);
    const logo = {
      id: 'logo_' + crypto.randomBytes(4).toString('hex'),
      assetId,
      nativeW, nativeH,
      zoomX: defaultZoom, zoomY: defaultZoom,
      posX: 0, posY: 0,
      rotation: 0,
      z: overlay.logos.length,
    };
    overlay.logos.push(logo);
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Partial update {zoomX, zoomY, posX, posY, rotation, z} - used for
// drag/resize/rotate/layer-order in the editor. zoomX/zoomY are clamped to
// a sane positive range; everything else is unclamped (position/rotation
// can legitimately go off-canvas or past 360, same as Resolve).
app.put('/api/overlays/:id/logos/:logoId', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const logo = overlay.logos.find(l => l.id === req.params.logoId);
    if (!logo) return res.status(404).json({ error: 'No such logo' });
    for (const key of ['zoomX', 'zoomY']) {
      if (Number.isFinite(req.body[key])) logo[key] = Math.max(1, req.body[key]);
    }
    for (const key of ['posX', 'posY', 'rotation', 'z']) {
      if (Number.isFinite(req.body[key])) logo[key] = req.body[key];
    }
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/overlays/:id/logos/:logoId', (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const before = overlay.logos.length;
    overlay.logos = overlay.logos.filter(l => l.id !== req.params.logoId);
    if (overlay.logos.length === before) return res.status(404).json({ error: 'No such logo' });
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Overlay HTML/CSS blocks ──
// An overlay can hold multiple independent HTML/CSS blocks (think "layers"
// - same mental model as logos), each fully isolated in its own iframe
// when composited (see GET /overlay/:id and GET /overlay/:id/block/:blockId
// further down). A block's CONTENT (its html) is versioned - see
// POST /api/overlays/:id/versions, which snapshots every block together.
// A block's EXISTENCE (which block ids a given version has) is edited in
// place on WHICHEVER VERSION THE EDITOR IS CURRENTLY VIEWING (see the
// ?version= query param below, defaulting to the active version when
// omitted) - not always the live/active one, since the editor lets you
// view/edit a version other than the active one (e.g. right after Save,
// before Set Active), and add/delete needs to affect what you're actually
// looking at, not silently a different version. A block's TRANSFORM
// (blockTransforms, keyed by block id) stays overlay-level, not per-
// version, same as logos - positioning is presentation data independent
// of content. Renaming a block is metadata-only, also in place.

// Resolves which version a blocks-mutation route should operate on: the
// one named by ?version=, or the active version if that query param is
// omitted (keeps any caller that doesn't pass it working against the
// live version, same as this route's original single-version behavior).
function resolveTargetVersion(overlay, req) {
  if (req.query.version) {
    const v = parseInt(req.query.version, 10);
    return overlay.versions.find(ver => ver.version === v) || null;
  }
  return overlayActiveVersionOf(overlay);
}

// Adds a new, empty block to the target version, in place (NOT a new
// version - see the block above for why). Body: { name? }.
app.post('/api/overlays/:id/blocks', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const targetVersion = resolveTargetVersion(overlay, req);
    if (!targetVersion) return res.status(409).json({ error: 'No such version to add a block to' });
    if (!Array.isArray(targetVersion.blocks)) targetVersion.blocks = [];
    const blockId = 'block_' + crypto.randomBytes(4).toString('hex');
    const name = (req.body.name || '').trim() || ('Block ' + (targetVersion.blocks.length + 1));
    targetVersion.blocks.push({ id: blockId, name, html: req.body.html || DEFAULT_BLOCK_TEMPLATE });
    let maxZ = -1;
    for (const t of Object.values(overlay.blockTransforms)) if (Number.isFinite(t.z)) maxZ = Math.max(maxZ, t.z);
    for (const l of overlay.logos) if (Number.isFinite(l.z)) maxZ = Math.max(maxZ, l.z);
    overlay.blockTransforms[blockId] = { ...DEFAULT_HTML_TRANSFORM, z: ++maxZ };
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Renames a block (metadata only - in place, like a logo's fields; does
// NOT touch its html, which only changes via a versioned Save). Operates
// on the target version (?version=, default active) same as add/delete.
app.put('/api/overlays/:id/blocks/:blockId', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const targetVersion = resolveTargetVersion(overlay, req);
    const block = targetVersion && (targetVersion.blocks || []).find(b => b.id === req.params.blockId);
    if (!block) return res.status(404).json({ error: 'No such block in that version' });
    if (typeof req.body.name === 'string' && req.body.name.trim()) block.name = req.body.name.trim();
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Removes a block from the target version (?version=, default active), in
// place, and its transform. Does NOT touch other versions - a block
// deleted from one version still exists in any version where it was
// saved, so switching to one of those can bring it back (at which point
// it'll get a fresh default transform again via readOverlayOrNull's
// fill-in-the-gaps pass).
app.delete('/api/overlays/:id/blocks/:blockId', (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const targetVersion = resolveTargetVersion(overlay, req);
    if (!targetVersion || !Array.isArray(targetVersion.blocks)) return res.status(404).json({ error: 'No such block' });
    const before = targetVersion.blocks.length;
    targetVersion.blocks = targetVersion.blocks.filter(b => b.id !== req.params.blockId);
    if (targetVersion.blocks.length === before) return res.status(404).json({ error: 'No such block' });
    delete overlay.blockTransforms[req.params.blockId];
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One block's Resolve-style transform (zoomX/zoomY/posX/posY/rotation/z) -
// same fields and conventions as a logo's, applied to that block's own
// IFRAME from the outside (see blockStyle() further down) rather than to
// a shared <body>, now that each block is its own isolated document.
app.put('/api/overlays/:id/blocks/:blockId/transform', express.json(), (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).json({ error: 'Invalid overlay id' });
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).json({ error: 'No such overlay' });
    if (overlay.locked) return res.status(423).json({ error: 'This overlay is a locked default: it is edited programmatically, not from the editor.' });
    const t = overlay.blockTransforms[req.params.blockId];
    if (!t) return res.status(404).json({ error: 'No such block' });
    for (const key of ['zoomX', 'zoomY']) {
      if (Number.isFinite(req.body[key])) t[key] = Math.max(1, req.body[key]);
    }
    for (const key of ['posX', 'posY', 'rotation', 'z']) {
      if (Number.isFinite(req.body[key])) t[key] = req.body[key];
    }
    writeOverlay(overlay);
    res.json(overlay);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Converts one logo's Resolve-style transform (zoomX/zoomY as a % of
// native size, posX/posY as an offset from canvas CENTER, rotation in
// degrees) into an absolutely-positioned, canvas-pixel <img> style. The
// canvas is always exactly 1920x1080 (the kiosk's own fixed resolution -
// see docs/kiosk-display.md), so "center" here is literally (960, 540)
// and these are real on-screen pixels, not percentages - matching how
// Resolve's own Position values are pixels relative to its frame center,
// not viewport-relative percentages. left/top target the image's own
// center (not top-left corner) so rotation happens around the right
// point; transform-origin is left at the element's center (its CSS
// default) which is exactly where left/top already placed it.
function logoStyle(logo) {
  const w = logo.nativeW * (logo.zoomX / 100);
  const h = logo.nativeH * (logo.zoomY / 100);
  const centerX = 960 + logo.posX;
  const centerY = 540 + logo.posY;
  const left = centerX - w / 2;
  const top = centerY - h / 2;
  return `position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${h}px;` +
    `transform:rotate(${logo.rotation || 0}deg);z-index:${logo.z ?? 0};`;
}

const DEFAULT_HTML_TRANSFORM = { zoomX: 100, zoomY: 100, posX: 0, posY: 0, rotation: 0, z: 0 };

// Seeds a new block's own iframe document with the minimum needed to
// paint something visible and keyable - an empty block would otherwise
// render as nothing at all, giving no hint there's content to edit.
const DEFAULT_BLOCK_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { background: #000; margin: 0; font-family: Arial, sans-serif; }
  .box { display: inline-flex; gap: 8px; padding: 40px; }
  .team { background: #222; color: #fff; font-weight: bold; font-size: 24px; padding: 10px 20px; }
</style>
</head>
<body>
  <div class="box">
    <div class="team" data-role="teamName" data-side="left">Team 1</div>
  </div>
</body>
</html>
`;

// Same Resolve-style transform model as logoStyle, applied to a block's
// own IFRAME element from the outside, rather than to a shared <body>
// inside a single document - now that every block is fully isolated in
// its own iframe (see GET /overlay/:id), there's no shared-document CSS
// to transform; the iframe's own box is what moves/scales/rotates. The
// iframe's box stays a fixed 1920x1080 (so a block's own CSS/layout
// behaves identically to viewing it at 100% zoom, regardless of what zoom
// is actually applied) - zoomX/zoomY are a direct scale on that fixed
// box, NOT a percentage of some measured "native content size" (a
// block's own <body> doesn't reliably shrink-wrap to its visible content
// - see overlay-editor.html's currentHtmlTransform comment for why there
// was never a reliable "native size" to measure in the first place, back
// when this was still a per-document transform). 100 = render at face
// value; 200/50 double/halve everything proportionally from the canvas's
// own center (960px, 540px), not the block's own.
function blockIframeStyle(t) {
  const zoomX = (t.zoomX ?? 100) / 100;
  const zoomY = (t.zoomY ?? 100) / 100;
  const centerX = 960 + (t.posX ?? 0);
  const centerY = 540 + (t.posY ?? 0);
  // transform-origin is the iframe's own geometric center (50% 50% of ITS
  // OWN box is correct here, unlike the old body-transform approach - an
  // iframe element's box is always exactly what we set it to, 1920x1080,
  // with no equivalent of body's own stretch-to-content-width ambiguity).
  // left/top place the iframe so that its center sits at the canvas point
  // (centerX, centerY) BEFORE the scale/rotate transform is applied (the
  // transform then pivots around that same point via transform-origin).
  const left = centerX - 1920 / 2;
  const top = centerY - 1080 / 2;
  return `position:absolute;left:${left}px;top:${top}px;width:1920px;height:1080px;` +
    `border:none;transform-origin:50% 50%;transform:scale(${zoomX},${zoomY}) rotate(${t.rotation ?? 0}deg);` +
    `z-index:${t.z ?? 0};`;
}

// Injects the live-binding scripts into one block's raw HTML, same
// pattern the single-block version of this app always used. html,body
// overflow:hidden prevents this block's own content from ever becoming
// internally scrollable - content pushed past its own edges would
// otherwise show a scrollbar, a visible light-colored strip that has
// nothing to do with the luma-key black background (this bit this app
// for real once already, back when there was only one block - see
// docs/scorebug-editor.md's history if curious).
function injectBlockRuntime(html) {
  const overflowStyle = `<style>html,body{overflow:hidden !important}</style>`;
  const scripts = `
<script src="/socket.io/socket.io.js"></script>
<script src="/scorebug-render.js"></script>
<script src="/overlay-bind.js"></script>`;
  let out = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, scripts + '\n</body>') : html + scripts;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, overflowStyle + '\n</head>') : overflowStyle + out;
  return out;
}

// Serves ONE block's own document (not the composite) - this is what each
// block's iframe (in the composite page below) points its src at. Opening
// this URL directly shows just that one block, full-canvas, at 100% zoom
// (its transform is applied by the PARENT page styling the iframe, not by
// this document itself) - useful for debugging one block in isolation.
app.get('/overlay/:id/block/:blockId', (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).send('Invalid overlay id');
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).send('No such overlay');
    const block = overlayActiveBlock(overlay, req.params.blockId);
    if (!block) return res.status(404).send('No such block');
    res.set('Content-Type', 'text/html').send(injectBlockRuntime(block.html));
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Serves the COMPOSITE page: one <iframe> per block (each pointed at
// GET .../block/:blockId, positioned/scaled/rotated per its own
// blockTransforms entry) plus each logo as an absolutely-positioned
// <img>, all stacked together by z - so opening THIS URL in OBS/a browser
// source/the kiosk needs nothing beyond the URL itself, same as before
// blocks existed. Correct at exactly 1920x1080 (the kiosk's fixed
// resolution - see docs/kiosk-display.md); this page is not responsive by
// design, same as every other page in this app.
app.get('/overlay/:id', (req, res) => {
  if (!isValidOverlayId(req.params.id)) return res.status(400).send('Invalid overlay id');
  try {
    const overlay = readOverlayOrNull(req.params.id);
    if (!overlay) return res.status(404).send('No such overlay');
    const blocks = overlayActiveBlocks(overlay);
    const blockIframes = blocks.map(block => {
      const t = overlay.blockTransforms[block.id] || DEFAULT_HTML_TRANSFORM;
      return `<iframe src="/overlay/${overlay.id}/block/${block.id}" style="${blockIframeStyle(t)}"></iframe>`;
    });
    const logoImgs = overlay.logos
      .slice()
      .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
      .map(logo => `<img src="/logos/${logo.assetId}" style="${logoStyle(logo)}">`);
    const layers = [...blockIframes, ...logoImgs].join('\n');
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden;width:1920px;height:1080px}</style>
</head>
<body>
${layers}
</body>
</html>`;
    res.set('Content-Type', 'text/html').send(html);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Logo uploads ──
// Served statically from public/logos/ (same free-ride as public/videos/ -
// express.static('public') already covers it, no extra route needed to
// serve them back out).
//
// The ATEM keys on luma (black = transparent), never true alpha over HDMI.
// A naive <img> of an uploaded PNG would only be correct if nothing but the
// black stage ever sits behind it - any semi-transparent/anti-aliased edge
// pixel blends to dark GRAY in the source file, not black, which reads as a
// visible fringe/halo on a hard luma key even though it looks fine in a
// browser. So every upload is normalized here, once, rather than trusting
// every future render site to get the compositing right:
//   1. Hard-threshold alpha (>=128 -> fully opaque, <128 -> fully
//      transparent) BEFORE flattening. flatten() alone still alpha-blends
//      partial-transparency pixels to gray; thresholding first means only
//      pure black or pure source color ever reaches the flatten step.
//   2. flatten() the thresholded image against true #000000, producing a
//      3-channel (no-alpha) PNG that's correct for luma key regardless of
//      how the original file was exported or matted.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === 'image/png');
  },
});

app.post('/api/logos', upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PNG file provided (field name must be "logo")' });
  try {
    fs.mkdirSync(LOGOS_DIR, { recursive: true });

    const img = sharp(req.file.buffer).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      data[i + 3] = data[i + 3] < 128 ? 0 : 255;
    }
    const thresholded = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    const flattened = await thresholded.flatten({ background: '#000000' }).png().toBuffer();

    const assetId = 'logo_' + crypto.randomBytes(4).toString('hex') + '.png';
    fs.writeFileSync(path.join(LOGOS_DIR, assetId), flattened);
    res.json({ assetId, width: info.width, height: info.height });
  } catch (e) {
    console.error('Logo upload failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logos', (req, res) => {
  try {
    if (!fs.existsSync(LOGOS_DIR)) return res.json([]);
    const files = fs.readdirSync(LOGOS_DIR).filter(f => f.endsWith('.png'));
    res.json(files.map(f => ({ assetId: f })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HTTP API for score updates (used by keyboard controller)
app.post('/api/score/:side/:change', (req, res) => {
  const { side, change } = req.params;
  const delta = parseInt(change, 10);

  if (!['left', 'right'].includes(side) || isNaN(delta)) {
    return res.status(400).json({ error: 'Invalid side or change value' });
  }

  commitGameState(() => {
    if (side === 'left') {
      gameState.leftScore = Math.max(0, gameState.leftScore + delta);
    } else {
      gameState.rightScore = Math.max(0, gameState.rightScore + delta);
    }
  });
  res.json({ side, score: side === 'left' ? gameState.leftScore : gameState.rightScore });
});

// HTTP API for bracket navigation (used by keyboard controller)
app.post('/api/prev-game', (req, res) => {
  const result = navigateGame(-1);
  res.json(result);
});

app.post('/api/next-game', (req, res) => {
  const result = navigateGame(1);
  res.json(result);
});

// HTTP API for swap sides (used by keyboard controller)
app.post('/api/swap-sides', (req, res) => {
  commitGameState(() => {
    const tempTeam = gameState.leftTeam;
    const tempScore = gameState.leftScore;
    const tempColor = gameState.leftColor;
    const tempScoreText = gameState.leftScoreTextColor;
    gameState.leftTeam = gameState.rightTeam;
    gameState.leftScore = gameState.rightScore;
    gameState.leftColor = gameState.rightColor;
    gameState.leftScoreTextColor = gameState.rightScoreTextColor;
    gameState.rightTeam = tempTeam;
    gameState.rightScore = tempScore;
    gameState.rightColor = tempColor;
    gameState.rightScoreTextColor = tempScoreText;
    gameState.sidesSwapped = !gameState.sidesSwapped;
  });
  res.json({ success: true });
});

// HTTP API for ATEM input switching (used by keyboard controller)
app.post('/api/atem/input/:num', async (req, res) => {
  const input = parseInt(req.params.num, 10);
  if (isNaN(input) || input < 1) return res.status(400).json({ error: 'Invalid input number' });
  if (!atemControl.atem || !atemControl.isConnected) return res.status(503).json({ error: 'ATEM not connected' });
  try {
    console.log(`Direct cut to input: ${input}`);
    await atemControl.atem.changeProgramInput(input);
    gameState.atemStatus.currentInput = input;
    saveGameState();
    io.emit('gameUpdate', gameState);
    res.json({ success: true, input });
  } catch (error) {
    console.error('Failed to switch ATEM input:', error);
    res.status(500).json({ error: 'Failed to switch input' });
  }
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function findNextMatchupIndex(matchups, currentIdx, direction) {
  // Clamp a stale currentIdx (e.g. left over from a schedule that has
  // since been overwritten with fewer entries, such as after a Challonge
  // re-sync) back into range before walking, so navigation still finds
  // the first/last matchup instead of silently finding nothing.
  const clampedIdx = Math.max(-1, Math.min(currentIdx, matchups.length));
  let i = clampedIdx + direction;
  while (i >= 0 && i < matchups.length) {
    if (!matchups[i].group) return i;
    i += direction;
  }
  return null;
}

function loadMatchupByIndex(matchups, idx) {
  const m = matchups[idx];
  if (!m || m.group) return;
  const lstc = m.lstc || defaultGameState.leftScoreTextColor;
  const rstc = m.rstc || defaultGameState.rightScoreTextColor;
  commitGameState(() => {
    if (gameState.sidesSwapped) {
      gameState.leftTeam  = m.right;
      gameState.rightTeam = m.left;
      gameState.leftColor  = m.rc;
      gameState.rightColor = m.lc;
      gameState.leftScoreTextColor  = rstc;
      gameState.rightScoreTextColor = lstc;
    } else {
      gameState.leftTeam  = m.left;
      gameState.rightTeam = m.right;
      gameState.leftColor  = m.lc;
      gameState.rightColor = m.rc;
      gameState.leftScoreTextColor  = lstc;
      gameState.rightScoreTextColor = rstc;
    }
    gameState.leftScore = 0;
    gameState.rightScore = 0;
    gameState.loadedMatchupIndex = idx;
  });
}

// Next/Prev Game always walks bracket.json — whether its matchups were
// typed in manually or last synced in by challonge_sync.py (which
// overwrites bracket.json directly while Challonge sync is enabled).
// direction: 1 = next, -1 = previous
function navigateGame(direction) {
  if (!fs.existsSync(BRACKET_FILE)) return { ok: false, error: 'No bracket saved' };
  const bracket = JSON.parse(fs.readFileSync(BRACKET_FILE, 'utf8'));
  const currentIdx = gameState.loadedMatchupIndex ?? -1;
  const nextIdx = findNextMatchupIndex(bracket.matchups, currentIdx, direction);
  if (nextIdx === null) {
    if (direction > 0 && syncProviders.challonge.config.enabled) syncProviders.challonge.pollNow();
    return { ok: false, error: direction > 0 ? 'No next matchup' : 'No previous matchup' };
  }
  loadMatchupByIndex(bracket.matchups, nextIdx);
  return { ok: true, index: nextIdx };
}

// Deferred-start signal: the first time the /display page connects, the
// overlay is really on screen, so tell systemd the kiosk is up.
// scoreboard-kiosk-up.path starts scoreboard-deferred.target (Companion,
// keypad bridge) on this file; it is on tmpfs and gone after a reboot.
// scoreboard-deferred-fallback.timer covers the case where the display
// never connects. See docs/kiosk-display.md, "Boot ordering".
const KIOSK_UP_FILE = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'scoreboard-kiosk-up');
let kioskUpSignalled = false;
function signalKioskUp(socket) {
  if (kioskUpSignalled) return;
  const referer = socket.handshake?.headers?.referer || '';
  if (!/\/display(\?|$)/.test(referer)) return;
  kioskUpSignalled = true;
  fs.writeFile(KIOSK_UP_FILE, new Date().toISOString() + '\n', (err) => {
    if (err) console.error('kiosk-up signal failed:', err.message);
    else console.log('Display connected: kiosk-up signalled for deferred services');
  });
}

io.on('connection', (socket) => {
  console.log('Client connected');
  signalKioskUp(socket);
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
  
  socket.emit('gameUpdate', gameState);
  
  socket.on('updateTeamName', (data) => {
    if (data.side === 'left') {
      gameState.leftTeam = data.name;
    } else if (data.side === 'right') {
      gameState.rightTeam = data.name;
    }
    saveGameState();
    io.emit('gameUpdate', gameState);
  });
  
  socket.on('updateTeamColor', (data) => {
    if (data.side === 'left') {
      gameState.leftColor = data.color;
    } else if (data.side === 'right') {
      gameState.rightColor = data.color;
    }
    saveGameState();
    io.emit('gameUpdate', gameState);
  });
  
  socket.on('updateGlobalColor', (data) => {
    try {
      console.log('Global color update:', data.type, data.color);
      if (data.type === 'text') {
        gameState.textColor = data.color;
      } else if (data.type === 'background') {
        gameState.backgroundColor = data.color;
      } else if (data.type === 'leftScoreText') {
        gameState.leftScoreTextColor = data.color;
      } else if (data.type === 'rightScoreText') {
        gameState.rightScoreTextColor = data.color;
      }
      saveGameState();
      io.emit('gameUpdate', gameState);
    } catch (error) {
      console.error('Error in updateGlobalColor:', error);
    }
  });
  
  socket.on('updateScore', (data) => {
    commitGameState(() => {
      if (data.side === 'left') {
        gameState.leftScore = Math.max(0, gameState.leftScore + data.change);
      } else if (data.side === 'right') {
        gameState.rightScore = Math.max(0, gameState.rightScore + data.change);
      }
    });
  });

  socket.on('swapSides', () => {
    commitGameState(() => {
      const tempTeam = gameState.leftTeam;
      const tempScore = gameState.leftScore;
      const tempColor = gameState.leftColor;
      const tempScoreText = gameState.leftScoreTextColor;
      gameState.leftTeam = gameState.rightTeam;
      gameState.leftScore = gameState.rightScore;
      gameState.leftColor = gameState.rightColor;
      gameState.leftScoreTextColor = gameState.rightScoreTextColor;
      gameState.rightTeam = tempTeam;
      gameState.rightScore = tempScore;
      gameState.rightColor = tempColor;
      gameState.rightScoreTextColor = tempScoreText;
      gameState.sidesSwapped = !gameState.sidesSwapped;
    });
  });

  socket.on('resetGame', () => {
    commitGameState(() => {
      gameState.leftScore = 0;
      gameState.rightScore = 0;
    });
  });

  socket.on('navigateMatchup', (data) => {
    navigateGame(data.direction);
  });

  socket.on('loadMatchup', (data) => {
    commitGameState(() => {
      gameState.leftTeam  = data.leftTeam;
      gameState.rightTeam = data.rightTeam;
      gameState.leftColor  = data.leftColor;
      gameState.rightColor = data.rightColor;
      gameState.leftScore  = 0;
      gameState.rightScore = 0;
      gameState.loadedMatchupIndex = data.matchupIndex ?? null;
    });
  });

  // Instant cut, by design: setting activeKind/activeId goes through the
  // same commitGameState -> saveGameState -> io.emit('gameUpdate')
  // pipeline as everything else, so display.html's next full-state render
  // just swaps its whole layout. No separate transition/animation
  // mechanism. data.kind is 'preset' | 'overlay'; an empty/missing id (or
  // kind) clears back to /display's built-in fallback.
  socket.on('setActive', (data) => {
    commitGameState(() => {
      gameState.activeId = data.id || null;
      gameState.activeKind = gameState.activeId ? (data.kind || 'preset') : null;
    });
  });

  // Asks every open display page (the kiosk) to reload itself in place -
  // picks up overlay HTML/CSS or display code changes without restarting
  // Chromium, which would drop to the bare desktop on stream. display.html
  // handles it the same way it handles a server restart (solid black page
  // background, so no flash).
  socket.on('reloadDisplay', () => {
    console.log('Display reload requested from control');
    io.emit('reloadDisplay');
  });

  // Hide/show the scorebug layer on /display without touching activeKind/
  // activeId - the operator's selection survives, the stage just goes to
  // the keyed-out black. Does not affect the ladder or a commercial break.
  socket.on('setScorebugHidden', (data) => {
    commitGameState(() => {
      gameState.scorebugHidden = !!(data && data.hidden);
    });
    console.log(`Scorebug ${gameState.scorebugHidden ? 'HIDDEN from' : 'shown on'} display`);
  });

  socket.on('setDebugOverlay', (data) => {
    commitGameState(() => {
      gameState.debugOverlay = !!data.enabled;
    });
  });

  // Bracket ladder as a full-frame layer on /display, over the scorebug and
  // under a commercial break. The ladder page is luma-keyed by the ATEM like
  // everything else on the display output (black background), so turning it
  // on shows the bracket over the program. From the /ladder page's button.
  socket.on('setLadder', (data) => {
    const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(String((data && data.tournament) || ''));
    commitGameState(() => {
      gameState.ladder = { active: !!(data && data.active), tournament: m ? m[0].toLowerCase() : null };
    });
    console.log(`Ladder layer ${gameState.ladder.active ? 'ON' : 'off'}${gameState.ladder.tournament ? ' for ' + gameState.ladder.tournament : ''}`);
  });

  socket.on('startCommercialBreak', async (data) => {
    console.log('Starting commercial break:', data.videoPath);

    // Capture USK state before the break so we can restore it afterwards
    const uskWasActive = gameState.atemStatus.upstreamKeyEnabled;
    console.log(`🎬 USK state at break start: ${uskWasActive ? 'ON' : 'OFF'}`);

    // If bars are active, inherit their pre-bars audio snapshot so stop-commercial
    // restores to the state before bars (not the all-muted bars state).
    // Otherwise snapshot current live audio state.
    // Inputs: 1=HDMI1(graphics), 2=HDMI2(cam1), 3=HDMI3(cam2), 4=HDMI4(cam3)
    // 1301=mic1 (two mono sources: -256, -255), 1302=mic2 stereo (source: -65280)
    let audioSnapshot = [];
    if (gameState.barsActive && gameState.barsAudioSnapshot.length > 0) {
      audioSnapshot = gameState.barsAudioSnapshot;
      console.log('🎬 Bars were active — inheriting bars audio snapshot for commercial break restore');
      gameState.barsActive = false;
      gameState.barsAudioSnapshot = [];
    } else if (atemControl.isConnected && atemControl.atem.state && atemControl.atem.state.fairlight && atemControl.atem.state.fairlight.inputs) {
      const inputs = atemControl.atem.state.fairlight.inputs;
      for (const [inputIndex, input] of Object.entries(inputs)) {
        for (const [sourceKey, source] of Object.entries(input.sources)) {
          const mixOption = source.properties.mixOption;
          audioSnapshot.push({ inputIndex: parseInt(inputIndex), sourceKey, mixOption });
          console.log(`🎬 Audio snapshot: input ${inputIndex} source ${sourceKey} mixOption=${mixOption}`);
        }
      }
    }

    // Tell display page to go black before ATEM operations
    io.emit('displayBlack', true);

    // ATEM sequence: Fade out downstream key -> Switch to graphics input -> Ensure DSK stays OFF
    if (atemControl.isConnected) {
      console.log('🎬 ATEM: Starting commercial break sequence...');

      // Step 1: Turn off USK if it was active
      if (uskWasActive) {
        console.log('🎬 Turning off USK for commercial break...');
        await atemControl.atem.setUpstreamKeyerOnAir(false, 0, 0);
        gameState.atemStatus.upstreamKeyEnabled = false;
      }

      // Step 2: Fade out the downstream key (turn OFF to hide scoreboard overlay)
      await fadeDownstreamKey(false);

      // Wait for DSK fade to complete (ATEM auto transition time is typically 1-2 seconds)
      console.log('Waiting for DSK fade to complete...');
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Step 3: Switch to graphics input
      await switchToGraphicsInput();

      // Step 4: Ensure DSK stays OFF on graphics input (immediate cut)
      console.log('Ensuring DSK stays OFF on graphics input...');
      await setDownstreamKey(false);

      // Step 5: Ensure Pi HDMI audio output is at full volume (Chromium/PipeWire can drop it)
      console.log('🎬 Ensuring Pi HDMI audio volume is at 100%...');
      exec('wpctl set-volume 56 1.0', (err) => {
        if (err) console.error('🎬 Failed to set HDMI volume:', err.message);
        else console.log('🎬 Pi HDMI audio volume set to 1.0');
      });

      // Step 6: Mute all inputs except graphics HDMI (input 1)
      console.log('🎬 Muting audio inputs for commercial break...');
      for (const ch of audioSnapshot) {
        if (ch.inputIndex === GRAPHICS_INPUT) {
          console.log(`🎬 Leaving graphics audio input ${ch.inputIndex} source ${ch.sourceKey} unchanged`);
        } else {
          console.log(`🎬 Muting input ${ch.inputIndex} source ${ch.sourceKey}`);
          await atemControl.atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: 1 }); // 1 = Off
        }
      }
    }

    gameState.commercialBreak = {
      active: true,
      videoPath: data.videoPath,
      startTime: Date.now(),
      uskWasActive,
      audioSnapshot
    };
    saveGameState();
    io.emit('gameUpdate', gameState);
  });

  socket.on('stopCommercialBreak', async () => {
    console.log('Stopping commercial break');

    // Capture state before wiping commercialBreak
    const uskWasActive = gameState.commercialBreak.uskWasActive || false;
    const audioSnapshot = gameState.commercialBreak.audioSnapshot || [];
    console.log(`🎬 USK was active before break: ${uskWasActive}`);

    // IMMEDIATELY stop the video on frontend before doing ATEM operations
    gameState.commercialBreak = {
      active: false,
      videoPath: '',
      startTime: null
    };
    console.log('🎬 Immediately stopping frontend video...');
    io.emit('gameUpdate', gameState);

    // ATEM sequence: Switch back to camera, then fade in DSK
    if (atemControl.isConnected) {
      console.log('🎬 ATEM: Ending commercial break sequence...');

      // Step 1: Switch back to previous camera input
      console.log('Switching back to camera...');
      await switchToPreviousInput();

      // Step 2: Wait for input switch to complete
      console.log('Waiting for input switch to settle...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 3: Turn the DSK back ON for camera overlay
      console.log('🎬 Turning DSK back ON for camera overlay...');
      await setDownstreamKey(true);

      // Step 4: Turn USK on as DSK fades in
      console.log('🎬 Turning USK on after commercial break...');
      await atemControl.atem.setUpstreamKeyerOnAir(true, 0, 0);
      gameState.atemStatus.upstreamKeyEnabled = true;

      // Step 5: Restore HDMI camera inputs only (inputs 2-4); leave mics muted for manual restore
      if (audioSnapshot.length > 0) {
        console.log('🎬 Restoring camera audio inputs after commercial break...');
        for (const ch of audioSnapshot) {
          if (ch.inputIndex !== GRAPHICS_INPUT) {
            console.log(`🎬 Restoring input ${ch.inputIndex} source ${ch.sourceKey} to mixOption=${ch.mixOption}`);
            await atemControl.atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: ch.mixOption });
          }
        }
      }

      console.log('Commercial break end sequence complete - DSK restored for camera');
    }

    saveGameState();
    io.emit('gameUpdate', gameState);
  });

  // ATEM control handlers
  socket.on('atemConnect', async () => {
    console.log('Manual ATEM connection requested');
    await connectToAtem();
  });

  socket.on('atemSwitchInput', async (data) => {
    if (!atemControl.atem || !atemControl.isConnected) {
      console.log('ATEM not connected - cannot switch input');
      return;
    }

    try {
      console.log(`Manual auto transition to input: ${data.input}`);
      await atemControl.atem.changePreviewInput(data.input);
      await atemControl.atem.autoTransition();
      gameState.atemStatus.currentInput = data.input;
      saveGameState();
      io.emit('gameUpdate', gameState);
    } catch (error) {
      console.error('Failed to auto transition input:', error);
    }
  });

  socket.on('atemToggleDownstreamKey', async () => {
    console.log('🔧 MANUAL DSK TOGGLE REQUESTED - someone clicked the button');
    if (!atemControl.atem || !atemControl.isConnected) {
      console.log('ATEM not connected - cannot toggle downstream key');
      return;
    }

    const newState = !gameState.atemStatus.downstreamKeyEnabled;
    console.log(`🔧 DSK toggle: ${gameState.atemStatus.downstreamKeyEnabled ? 'ON' : 'OFF'} -> ${newState ? 'ON' : 'OFF'}`);
    await setDownstreamKey(newState);
    io.emit('gameUpdate', gameState);
  });

  socket.on('atemToggleUpstreamKey', async () => {
    console.log('🔧 MANUAL USK TOGGLE REQUESTED - someone clicked the button');
    if (!atemControl.atem || !atemControl.isConnected) {
      console.log('ATEM not connected - cannot toggle upstream key');
      return;
    }

    const newState = !gameState.atemStatus.upstreamKeyEnabled;
    console.log(`🔧 USK toggle: ${gameState.atemStatus.upstreamKeyEnabled ? 'ON' : 'OFF'} -> ${newState ? 'ON' : 'OFF'}`);
    try {
      await atemControl.atem.setUpstreamKeyerOnAir(newState, 0, 0);
      gameState.atemStatus.upstreamKeyEnabled = newState;
      saveGameState();
      io.emit('gameUpdate', gameState);
    } catch (error) {
      console.error('Failed to toggle upstream key:', error);
    }
  });

  socket.on('atemStartBars', async () => {
    if (!atemControl.atem || !atemControl.isConnected) {
      console.log('ATEM not connected - cannot start/stop bars');
      return;
    }
    if (gameState.commercialBreak && gameState.commercialBreak.active) {
      console.log('🎬 Cannot start/stop bars during commercial break');
      return;
    }

    try {
      if (!gameState.barsActive) {
        // ── Entering bars ──
        console.log('🎬 Start Bars requested');

        // Snapshot audio before muting
        const barsAudioSnapshot = [];
        if (atemControl.atem.state && atemControl.atem.state.fairlight && atemControl.atem.state.fairlight.inputs) {
          for (const [inputIndex, input] of Object.entries(atemControl.atem.state.fairlight.inputs)) {
            for (const [sourceKey, source] of Object.entries(input.sources)) {
              const mixOption = source.properties.mixOption;
              barsAudioSnapshot.push({ inputIndex: parseInt(inputIndex), sourceKey, mixOption });
              console.log(`🎬 Bars audio snapshot: input ${inputIndex} source ${sourceKey} mixOption=${mixOption}`);
            }
          }
        }
        gameState.barsAudioSnapshot = barsAudioSnapshot;
        gameState.barsActive = true;

        // Cut to bars so key changes happen off-camera
        console.log('🎬 Cutting to bars...');
        await atemControl.atem.changeProgramInput(1000);
        gameState.atemStatus.currentInput = 1000;

        // Turn off DSK if active
        if (gameState.atemStatus.downstreamKeyEnabled) {
          console.log('🎬 Turning off DSK for bars...');
          await setDownstreamKey(false);
        }

        // Turn off USK if active
        if (gameState.atemStatus.upstreamKeyEnabled) {
          console.log('🎬 Turning off USK for bars...');
          await atemControl.atem.setUpstreamKeyerOnAir(false, 0, 0);
          gameState.atemStatus.upstreamKeyEnabled = false;
        }

        // Mute all inputs except graphics
        console.log('🎬 Muting all audio inputs for bars...');
        for (const ch of barsAudioSnapshot) {
          if (ch.inputIndex !== GRAPHICS_INPUT) {
            await atemControl.atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: 1 });
          }
        }

        saveGameState();
        io.emit('gameUpdate', gameState);
        console.log('🎬 Bars sequence complete');

      } else {
        // ── Leaving bars ──
        console.log('🎬 Stop Bars requested');

        const snapshot = gameState.barsAudioSnapshot || [];
        gameState.barsActive = false;
        gameState.barsAudioSnapshot = [];

        // Switch back to previous camera input
        console.log(`🎬 Switching back to previous input: ${atemControl.previousInput}`);
        await atemControl.atem.changeProgramInput(atemControl.previousInput);
        gameState.atemStatus.currentInput = atemControl.previousInput;

        // Restore all audio inputs to pre-bars state
        if (snapshot.length > 0) {
          console.log('🎬 Restoring audio from bars snapshot...');
          for (const ch of snapshot) {
            if (ch.inputIndex !== GRAPHICS_INPUT) {
              console.log(`🎬 Restoring input ${ch.inputIndex} source ${ch.sourceKey} to mixOption=${ch.mixOption}`);
              await atemControl.atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: ch.mixOption });
            }
          }
        }

        saveGameState();
        io.emit('gameUpdate', gameState);
        console.log('🎬 Stop bars sequence complete');
      }
    } catch (error) {
      console.error('Failed to start/stop bars:', error);
    }
  });

  // ── Generic tournament-sync socket events ──
  // One shape for all three providers. `provider` is 'challonge' | 'podium' | 'shufflepolo'.

  socket.on('getSyncConfig', (provider, callback) => {
    const manager = syncProviders[provider];
    if (!manager) return callback({ error: `Unknown sync provider "${provider}"` });
    callback(manager.maskedConfig());
  });

  socket.on('setSyncConfig', (data, callback) => {
    const { provider, ...fields } = data || {};
    const manager = syncProviders[provider];
    if (!manager) return callback({ error: `Unknown sync provider "${provider}"` });
    manager.applyConfigFields(fields);
    manager.saveConfig();
    if (manager.config.enabled) manager.restart();
    callback({ ok: true });
  });

  socket.on('toggleSync', (data, callback) => {
    const { provider, enabled } = data || {};
    const manager = syncProviders[provider];
    if (!manager) return callback({ error: `Unknown sync provider "${provider}"` });
    manager.toggle(enabled);
    if (callback) callback({ ok: true, enabled: manager.config.enabled });
  });

  // Challonge-only extra: no generic equivalent, since only Challonge's API
  // supports listing tournaments visible to a key.
  socket.on('listChallongeTournaments', async (data, callback) => {
    const manager = syncProviders.challonge;
    const apiKey = (data && data.apiKey && data.apiKey !== '••••••••') ? data.apiKey.trim() : manager.config.apiKey;
    if (!apiKey) return callback({ error: 'No API key provided' });
    try {
      const tournaments = await listChallongeTournaments(apiKey);
      callback({ tournaments });
    } catch (e) {
      callback({ error: e.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });

  registerNetworkSocketHandlers(socket);
  registerRtmpSocketHandlers(socket);
  registerSrtSocketHandlers(socket);
  registerSpeedifySocketHandlers(socket);
});

const speedify = startSpeedifyStats(io);

// Clean up speedify + tournament-sync subprocesses on exit
function stopAllSyncProviders() {
  for (const manager of Object.values(syncProviders)) manager.stop();
}
process.on('SIGINT', () => {
  speedify.stop();
  stopAllSyncProviders();
  process.exit();
});
process.on('SIGTERM', () => {
  speedify.stop();
  stopAllSyncProviders();
  process.exit();
});

// Initialize ATEM connection on startup
connectToAtem().catch(error => {
  console.log('ATEM connection failed on startup (this is normal if no ATEM is connected):', error.message);
});

server.listen(PORT, () => {
  console.log(`Scoreboard server running on port ${PORT}`);
  console.log(`Display: http://localhost:${PORT}/display`);
  console.log(`Control: http://localhost:${PORT}/control`);
  console.log(`Network: http://localhost:${PORT}/network`);
  console.log(`Relay:   http://localhost:${PORT}/relay`);
  console.log(`AP Channel: http://localhost:${PORT}/apchannel`);
  console.log(`Bracket:    http://localhost:${PORT}/bracket`);
  console.log(`ATEM IP: ${ATEM_IP} | Graphics Input: ${GRAPHICS_INPUT} | Downstream Key: ${DOWNSTREAM_KEY}`);
});