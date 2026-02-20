const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { Atem } = require('atem-connection');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'gamestate.json');

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
  leftColor: '#2E7D32',
  rightColor: '#B71C1C',
  textColor: '#ffffff',
  backgroundColor: '#808080',
  commercialBreak: {
    active: false,
    videoPath: '',
    startTime: null
  },
  atemStatus: {
    connected: false,
    ip: ATEM_IP,
    currentInput: 1,
    downstreamKeyEnabled: false
  }
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

      // Only store as previous input if it's NOT the graphics input
      if (currentInput !== GRAPHICS_INPUT) {
        previousInput = currentInput;
        console.log(`Storing previous input: ${previousInput}`);
      } else {
        console.log(`Current input ${currentInput} is graphics input - keeping previous input: ${previousInput}`);
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
    } else {
      // For DSK OFF or when already in target state, use direct command
      await atem.setDownstreamKeyOnAir(keyIndex, enabled);
      console.log(`🔧 ATEM setDownstreamKeyOnAir command sent successfully`);
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
      await atem.autoDownstreamKey(keyIndex);
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

app.get('/api/videos', (req, res) => {
  const videos = getAvailableVideos();
  res.json(videos);
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

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
    gameState.leftTeam = gameState.rightTeam;
    gameState.leftScore = gameState.rightScore;
    gameState.leftColor = gameState.rightColor;
    gameState.rightTeam = tempTeam;
    gameState.rightScore = tempScore;
    gameState.rightColor = tempColor;
    saveGameState();
    io.emit('gameUpdate', gameState);
  });
  
  socket.on('resetGame', () => {
    gameState.leftScore = 0;
    gameState.rightScore = 0;
    saveGameState();
    io.emit('gameUpdate', gameState);
  });

  socket.on('startCommercialBreak', async (data) => {
    console.log('Starting commercial break:', data.videoPath);

    // ATEM sequence: Fade out downstream key -> Switch to graphics input -> Ensure DSK stays OFF
    if (atemConnected) {
      console.log('🎬 ATEM: Starting commercial break sequence...');

      // Step 1: Fade out the downstream key (turn OFF to hide scoreboard overlay)
      await fadeDownstreamKey(false);

      // Wait for DSK fade to complete (ATEM auto transition time is typically 1-2 seconds)
      console.log('Waiting for DSK fade to complete...');
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Step 2: Switch to graphics input
      await switchToGraphicsInput();

      // Step 3: Ensure DSK stays OFF on graphics input (immediate cut)
      console.log('Ensuring DSK stays OFF on graphics input...');
      await setDownstreamKey(false);
    }

    gameState.commercialBreak = {
      active: true,
      videoPath: data.videoPath,
      startTime: Date.now()
    };
    saveGameState();
    io.emit('gameUpdate', gameState);
  });

  socket.on('stopCommercialBreak', async () => {
    console.log('Stopping commercial break');

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

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Initialize ATEM connection on startup
connectToAtem().catch(error => {
  console.log('ATEM connection failed on startup (this is normal if no ATEM is connected):', error.message);
});

server.listen(PORT, () => {
  console.log(`Scoreboard server running on port ${PORT}`);
  console.log(`Display: http://localhost:${PORT}/display`);
  console.log(`Control: http://localhost:${PORT}/control`);
  console.log(`ATEM IP: ${ATEM_IP} | Graphics Input: ${GRAPHICS_INPUT} | Downstream Key: ${DOWNSTREAM_KEY}`);
});