const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { Atem } = require('atem-connection');
const { spawn, exec, execFile } = require('child_process');
const { SyncManager } = require('./lib/sync');

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

// ATEM connection
let atem = null;
let atemConnected = false;
let previousInput = 1; // Track previous input to switch back to

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

// ATEM Control Functions
async function connectToAtem() {
  if (atem) {
    return;
  }

  try {
    console.log(`Connecting to ATEM at ${ATEM_IP}...`);
    atem = new Atem();

    atem.on('connected', () => {
      console.log('✅ Connected to ATEM switcher');
      atemConnected = true;
      gameState.atemStatus.connected = true;

      // Get current state
      const state = atem.state;
      if (state && state.video && state.video.mixEffects && state.video.mixEffects[0]) {
        gameState.atemStatus.currentInput = state.video.mixEffects[0].programInput;
        previousInput = gameState.atemStatus.currentInput;
        console.log(`Current ATEM input: ${gameState.atemStatus.currentInput}`);
      }

      if (state && state.video && state.video.downstreamKeyers && state.video.downstreamKeyers[DOWNSTREAM_KEY - 1]) {
        gameState.atemStatus.downstreamKeyEnabled = state.video.downstreamKeyers[DOWNSTREAM_KEY - 1].onAir;
        console.log(`Downstream key ${DOWNSTREAM_KEY} status: ${gameState.atemStatus.downstreamKeyEnabled ? 'ON' : 'OFF'}`);
      }

      if (state && state.video && state.video.mixEffects && state.video.mixEffects[0] && state.video.mixEffects[0].upstreamKeyers) {
        gameState.atemStatus.upstreamKeyEnabled = state.video.mixEffects[0].upstreamKeyers[0]?.onAir || false;
        console.log(`Upstream key status: ${gameState.atemStatus.upstreamKeyEnabled ? 'ON' : 'OFF'}`);
      }

      saveGameState();
      io.emit('gameUpdate', gameState);
    });

    atem.on('disconnected', () => {
      console.log('❌ Disconnected from ATEM switcher');
      atemConnected = false;
      gameState.atemStatus.connected = false;
      saveGameState();
      io.emit('gameUpdate', gameState);
    });

    atem.on('error', (error) => {
      console.error('ATEM connection error:', error);
      atemConnected = false;
      gameState.atemStatus.connected = false;
      saveGameState();
      io.emit('gameUpdate', gameState);
    });

    // Listen for ATEM state changes
    atem.on('stateChanged', (state, pathToChange) => {
      console.log('🔄 ATEM state changed:', pathToChange);

      // Check for DSK state changes
      if (pathToChange.includes('video.downstreamKeyers')) {
        const keyIndex = DOWNSTREAM_KEY - 1;
        const dskState = state.video?.downstreamKeyers?.[keyIndex]?.onAir || false;
        console.log(`🔄 DSK ${DOWNSTREAM_KEY} state changed to: ${dskState ? 'ON' : 'OFF'}`);

        // Update our game state to match ATEM reality
        gameState.atemStatus.downstreamKeyEnabled = dskState;
        saveGameState();
        io.emit('gameUpdate', gameState);
      }

      // Check for USK state changes
      if (pathToChange.includes('video.mixEffects.0.upstreamKeyers')) {
        const uskState = state.video?.mixEffects?.[0]?.upstreamKeyers?.[0]?.onAir || false;
        console.log(`🔄 USK state changed to: ${uskState ? 'ON' : 'OFF'}`);

        gameState.atemStatus.upstreamKeyEnabled = uskState;
        saveGameState();
        io.emit('gameUpdate', gameState);
      }

      // Check for input changes
      if (pathToChange.includes('video.mixEffects.0.programInput')) {
        const currentInput = state.video?.mixEffects?.[0]?.programInput;
        if (currentInput && currentInput !== gameState.atemStatus.currentInput) {
          console.log(`🔄 ATEM input changed to: ${currentInput}`);
          gameState.atemStatus.currentInput = currentInput;
          saveGameState();
          io.emit('gameUpdate', gameState);
        }
      }
    });

    await atem.connect(ATEM_IP);
  } catch (error) {
    console.error('Failed to connect to ATEM:', error);
    atemConnected = false;
    gameState.atemStatus.connected = false;
    saveGameState();
    io.emit('gameUpdate', gameState);
  }
}

