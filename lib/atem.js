// ATEM video-switcher control: connection lifecycle, input switching,
// downstream/upstream key control, and the raw Atem instance other modules
// (commercial break sequencing, manual socket controls, the keyboard-
// controller REST route) need direct access to for fairlight audio mixing
// and upstream-keyer calls that have no equivalent wrapper function here.
//
// Call createAtemControl(...) once at startup. It owns the atem connection,
// atemConnected flag, and previousInput tracking as closure state - every
// other module reads them through the returned accessor object instead of
// local variables, so there is exactly one source of truth for "is ATEM
// connected right now" regardless of which module asks.

const { Atem } = require('atem-connection');

/**
 * @param {object} opts
 * @param {object} opts.io - socket.io server, for gameUpdate broadcasts on connection/state changes.
 * @param {object} opts.gameState - the live gameState object (mutated in place, same object server.js holds).
 * @param {() => void} opts.saveGameState - persists gameState to disk.
 * @param {string} opts.atemIp
 * @param {number} opts.graphicsInput
 * @param {number} opts.downstreamKey - which downstream keyer (1-based) to control.
 */
function createAtemControl({ io, gameState, saveGameState, atemIp, graphicsInput, downstreamKey }) {
  let atem = null;
  let atemConnected = false;
  let previousInput = 1; // Track previous input to switch back to

  async function connectToAtem() {
    // An instance is created at boot even when the switcher is unreachable,
    // so a manual reconnect (the atemConnect socket event) has to tear the
    // old one down first or it is a no-op forever.
    if (atem && atemConnected) {
      return;
    }
    if (atem) {
      try { await atem.destroy(); } catch (e) { /* already gone */ }
      atem = null;
    }

    try {
      console.log(`Connecting to ATEM at ${atemIp}...`);
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

        if (state && state.video && state.video.downstreamKeyers && state.video.downstreamKeyers[downstreamKey - 1]) {
          gameState.atemStatus.downstreamKeyEnabled = state.video.downstreamKeyers[downstreamKey - 1].onAir;
          console.log(`Downstream key ${downstreamKey} status: ${gameState.atemStatus.downstreamKeyEnabled ? 'ON' : 'OFF'}`);
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
          const keyIndex = downstreamKey - 1;
          const dskState = state.video?.downstreamKeyers?.[keyIndex]?.onAir || false;
          console.log(`🔄 DSK ${downstreamKey} state changed to: ${dskState ? 'ON' : 'OFF'}`);

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

      await atem.connect(atemIp);
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
        if (currentInput === graphicsInput) {
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
      console.log(`Auto transitioning ATEM to graphics input ${graphicsInput}`);
      await atem.changePreviewInput(graphicsInput);
      await atem.autoTransition();
      gameState.atemStatus.currentInput = graphicsInput;

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
      if (previousInput === graphicsInput) {
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
      const keyIndex = downstreamKey - 1;
      console.log(`🔧 Setting downstream key ${downstreamKey} (index ${keyIndex}) to ${enabled ? 'ON' : 'OFF'}`);

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
      const keyIndex = downstreamKey - 1;
      console.log(`${fadeIn ? 'Fading in' : 'Fading out'} downstream key ${downstreamKey}`);

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

  return {
    connectToAtem,
    switchToGraphicsInput,
    switchToPreviousInput,
    setDownstreamKey,
    fadeDownstreamKey,
    // Live accessors - every caller reads through these instead of a local
    // copy, so there's one source of truth for "is ATEM connected right
    // now" regardless of which module asks. `atem` is the raw Atem
    // instance, needed by callers (commercial break sequencing, manual
    // socket handlers) that call fairlight/upstream-keyer methods this
    // module has no wrapper for.
    get atem() { return atem; },
    get isConnected() { return atemConnected; },
    get previousInput() { return previousInput; },
    set previousInput(value) { previousInput = value; },
  };
}

module.exports = { createAtemControl };
