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
  status: null,
  has_game: false,
  feed: [],
  activePresetId: null,
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

let nextFeedId = 1;
function pushFeedEntry(type, fields) {
  gameState.feed.push({ id: nextFeedId++, type, at: new Date().toISOString(), ...fields });
}

function activePenaltyIds(penalties) {
  return new Set((penalties || []).map(p => p.id).filter(id => id != null));
}

function byId(list) {
  return new Map((list || []).filter(e => e.id != null).map(e => [e.id, e]));
}

// Podium's penalty severity enum ("turnover"|"minor"|"major"|"ejection",
// see podium_sync/podium/types.py) doubles as the feed's own vocabulary -
// Shufflepolo's penalty codes are normalized to the same set in
// applyShufflepoloSnapshot. One feedLabel() in scorebug-render.js can then
// render either provider's penalties without knowing which one is live.
function pushPenaltyFeedEntry(side, penalty) {
  const type = penalty.severity === 'turnover' ? 'turnover'
    : penalty.severity === 'minor' ? 'penalty_minor'
    : penalty.severity === 'major' ? 'penalty_major'
    : penalty.severity === 'ejection' ? 'ejection'
    : 'penalty_start'; // unknown severity - fall back rather than drop it
  pushFeedEntry(type, { side, player: penalty.player || null });
}

// Diffs a before/after pair of the fields every mutation site can touch and
// appends feed entries for whatever changed. Generic across providers and
// manual control actions alike - it only looks at gameState shape, never at
// which call site produced the change.
function diffAndLogFeed(before, after, { skipScoreDiff } = {}) {
  if (!skipScoreDiff) {
    // Podium announces the scorer out-of-band via _lastGoal (set only on
    // the specific push for that goal - see applyPodiumSnapshot); fall back
    // to an unattributed goal when it's not there (manual +/- controls,
    // Shufflepolo's score fields, or a Podium push with no player).
    const lastGoal = after._lastGoal;
    if (after.leftScore > before.leftScore) pushFeedEntry('goal', { side: 'left', player: (lastGoal && lastGoal.side === 'home') ? lastGoal.player : null });
    if (after.leftScore < before.leftScore) pushFeedEntry('goal_removed', { side: 'left' });
    if (after.rightScore > before.rightScore) pushFeedEntry('goal', { side: 'right', player: (lastGoal && lastGoal.side === 'away') ? lastGoal.player : null });
    if (after.rightScore < before.rightScore) pushFeedEntry('goal_removed', { side: 'right' });
  }

  const beforeTO = before.timeouts || {};
  const afterTO = after.timeouts || {};
  if (afterTO.left != null && beforeTO.left != null && afterTO.left < beforeTO.left) {
    pushFeedEntry('timeout', { side: 'left' });
  }
  if (afterTO.right != null && beforeTO.right != null && afterTO.right < beforeTO.right) {
    pushFeedEntry('timeout', { side: 'right' });
  }

  for (const side of ['left', 'right']) {
    const beforeIds = activePenaltyIds(before.penalties && before.penalties[side]);
    const afterPenalties = (after.penalties && after.penalties[side]) || [];
    for (const penalty of afterPenalties) {
      if (penalty.id != null && !beforeIds.has(penalty.id)) pushPenaltyFeedEntry(side, penalty);
    }
  }

  // Shufflepolo-only: full cumulative goals/penalties/timeouts logs, set by
  // applyShufflepoloSnapshot. Diffed by id against the previous push's log
  // rather than against gameState.penalties/leftScore - Shufflepolo's
  // penalty log is historical (never shrinks, unlike Podium's "active
  // right now" list) and goals need per-scorer attribution the plain score
  // diff above can't give, so this entirely replaces the generic score/
  // penalty diff for whichever sides Shufflepolo is driving.
  const beforeRaw = before._rawEvents;
  const afterRaw = after._rawEvents;
  if (afterRaw) {
    const beforeGoals = byId(beforeRaw && beforeRaw.goals);
    for (const goal of afterRaw.goals) {
      if (!beforeGoals.has(goal.id)) pushFeedEntry('goal', { side: goal.side, player: goal.player });
    }
    const beforeTimeouts = byId(beforeRaw && beforeRaw.timeouts);
    for (const timeout of afterRaw.timeouts) {
      if (!beforeTimeouts.has(timeout.id)) pushFeedEntry('timeout', { side: timeout.side });
    }
    const beforePenalties = byId(beforeRaw && beforeRaw.penalties);
    for (const penalty of afterRaw.penalties) {
      if (!beforePenalties.has(penalty.id)) pushPenaltyFeedEntry(penalty.side, penalty);
    }
  }

  const beforePhase = before.clock && before.clock.phase;
  const afterPhase = after.clock && after.clock.phase;
  if (afterPhase && beforePhase && afterPhase !== beforePhase) {
    pushFeedEntry('period', { phase: afterPhase });
  }

  const beforeLive = before.status === 'in_progress';
  const afterLive = after.status === 'in_progress';
  // Shufflepolo has no status field - has_game is the closest proxy for
  // "a game is on court right now" that provider exposes.
  const beforeHasGame = before.status != null ? beforeLive : before.has_game;
  const afterHasGame = after.status != null ? afterLive : after.has_game;

  if (beforeHasGame && !afterHasGame) {
    pushFeedEntry('game_end', { leftTeam: after.leftTeam, rightTeam: after.rightTeam, leftScore: after.leftScore, rightScore: after.rightScore });
  } else if (!beforeHasGame && afterHasGame) {
    pushFeedEntry('game_start', { leftTeam: after.leftTeam, rightTeam: after.rightTeam });
  }
}