async function switchToGraphicsInput() {
  if (!atem || !atemConnected) {
    console.log('ATEM not connected - cannot switch to graphics input');
    return false;
  }

  try {
    // Store current input before switching (but only if it's not already the graphics input)
    const currentState = atem.state;
    if (currentState && currentState.video && currentState.video.mixEffects && currentState.video.mixEffects[0]) {
      const currentInput = currentState.video.mixEffects[0].programInput;

      // Internal ATEM inputs that should never be restored to after a break:
      // 0=Black, 1000=Bars, 2001=Color1, 2002=Color2
      const internalInputs = [0, 1000, 2001, 2002];
      if (currentInput === GRAPHICS_INPUT) {
        console.log(`Current input ${currentInput} is graphics input - keeping previous input: ${previousInput}`);
      } else if (internalInputs.includes(currentInput)) {
        console.log(`Current input ${currentInput} is an internal source (black/bars/color) - defaulting previous input to camera 2`);
        previousInput = 2;
      } else {
        previousInput = currentInput;
        console.log(`Storing previous input: ${previousInput}`);
      }

      gameState.atemStatus.currentInput = currentInput;
    }

    // Switch to graphics input using auto transition
    console.log(`Auto transitioning ATEM to graphics input ${GRAPHICS_INPUT}`);
    await atem.changePreviewInput(GRAPHICS_INPUT);
    await atem.autoTransition();
    gameState.atemStatus.currentInput = GRAPHICS_INPUT;

    saveGameState();
    return true;
  } catch (error) {
    console.error('Failed to switch to graphics input:', error);
    return false;
  }
}

async function switchToPreviousInput() {
  if (!atem || !atemConnected) {
    console.log('ATEM not connected - cannot switch to previous input');
    return false;
  }

  try {
    // Safety check: Don't switch back to graphics input
    if (previousInput === GRAPHICS_INPUT) {
      console.log(`Previous input ${previousInput} is graphics input - defaulting to input 2`);
      previousInput = 2; // Default to camera 2
    }

    console.log(`Direct cut ATEM back to previous input ${previousInput} (avoiding auto transition)`);
    await atem.changeProgramInput(previousInput);
    gameState.atemStatus.currentInput = previousInput;

    saveGameState();
    return true;
  } catch (error) {
    console.error('Failed to switch to previous input:', error);
    return false;
  }
}

async function setDownstreamKey(enabled) {
  if (!atem || !atemConnected) {
    console.log('ATEM not connected - cannot control downstream key');
    return false;
  }

  try {
    const keyIndex = DOWNSTREAM_KEY - 1;
    console.log(`🔧 Setting downstream key ${DOWNSTREAM_KEY} (index ${keyIndex}) to ${enabled ? 'ON' : 'OFF'}`);

    // Check current state before sending command
    const currentState = atem.state;
    const currentDSKState = currentState?.video?.downstreamKeyers?.[keyIndex]?.onAir || false;
    console.log(`🔧 Current ATEM DSK state: ${currentDSKState ? 'ON' : 'OFF'} -> Target: ${enabled ? 'ON' : 'OFF'}`);

    // For DSK ON, try auto transition instead of direct command
    if (enabled && !currentDSKState) {
      console.log(`🔧 DSK is OFF, trying auto transition to turn ON`);
      try {
        await atem.autoDownstreamKey(keyIndex);
        console.log(`🔧 ATEM autoDownstreamKey command sent successfully`);
      } catch (autoErr) {
        console.log(`🔧 autoDownstreamKey failed, trying direct command:`, autoErr.message);
        await atem.setDownstreamKeyOnAir(keyIndex, enabled);
        console.log(`🔧 ATEM setDownstreamKeyOnAir command sent successfully`);
      }
    } else if (currentDSKState !== enabled) {
      // For DSK OFF, use direct command only if state needs to change
      await atem.setDownstreamKeyOnAir(keyIndex, enabled);
      console.log(`🔧 ATEM setDownstreamKeyOnAir command sent successfully`);
    } else {
      console.log(`🔧 DSK already in target state - skipping command`);
    }

    // Wait a moment and check if it actually changed
    setTimeout(async () => {
      try {
        const newState = atem.state;
        const newDSKState = newState?.video?.downstreamKeyers?.[keyIndex]?.onAir || false;
        console.log(`🔧 ATEM DSK state after command: ${newDSKState ? 'ON' : 'OFF'} (expected: ${enabled ? 'ON' : 'OFF'})`);
      } catch (e) {
        console.log('🔧 Could not read ATEM state after DSK command');
      }
    }, 1000);

    gameState.atemStatus.downstreamKeyEnabled = enabled;
    saveGameState();
    return true;
  } catch (error) {
    console.error('Failed to control downstream key:', error);
    return false;
  }
}

