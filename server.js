const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
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
  gameState.clock = null;
  gameState.penalties = null;
  gameState.timeouts = null;
  saveGameState();
  io.emit('gameUpdate', gameState);
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
  gameState.clock = null;
  saveGameState();
  io.emit('gameUpdate', gameState);
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

// Applies a live snapshot from shufflepolo_sync.js to gameState. Shufflepolo
// reports team1/team2 (not home/away like Podium), but the same
// sidesSwapped-respecting mapping applies.
function applyShufflepoloSnapshot(snapshot) {
  gameState.clock = snapshot.clock || null;

  if (!snapshot.has_game) return;

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

app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
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

app.post('/api/sync/:provider/push', express.json(), (req, res) => {
  const applySnapshot = SYNC_PUSH_HANDLERS[req.params.provider];
  if (!applySnapshot) {
    return res.status(404).json({ error: `"${req.params.provider}" does not accept pushes` });
  }
  try {
    applySnapshot(req.body);
    saveGameState();
    io.emit('gameUpdate', gameState);
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

// HTTP API for score updates (used by keyboard controller)
app.post('/api/score/:side/:change', (req, res) => {
  const { side, change } = req.params;
  const delta = parseInt(change, 10);

  if (!['left', 'right'].includes(side) || isNaN(delta)) {
    return res.status(400).json({ error: 'Invalid side or change value' });
  }

  if (side === 'left') {
    gameState.leftScore = Math.max(0, gameState.leftScore + delta);
  } else {
    gameState.rightScore = Math.max(0, gameState.rightScore + delta);
  }

  saveGameState();
  io.emit('gameUpdate', gameState);
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
  saveGameState();
  io.emit('gameUpdate', gameState);
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
  saveGameState();
  io.emit('gameUpdate', gameState);
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
    if (data.side === 'left') {
      gameState.leftScore = Math.max(0, gameState.leftScore + data.change);
    } else if (data.side === 'right') {
      gameState.rightScore = Math.max(0, gameState.rightScore + data.change);
    }
    saveGameState();
    io.emit('gameUpdate', gameState);
  });
  
  socket.on('swapSides', () => {
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
    saveGameState();
    io.emit('gameUpdate', gameState);
  });
  
  socket.on('resetGame', () => {
    gameState.leftScore = 0;
    gameState.rightScore = 0;
    saveGameState();
    io.emit('gameUpdate', gameState);
  });

  socket.on('navigateMatchup', (data) => {
    navigateGame(data.direction);
  });

  socket.on('loadMatchup', (data) => {
    gameState.leftTeam  = data.leftTeam;
    gameState.rightTeam = data.rightTeam;
    gameState.leftColor  = data.leftColor;
    gameState.rightColor = data.rightColor;
    gameState.leftScore  = 0;
    gameState.rightScore = 0;
    gameState.loadedMatchupIndex = data.matchupIndex ?? null;
    saveGameState();
    io.emit('gameUpdate', gameState);
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