// Every mutation site should go through this rather than calling
// saveGameState()/io.emit() directly, so the feed diff always runs against
// a consistent before/after snapshot and every site gets it for free.
function commitGameState(mutate, { skipScoreDiff } = {}) {
  const before = {
    leftScore: gameState.leftScore,
    rightScore: gameState.rightScore,
    timeouts: gameState.timeouts ? { ...gameState.timeouts } : null,
    penalties: gameState.penalties
      ? { left: [...(gameState.penalties.left || [])], right: [...(gameState.penalties.right || [])] }
      : null,
    clock: gameState.clock ? { phase: gameState.clock.phase } : null,
    status: gameState.status,
    has_game: gameState.has_game,
    _lastGoal: null, // Podium's goal attribution is per-push, not cumulative - never diffed against a prior "before"
    _rawEvents: gameState._rawEvents
      ? {
          goals: [...gameState._rawEvents.goals],
          timeouts: [...gameState._rawEvents.timeouts],
          penalties: [...gameState._rawEvents.penalties],
        }
      : null,
  };

  mutate();

  diffAndLogFeed(before, gameState, { skipScoreDiff });
  saveGameState();
  io.emit('gameUpdate', gameState);
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
    gameState.status = null;
  });
};

syncProviders.shufflepolo = new SyncManager({
  name: 'shufflepolo',
  dir: path.join(__dirname, 'shufflepolo_sync'),
  script: path.join(__dirname, 'shufflepolo_sync', 'shufflepolo_sync.js'),
  command: 'node',
  configFile: path.join(__dirname, 'shufflepolo-config.json'),
  configDefaults: { tournamentId: '', feedUrl: '', enabled: false },
  requiredFields: ['tournamentId'],
  stateDir: path.join(__dirname, 'shufflepolo_sync', 'state'),
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
    ...(config.feedUrl ? { SHUFFLEPOLO_FEED_URL: config.feedUrl } : {}),
    PUSH_URL: `http://localhost:${PORT}/api/sync/shufflepolo/push`,
  }),
  // No API key - the feed is public/anonymous, nothing to mask.
  maskConfig: (config) => ({
    tournamentId: config.tournamentId,
    feedUrl: config.feedUrl,
    enabled: config.enabled,
  }),
});
syncProviders.shufflepolo.onExit = () => {
  commitGameState(() => {
    gameState.clock = null;
    gameState.has_game = false;
  });
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
  gameState.clock = snapshot.clock || null;
  gameState.status = snapshot.has_game ? snapshot.status : null;
  // Transient, not diffed by id: only set on the specific push that
  // announces a new goal (podium_sync.py's "goal" trigger), so
  // diffAndLogFeed can label that one feed entry with the scorer and never
  // needs to track a cumulative goal log the way Shufflepolo's does.
  gameState._lastGoal = snapshot.last_goal || null;

  if (!snapshot.has_game) {
    gameState.penalties = null;
    gameState.timeouts = null;
    return;
  }

  const homePenalties = (snapshot.penalties && snapshot.penalties.home) || [];
  const awayPenalties = (snapshot.penalties && snapshot.penalties.away) || [];
  const homeTimeouts = snapshot.home.timeouts_left;
  const awayTimeouts = snapshot.away.timeouts_left;

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

// Applies a live snapshot from shufflepolo_sync.js to gameState. Shufflepolo
// reports team1/team2 (not home/away like Podium), but the same
// sidesSwapped-respecting mapping applies. Unlike Podium (which reports only
// currently-active penalties and a single just-happened goal), Shufflepolo's
// feed hands back the game's full cumulative goals/penalties/timeouts logs
// on every push - diffAndLogFeed diffs those by id against what it logged
// last time, same idea as Podium's active-penalty-set diff.
function applyShufflepoloSnapshot(snapshot) {
  // clock_offset_ms rides along on gameState.clock itself (not a separate
  // top-level field) so it survives the existing `{...currentClock,
  // localAnchorAt}` spread in display.html/editor.html without those call
  // sites needing to know about it individually - see computeClockDisplay
  // in scorebug-render.js for how it's used.
  //
  // This is shufflepolo_sync.js's own measured offset (their server's clock
  // minus this device's, from a t0/t1-bracketed round trip against the
  // actual HTTP request - see updateClockOffset there), NOT a raw
  // server_now timestamp. Per a Shufflepolo dev's own analysis of our
  // drift: computing "now minus server_now" this far downstream (after
  // this process's own POST to this server, then this server's socket
  // broadcast to the browser) would measure the offset against a
  // server_now that's already stale by however long those extra hops
  // took, re-introducing per-hop timing error on every single push. The
  // offset is measured once, close to the real round trip, and only ever
  // added from here on - nothing downstream recomputes it.
  gameState.clock = snapshot.clock ? { ...snapshot.clock, clock_offset_ms: snapshot.clock_offset_ms ?? null } : null;
  gameState.has_game = !!snapshot.has_game;

  // Deliberately NOT resetting _rawEvents to null here. has_game flips to
  // false any time Shufflepolo's live[] briefly comes up empty (between
  // games, or a transient gap in what their feed considers "live" right
  // now) - nulling the goals/penalties/timeouts log on every such blip
  // means the NEXT has_game:true push has no prior history to diff
  // against, so diffAndLogFeed (which only looks at ids it already knows
  // about) treats every goal/penalty the game has ever had as brand new
  // and replays the whole match into the kill feed at once. Keeping the
  // last known log around means a genuinely new game (different goal ids
  // entirely) still diffs correctly - its first push just logs all of
  // its own goals as new, same as any other id was never seen.
  if (!snapshot.has_game) return;

  const sideForTeamId = (teamId) => {
    const isTeam1 = teamId === snapshot.team1_id;
    if (gameState.sidesSwapped) return isTeam1 ? 'right' : 'left';
    return isTeam1 ? 'left' : 'right';
  };

  gameState._rawEvents = {
    goals: (snapshot.goals || []).map(g => ({
      id: g.id,
      side: sideForTeamId(g.team_id),
      player: g.player ? g.player.name : null,
    })),
    timeouts: (snapshot.timeouts || []).map(t => ({
      id: t.id,
      side: sideForTeamId(t.team_id),
    })),
    penalties: (snapshot.penalties || []).map(p => ({
      id: p.id,
      side: sideForTeamId(p.team_id),
      player: p.player ? p.player.name : null,
      severity: SHUFFLEPOLO_PENALTY_CODE[p.code] || p.code,
    })),
  };

  if (gameState.sidesSwapped) {
    gameState.leftTeam = snapshot.team2.name;
    gameState.rightTeam = snapshot.team1.name;
    gameState.leftScore = snapshot.team2.score;
    gameState.rightScore = snapshot.team1.score;
  } else {
    gameState.leftTeam = snapshot.team1.name;
    gameState.rightTeam = snapshot.team2.name;
    gameState.leftScore = snapshot.team1.score;
    gameState.rightScore = snapshot.team2.score;
  }
}

for (const manager of Object.values(syncProviders)) {
  manager.loadConfig();
  if (manager.config.enabled) manager.start();
}

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
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

app.get('/editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

app.get('/network', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'network.html'));
});