async function fadeDownstreamKey(fadeIn = true) {
  if (!atem || !atemConnected) {
    console.log('ATEM not connected - cannot fade downstream key');
    return false;
  }

  try {
    const keyIndex = DOWNSTREAM_KEY - 1;
    console.log(`${fadeIn ? 'Fading in' : 'Fading out'} downstream key ${DOWNSTREAM_KEY}`);

    // Get current DSK state
    const currentState = atem.state;
    const currentDSKState = currentState?.video?.downstreamKeyers?.[keyIndex]?.onAir || false;

    console.log(`Current DSK state: ${currentDSKState ? 'ON' : 'OFF'}, Target state: ${fadeIn ? 'ON' : 'OFF'}`);

    // Only auto transition if we need to change state
    if (currentDSKState !== fadeIn) {
      console.log('DSK state needs to change - triggering auto transition');
      await atem.autoDownstreamKey(keyIndex, fadeIn);
    } else {
      console.log('DSK already in target state - no transition needed');
    }

    // Update our game state
    gameState.atemStatus.downstreamKeyEnabled = fadeIn;
    saveGameState();
    return true;
  } catch (error) {
    console.error('Failed to fade downstream key:', error);
    return false;
  }
}

// ── AP Channel Helper ──

const VALID_5GHZ_CHANNELS = [36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165];

function freqToChannel(ghz) {
  const mhz = Math.round(ghz * 1000);
  if (mhz >= 5180 && mhz <= 5825) return Math.round((mhz - 5000) / 5);
  if (mhz >= 2412 && mhz <= 2484) return Math.round((mhz - 2407) / 5);
  return null;
}

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

