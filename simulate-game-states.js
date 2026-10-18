#!/usr/bin/env node
// Throwaway test tool - cycles gameState through the banner-relevant states
// (left/right timeout, left/right penalty of each severity) every few seconds
// (SECONDS_PER_STATE below), so an overlay's timeoutBanner/penaltyBanner (and
// every other live-bound role) can be checked without a real tournament.
//
// Each state is mutually exclusive on purpose: a timeout always stops the
// clock (Shufflepolo's console does this in the same statement), and a
// running clock ends it, so a penalty state's running clock also clears the
// previous state's timeout - the same rule server.js applies to real data.
//
// Safe to run only when nothing live is actually on court. It:
//   1. Asks the running server to stop its supervised shufflepolo_sync.js
//      child (POST /api/sync/shufflepolo/toggle {enabled:false}), so the
//      simulated pushes aren't racing real tournament data. It never spawns
//      or kills a sync process itself - the server owns that child.
//   2. POSTs simulated pushes to the same POST /api/sync/shufflepolo/push
//      endpoint the real shufflepolo_sync.js uses, in the same shape
//      (see buildPush there).
//   3. On exit (Ctrl+C, or after one loop with --once), asks the server to
//      re-enable the provider if it was enabled before.
//
// Usage: node simulate-game-states.js [--once]

'use strict';

const http = require('http');

const PORT = process.env.PORT || 3000;
const SECONDS_PER_STATE = 8;
const RUN_ONCE = process.argv.includes('--once');

const TEAM1_ID = 'sim-team-1';
const TEAM2_ID = 'sim-team-2';
const GAME_ID = `sim-game-${Date.now()}`;

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: 'localhost', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => (res.statusCode < 300 ? resolve(data ? JSON.parse(data) : {}) : reject(new Error(`HTTP ${res.statusCode}: ${data}`))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => (res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`HTTP ${res.statusCode}: ${data}`))));
    }).on('error', reject);
  });
}

async function stopRealSync() {
  const config = await getJson('/api/sync/shufflepolo/config');
  if (config.enabled) {
    await postJson('/api/sync/shufflepolo/toggle', { enabled: false });
    console.log('Asked the server to stop the real Shufflepolo sync for the duration of the simulation.');
  }
  return !!config.enabled;
}

async function restoreRealSync(wasEnabled) {
  if (!wasEnabled) return;
  await postJson('/api/sync/shufflepolo/toggle', { enabled: true });
  console.log('Asked the server to restart the real Shufflepolo sync.');
}

// ---------------------------------------------------------------- states

// Cumulative per-game logs, the way the feed reports them.
let nextId = 1;
const freshId = () => `sim-${nextId++}`;
const log = { goals: [], penalties: [], timeouts: [] };

function basePush(overrides) {
  return {
    connected: true,
    has_game: true,
    court: 1,
    game_id: GAME_ID,
    status: 'live',
    clock_offset_ms: 0,
    // Deliberately long (three-word) names, to exercise the overlay's
    // name fitting - real rosters have names like these.
    team1: { team_id: TEAM1_ID, name: 'Los Angeles Hammers', score: 3 },
    team2: { team_id: TEAM2_ID, name: 'Midnight Mavericks United', score: 5 },
    goals: log.goals,
    penalties: log.penalties,
    timeouts: log.timeouts,
    clock: RUNNING_CLOCK(60),
    ...overrides,
  };
}

function addTimeout(teamId) {
  log.timeouts.push({ id: freshId(), team_id: teamId, game_seconds: 30, at: new Date().toISOString(), player: null });
}

function addPenalty(teamId, code, playerName) {
  log.penalties.push({ id: freshId(), team_id: teamId, game_seconds: 40, at: new Date().toISOString(), player: playerName ? { id: freshId(), name: playerName } : null, code });
}

const RUNNING_CLOCK = (elapsed) => ({ status: 'running', elapsed_seconds: elapsed, running_since: new Date().toISOString(), duration_seconds: 720, overtime: false, live_until: null });
const PAUSED_CLOCK = (elapsed) => ({ status: 'paused', elapsed_seconds: elapsed, running_since: null, duration_seconds: 720, overtime: false, live_until: null });

const STATES = [
  { label: 'Left team timeout (timeoutBanner, data-side="left")', build: () => { addTimeout(TEAM1_ID); return basePush({ clock: PAUSED_CLOCK(20) }); } },
  { label: 'Clock restarts: timeout over', build: () => basePush({ clock: RUNNING_CLOCK(20) }) },
  { label: 'Right team minor penalty, Riley (penaltyBanner, data-side="right")', build: () => { addPenalty(TEAM2_ID, 'mi', 'Riley'); return basePush({ clock: RUNNING_CLOCK(45) }); } },
  { label: 'Left team major penalty, no player (penaltyBanner, data-side="left")', build: () => { addPenalty(TEAM1_ID, 'ma', null); return basePush({ clock: RUNNING_CLOCK(70) }); } },
  { label: 'Right team timeout (timeoutBanner, data-side="right")', build: () => { addTimeout(TEAM2_ID); return basePush({ clock: PAUSED_CLOCK(80) }); } },
  { label: 'Clock restarts: timeout over', build: () => basePush({ clock: RUNNING_CLOCK(80) }) },
  { label: 'Left team ejection, Morgan (penaltyBanner, data-side="left")', build: () => { addPenalty(TEAM1_ID, 'pm', 'Morgan'); return basePush({ clock: RUNNING_CLOCK(95) }); } },
  { label: 'Right team turnover, no player (penaltyBanner, data-side="right")', build: () => { addPenalty(TEAM2_ID, 'bt', null); return basePush({ clock: RUNNING_CLOCK(110) }); } },
  { label: 'Two right penalties in one push (queue: Sam then Alex)', build: () => { addPenalty(TEAM2_ID, 'mi', 'Sam'); addPenalty(TEAM2_ID, 'ma', 'Alex'); return basePush({ clock: RUNNING_CLOCK(130) }); } },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const wasEnabled = await stopRealSync();
  await sleep(500);

  let stopping = false;
  const cleanupAndExit = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nRestoring real sync...');
    // Leave the court as the server last saw it, with no live game.
    try { await postJson('/api/sync/shufflepolo/push', { connected: true, has_game: false, court: 1, game_id: GAME_ID, status: 'final' }); } catch (e) { /* server may be gone */ }
    await restoreRealSync(wasEnabled);
    process.exit(0);
  };
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);

  console.log(`Simulating ${STATES.length} states, ${SECONDS_PER_STATE}s each${RUN_ONCE ? ' (once)' : ' (looping - Ctrl+C to stop and restore real sync)'}...`);
  do {
    for (const state of STATES) {
      if (stopping) break;
      console.log(`→ ${state.label}`);
      try {
        await postJson('/api/sync/shufflepolo/push', state.build());
      } catch (err) {
        console.error(`  push failed: ${err.message}`);
      }
      await sleep(SECONDS_PER_STATE * 1000);
    }
  } while (!RUN_ONCE && !stopping);

  await cleanupAndExit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