app.get('/apchannel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'apchannel.html'));
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

// Shufflepolo's score changes are fully covered by its own cumulative
// `goals` log (diffed in diffAndLogFeed via _rawEvents, with scorer
// attribution) - running the generic score diff too would double-log every
// goal. Podium has no such log (only a per-push _lastGoal), so it still
// needs the generic diff.
const SYNC_PUSH_OPTIONS = {
  shufflepolo: { skipScoreDiff: true },
};

app.post('/api/sync/:provider/push', express.json(), (req, res) => {
  const applySnapshot = SYNC_PUSH_HANDLERS[req.params.provider];
  if (!applySnapshot) {
    return res.status(404).json({ error: `"${req.params.provider}" does not accept pushes` });
  }
  try {
    commitGameState(() => applySnapshot(req.body), SYNC_PUSH_OPTIONS[req.params.provider]);
    res.json({ ok: true });
  } catch (error) {
    console.error(`Error applying ${req.params.provider} push:`, error);
    res.status(400).json({ error: error.message });
  }
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  }, { skipScoreDiff: true });
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
    pushFeedEntry('game_start', { leftTeam: gameState.leftTeam, rightTeam: gameState.rightTeam });
  }, { skipScoreDiff: true });
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

io.on('connection', (socket) => {
  console.log('Client connected');
  
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
    }, { skipScoreDiff: true });
  });

  socket.on('resetGame', () => {
    commitGameState(() => {
      gameState.leftScore = 0;
      gameState.rightScore = 0;
    }, { skipScoreDiff: true });
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
      pushFeedEntry('game_start', { leftTeam: gameState.leftTeam, rightTeam: gameState.rightTeam });
    }, { skipScoreDiff: true });
  });

  // Instant cut, by design: setting activePresetId goes through the same
  // commitGameState -> saveGameState -> io.emit('gameUpdate') pipeline as
  // everything else, so display.html's next full-state render just swaps
  // its whole layout. No separate transition/animation mechanism.
  socket.on('setActivePreset', (data) => {
    commitGameState(() => {
      gameState.activePresetId = data.presetId || null;
    });
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
  console.log(`AP Channel: http://localhost:${PORT}/apchannel`);
  console.log(`Bracket:    http://localhost:${PORT}/bracket`);
  console.log(`ATEM IP: ${ATEM_IP} | Graphics Input: ${GRAPHICS_INPUT} | Downstream Key: ${DOWNSTREAM_KEY}`);
});