app.get('/bracket-viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bracket-viewer.html'));
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
  if (!atem || !atemConnected) return res.status(503).json({ error: 'ATEM not connected' });
  try {
    console.log(`Direct cut to input: ${input}`);
    await atem.changeProgramInput(input);
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
    } else if (atemConnected && atem.state && atem.state.fairlight && atem.state.fairlight.inputs) {
      const inputs = atem.state.fairlight.inputs;
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
    if (atemConnected) {
      console.log('🎬 ATEM: Starting commercial break sequence...');

      // Step 1: Turn off USK if it was active
      if (uskWasActive) {
        console.log('🎬 Turning off USK for commercial break...');
        await atem.setUpstreamKeyerOnAir(false, 0, 0);
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
          await atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: 1 }); // 1 = Off
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
    if (atemConnected) {
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
      await atem.setUpstreamKeyerOnAir(true, 0, 0);
      gameState.atemStatus.upstreamKeyEnabled = true;

      // Step 5: Restore HDMI camera inputs only (inputs 2-4); leave mics muted for manual restore
      if (audioSnapshot.length > 0) {
        console.log('🎬 Restoring camera audio inputs after commercial break...');
        for (const ch of audioSnapshot) {
          if (ch.inputIndex !== GRAPHICS_INPUT) {
            console.log(`🎬 Restoring input ${ch.inputIndex} source ${ch.sourceKey} to mixOption=${ch.mixOption}`);
            await atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: ch.mixOption });
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
    if (!atem || !atemConnected) {
      console.log('ATEM not connected - cannot switch input');
      return;
    }

    try {
      console.log(`Manual auto transition to input: ${data.input}`);
      await atem.changePreviewInput(data.input);
      await atem.autoTransition();
      gameState.atemStatus.currentInput = data.input;
      saveGameState();
      io.emit('gameUpdate', gameState);
    } catch (error) {
      console.error('Failed to auto transition input:', error);
    }
  });

  socket.on('atemToggleDownstreamKey', async () => {
    console.log('🔧 MANUAL DSK TOGGLE REQUESTED - someone clicked the button');
    if (!atem || !atemConnected) {
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
    if (!atem || !atemConnected) {
      console.log('ATEM not connected - cannot toggle upstream key');
      return;
    }

    const newState = !gameState.atemStatus.upstreamKeyEnabled;
    console.log(`🔧 USK toggle: ${gameState.atemStatus.upstreamKeyEnabled ? 'ON' : 'OFF'} -> ${newState ? 'ON' : 'OFF'}`);
    try {
      await atem.setUpstreamKeyerOnAir(newState, 0, 0);
      gameState.atemStatus.upstreamKeyEnabled = newState;
      saveGameState();
      io.emit('gameUpdate', gameState);
    } catch (error) {
      console.error('Failed to toggle upstream key:', error);
    }
  });

  socket.on('atemStartBars', async () => {
    if (!atem || !atemConnected) {
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
        if (atem.state && atem.state.fairlight && atem.state.fairlight.inputs) {
          for (const [inputIndex, input] of Object.entries(atem.state.fairlight.inputs)) {
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
        await atem.changeProgramInput(1000);
        gameState.atemStatus.currentInput = 1000;

        // Turn off DSK if active
        if (gameState.atemStatus.downstreamKeyEnabled) {
          console.log('🎬 Turning off DSK for bars...');
          await setDownstreamKey(false);
        }

        // Turn off USK if active
        if (gameState.atemStatus.upstreamKeyEnabled) {
          console.log('🎬 Turning off USK for bars...');
          await atem.setUpstreamKeyerOnAir(false, 0, 0);
          gameState.atemStatus.upstreamKeyEnabled = false;
        }

        // Mute all inputs except graphics
        console.log('🎬 Muting all audio inputs for bars...');
        for (const ch of barsAudioSnapshot) {
          if (ch.inputIndex !== GRAPHICS_INPUT) {
            await atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: 1 });
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
        console.log(`🎬 Switching back to previous input: ${previousInput}`);
        await atem.changeProgramInput(previousInput);
        gameState.atemStatus.currentInput = previousInput;

        // Restore all audio inputs to pre-bars state
        if (snapshot.length > 0) {
          console.log('🎬 Restoring audio from bars snapshot...');
          for (const ch of snapshot) {
            if (ch.inputIndex !== GRAPHICS_INPUT) {
              console.log(`🎬 Restoring input ${ch.inputIndex} source ${ch.sourceKey} to mixOption=${ch.mixOption}`);
              await atem.setFairlightAudioMixerSourceProps(ch.inputIndex, BigInt(ch.sourceKey), { mixOption: ch.mixOption });
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

  // ── AP Channel Management ──

  socket.on('getApConfig', (callback) => {
    exec('cat /etc/hostapd/hostapd.conf', (err, stdout) => {
      if (err) return callback({ error: err.message });
      const chMatch = stdout.match(/^channel=(\d+)/m);
      const htMatch = stdout.match(/^ht_capab=(.+)/m);
      const channel = chMatch ? parseInt(chMatch[1]) : null;
      const htCapab = htMatch ? htMatch[1].trim() : '';
      callback({ channel, htCapab });
    });
  });

  socket.on('setApChannel', (data, callback) => {
    const ch = parseInt(data.channel);
    if (!VALID_5GHZ_CHANNELS.includes(ch)) {
      return callback({ error: 'Invalid channel number' });
    }
    // Validate channel is compatible with ht_capab before writing
    exec('cat /etc/hostapd/hostapd.conf', (err0, conf) => {
      if (!err0) {
        const htMatch = conf.match(/^ht_capab=(.+)/m);
        const htCapab = htMatch ? htMatch[1] : '';
        const hasPlus  = htCapab.includes('[HT40+]');
        const hasMinus = htCapab.includes('[HT40-]');
        const ht40PlusOnly  = [36,44,52,60,100,108,116,124,132,140,149,157];
        const ht40MinusOnly = [40,48,56,64,104,112,120,128,136,144,153,161];
        if (hasPlus && !hasMinus && !ht40PlusOnly.includes(ch)) {
          return callback({ error: `Channel ${ch} is not valid for HT40+ mode. Valid channels: ${ht40PlusOnly.join(', ')}` });
        }
        if (hasMinus && !hasPlus && !ht40MinusOnly.includes(ch)) {
          return callback({ error: `Channel ${ch} is not valid for HT40- mode. Valid channels: ${ht40MinusOnly.join(', ')}` });
        }
      }
      exec(`sudo sed -i 's/^channel=.*/channel=${ch}/' /etc/hostapd/hostapd.conf`, (err) => {
        if (err) return callback({ error: 'Failed to update hostapd.conf: ' + err.message });
        exec('sudo systemctl restart hostapd', (err2) => {
          if (err2) return callback({ error: 'Channel written but hostapd restart failed: ' + err2.message });
          console.log(`AP channel changed to ${ch}`);
          callback({ success: true, channel: ch });
        });
      });
    });
  });

  socket.on('scanApChannels', (data, callback) => {
    const iface = data.iface;
    if (!iface || /[;&|`$<>]/.test(iface)) return callback({ error: 'Invalid interface name' });
    exec(`sudo iwlist "${iface}" scan 2>&1`, { timeout: 20000 }, (err, stdout) => {
      if (err && !stdout) return callback({ error: err.message });
      // Parse each Cell block
      const channels = {};
      const blocks = stdout.split(/(?=\s*Cell \d+)/);
      blocks.forEach(block => {
        const chMatch = block.match(/Channel:(\d+)/);
        const essidMatch = block.match(/ESSID:"([^"]*)"/);
        const signalMatch = block.match(/Signal level=(-?\d+)/);
        const freqMatch = block.match(/Frequency:([\d.]+)/);
        if (!chMatch) return;
        const ch = parseInt(chMatch[1]);
        const freq = freqMatch ? parseFloat(freqMatch[1]) : 0;
        if (freq < 5) return; // skip 2.4 GHz
        const essid = essidMatch ? essidMatch[1] : '(hidden)';
        const signal = signalMatch ? parseInt(signalMatch[1]) : null;
        if (!channels[ch]) channels[ch] = [];
        channels[ch].push({ essid, signal });
      });
      callback({ channels });
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });

  // ── Network Dashboard: WiFi Management ──

  socket.on('getInterfaces', (callback) => {
    exec('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status', (err, stdout) => {
      if (err) {
        console.error('nmcli dev status error:', err.message);
        return callback({ error: err.message });
      }
      const interfaces = [];
      stdout.trim().split('\n').forEach(line => {
        // nmcli -t uses : as separator, but connection names can contain colons
        // Format: DEVICE:TYPE:STATE:CONNECTION
        const parts = line.split(':');
        if (parts.length < 4) return;
        const dev = parts[0];
        const type = parts[1];
        const state = parts[2];
        const con = parts.slice(3).join(':');
        if (dev === 'lo' || type === 'wifi-p2p' || type === 'tun' || type === 'bridge') return;
        interfaces.push({ device: dev, type, state, connection: con === '--' ? '' : con });
      });
      callback({ interfaces });
    });
  });

  socket.on('getWifiNetworks', (data, callback) => {
    const iface = data.iface;
    if (!iface || /[;&|`$]/.test(iface)) {
      return callback({ error: 'Invalid interface name' });
    }

    // Get the active NM connection profile name (used by reconnectPrevious)
    execFile('sudo', ['nmcli', '-t', '-f', 'GENERAL.CONNECTION', 'dev', 'show', iface], (_, devOut) => {
      const previousCon = (devOut || '').match(/^GENERAL\.CONNECTION:(.+)$/m)?.[1]?.trim() || '';
      const previousConnection = previousCon === '--' ? '' : previousCon;

      // Scan via NM
      execFile('sudo', ['nmcli', '-t', '-f', 'SSID,BSSID,SECURITY,SIGNAL', 'dev', 'wifi', 'list', 'ifname', iface, '--rescan', 'yes'],
        { timeout: 15000 }, (err2, stdout2) => {
        if (err2 && !stdout2) {
          return callback({ error: err2.message, previousConnection });
        }

        const seen = new Set();
        const ssids = [];
        (stdout2 || '').split('\n').forEach(line => {
          // nmcli -t output: SSID:BSSID:SECURITY:SIGNAL — colons in SSID are escaped as \:
          const parts = line.split(/(?<!\\):/g);
          const ssid = parts[0]?.replace(/\\:/g, ':').trim();
          if (!ssid || ssid === 'switcher_net' || seen.has(ssid)) return;
          seen.add(ssid);
          ssids.push(ssid);
        });

        // Get saved NM WiFi profiles to mark known networks
        execFile('sudo', ['nmcli', '-t', '-f', 'NAME,TYPE', 'con', 'show'], (_, conOut) => {
          const savedNames = new Set();
          (conOut || '').split('\n').forEach(line => {
            const [name, type] = line.split(':');
            if (type?.trim() === '802-11-wireless') savedNames.add(name?.trim());
          });

          const results = ssids.map(ssid => ({ ssid, saved: savedNames.has(ssid) }));
          callback({ networks: results, previousConnection });
        });
      });
    });
  });

  socket.on('connectWifi', (data, callback) => {
    const { iface, ssid, passphrase } = data;
    if (!iface || !ssid || /[;&|`$]/.test(iface)) {
      return callback({ error: 'Invalid parameters' });
    }

    console.log(`Connecting ${iface} to ${ssid} via nmcli`);

    // Rescan on this specific interface so nmcli's cache is fresh before connecting
    execFile('sudo', ['nmcli', 'dev', 'wifi', 'list', 'ifname', iface, '--rescan', 'yes'], { timeout: 15000 }, () => {

    // Find any saved profile for this SSID so we can clear its interface lock
    execFile('sudo', ['nmcli', '-t', '-f', 'NAME,TYPE', 'con', 'show'], (_, conOut) => {
      let savedProfile = null;
      (conOut || '').split('\n').forEach(line => {
        const [name, type] = line.split(':');
        if (type?.trim() === '802-11-wireless' && name?.trim() === ssid) {
          savedProfile = name.trim();
        }
      });

      function doConnect() {
        const args = passphrase
          ? ['dev', 'wifi', 'connect', ssid, 'password', passphrase, 'ifname', iface]
          : ['dev', 'wifi', 'connect', ssid, 'ifname', iface];

        execFile('sudo', ['nmcli', ...args], { timeout: 60000 }, (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || stdout || err.message || '').trim();
            console.error(`nmcli connect error for ${ssid}:`, msg);
            return callback({ error: msg || `Failed to connect to ${ssid}` });
          }
          console.log(`WiFi connected: ${iface} -> ${ssid}`, stdout.trim());
          callback({ success: true, message: `Connected to ${ssid}` });
        });
      }

      if (savedProfile) {
        // Saved profile: clear interface lock, then bring it up on the requested iface
        execFile('sudo', ['nmcli', 'con', 'modify', savedProfile, 'connection.interface-name', ''], () => {
          execFile('sudo', ['nmcli', 'con', 'up', savedProfile, 'ifname', iface], { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || stdout || err.message || '').trim();
              console.error(`nmcli con up error for ${ssid}:`, msg);
              return callback({ error: msg || `Failed to connect to ${ssid}` });
            }
            console.log(`WiFi connected (saved): ${iface} -> ${ssid}`);
            callback({ success: true, message: `Connected to ${ssid}` });
          });
        });
      } else {
        doConnect();
      }
    }); // end con show
    }); // end rescan
  });

  socket.on('reconnectPrevious', (data, callback) => {
    const conName = data.connectionName;
    const iface = data.iface || '';
    if (!conName) {
      return callback({ error: 'No previous connection name' });
    }
    const safeCon = conName.replace(/'/g, "'\\''");
    const safeIface = iface.replace(/'/g, "'\\''");
    const ifaceArg = iface ? ` ifname "${safeIface}"` : '';
    exec(`sudo nmcli con up '${safeCon}'${ifaceArg}`, (err) => {
      if (err) {
        console.error('Reconnect error:', err.message);
        return callback({ error: err.message });
      }
      console.log(`WiFi reconnected to: ${conName}${iface ? ' on ' + iface : ''}`);
      callback({ success: true, message: `Reconnected to ${conName}` });
    });
  });

  // ── Network Dashboard: Speedify One-Shot Data ──

  socket.on('getSpeedifyState', (callback) => {
    exec('speedify_cli state', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ data: stdout.trim() }); }
    });
  });

  socket.on('getSpeedifyAdapters', (callback) => {
    exec('speedify_cli show adapters', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ error: 'Parse error' }); }
    });
  });

  socket.on('getSpeedifyServer', (callback) => {
    exec('speedify_cli show currentserver', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ error: 'Parse error' }); }
    });
  });

  socket.on('getSpeedifySettings', (callback) => {
    exec('speedify_cli show settings', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ error: 'Parse error' }); }
    });
  });

  socket.on('runStreamTest', (callback) => {
    exec('speedify_cli streamtest', { timeout: 90000 }, (err, stdout, stderr) => {
      if (err) return callback({ error: err.message + (stderr ? ' | ' + stderr.trim() : '') });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ data: stdout.trim() }); }
    });
  });

  // ── iPhone pairing ──

  const IPHONE_NAMES_FILE = path.join(__dirname, 'iphone-names.json');

  function loadIphoneNames() {
    try { return JSON.parse(fs.readFileSync(IPHONE_NAMES_FILE, 'utf8')); } catch (e) { return {}; }
  }
  function saveIphoneNames(names) {
    try { fs.writeFileSync(IPHONE_NAMES_FILE, JSON.stringify(names, null, 2)); } catch (e) {}
  }

  socket.on('getIphones', (callback) => {
    const nameCache = loadIphoneNames();
    exec('idevicepair list', (err, pairedOut) => {
      const paired = (pairedOut || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
      exec('idevice_id -l', (err2, connectedOut) => {
        const connected = new Set((connectedOut || '').trim().split('\n').map(s => s.trim()).filter(Boolean));
        let remaining = paired.length;
        if (!remaining) return callback({ phones: [] });
        const phones = [];
        let cacheUpdated = false;
        paired.forEach(udid => {
          exec(`ideviceinfo -u ${udid} -k DeviceName`, { timeout: 5000 }, (e, nameOut) => {
            const fetched = (nameOut || '').trim();
            if (fetched) {
              if (nameCache[udid] !== fetched) { nameCache[udid] = fetched; cacheUpdated = true; }
            }
            const name = nameCache[udid] || 'Unknown';
            phones.push({ udid, name, connected: connected.has(udid) });
            if (--remaining === 0) {
              if (cacheUpdated) saveIphoneNames(nameCache);
              connected.forEach(udid2 => {
                if (!paired.includes(udid2)) {
                  phones.push({ udid: udid2, name: 'Unpaired', connected: true, unpaired: true });
                }
              });
              callback({ phones });
            }
          });
        });
      });
    });
  });

  socket.on('pairIphone', (callback) => {
    exec('idevicepair pair', { timeout: 30000 }, (err, stdout, stderr) => {
      const out = (stdout || '').trim() || (stderr || '').trim();
      if (err && !out.includes('SUCCESS')) return callback({ error: out || err.message });
      callback({ ok: true, message: out });
    });
  });

  const SEND_BUFFER_SCRIPT = '/usr/local/bin/pi-send-buffer.sh';

  socket.on('getNginxStreamDest', (callback) => {
    fs.readFile(SEND_BUFFER_SCRIPT, 'utf8', (err, data) => {
      if (err) return callback({ error: err.message });
      const m = data.match(/^STREAM_URL="(rtmp:\/\/[^"]+)"/m);
      if (!m) return callback({ error: 'No STREAM_URL found in pi-send-buffer.sh' });
      const fullUrl = m[1];
      const lastSlash = fullUrl.lastIndexOf('/');
      const baseUrl = fullUrl.substring(0, lastSlash);
      const streamKey = fullUrl.substring(lastSlash + 1);
      callback({ baseUrl, streamKey, fullUrl });
    });
  });

  socket.on('setNginxStreamDest', ({ baseUrl, streamKey }, callback) => {
    if (!baseUrl || !streamKey) return callback({ error: 'baseUrl and streamKey are required' });
    if (!/^rtmp:\/\/[a-zA-Z0-9._\-/:]+$/.test(baseUrl)) return callback({ error: 'Invalid base URL' });
    if (!/^[a-zA-Z0-9._\-]+$/.test(streamKey)) return callback({ error: 'Invalid stream key' });
    const newUrl = `${baseUrl}/${streamKey}`;

    fs.readFile(SEND_BUFFER_SCRIPT, 'utf8', (err, data) => {
      if (err) return callback({ error: 'Failed to read script: ' + err.message });
      if (!/^STREAM_URL="rtmp:\/\/[^"]+"/m.test(data)) return callback({ error: 'Could not locate STREAM_URL in script' });
      const updated = data.replace(/^(STREAM_URL=")rtmp:\/\/[^"]+(")/m, `$1${newUrl}$2`);

      const proc = exec(`sudo tee ${SEND_BUFFER_SCRIPT}`, (err2) => {
        if (err2) return callback({ error: 'Failed to write script: ' + err2.message });
        callback({ ok: true });
      });
      proc.stdin.write(updated);
      proc.stdin.end();
    });
  });
});

// ── Speedify Live Stats Subprocess ──

let speedifyProc = null;

function startSpeedifyStats() {
  if (speedifyProc) return;
  console.log('Starting speedify_cli stats subprocess...');

  speedifyProc = spawn('speedify_cli', ['-s', 'stats']);
  let buffer = '';

  speedifyProc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    lines.forEach(line => {
      line = line.trim();
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        // Output format is ["type", {data}] arrays
        if (Array.isArray(parsed) && parsed.length === 2) {
          const msg = parsed[1];
          msg.type = parsed[0];
          io.emit('speedifyStats', msg);
        }
      } catch (e) {
        // not valid JSON, skip
      }
    });
  });

  speedifyProc.stderr.on('data', (chunk) => {
    console.error('speedify_cli stderr:', chunk.toString());
  });

  speedifyProc.on('close', (code) => {
    console.log(`speedify_cli stats exited with code ${code}, restarting in 5s...`);
    speedifyProc = null;
    setTimeout(startSpeedifyStats, 5000);
  });

  speedifyProc.on('error', (err) => {
    console.error('speedify_cli spawn error:', err.message);
    speedifyProc = null;
    setTimeout(startSpeedifyStats, 10000);
  });
}

startSpeedifyStats();

// Clean up speedify + tournament-sync subprocesses on exit
function stopAllSyncProviders() {
  for (const manager of Object.values(syncProviders)) manager.stop();
}
process.on('SIGINT', () => {
  if (speedifyProc) speedifyProc.kill();
  stopAllSyncProviders();
  process.exit();
});
process.on('SIGTERM', () => {
  if (speedifyProc) speedifyProc.kill();
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