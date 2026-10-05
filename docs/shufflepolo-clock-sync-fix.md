# Shufflepolo clock sync — what we changed on our end

Summary for the Shufflepolo dev, following up on their analysis of our
overlay clock drifting from `shufflepolo.com`'s own displayed time.

## What they identified

Their diagnosis (abbreviated): the drift comes from measuring the
clock-sync offset (`offset_ms = server_now − Date.now()`) too late — at
whatever moment a downstream consumer happens to notice a snapshot change,
rather than close to the actual HTTP round trip. That measurement should
use `t0`/`t1` bracketing the request and `offset = server_now −
midpoint(t0, t1)`, keeping the reading from the fastest round trip rather
than replacing it with a reading from a slower one.

They asked: *"how does their display get its sync figure (on file change,
on a timer, or from file timestamps), and does it recalculate the time or
count down?"*

## Our answer

Our pipeline has three hops between the actual Shufflepolo HTTP response
and where we used to measure the offset:

```
shufflepolo_sync.js  --POST-->  server.js (gameState)  --Socket.IO-->  browser
     (fetches snapshot)              (merges/broadcasts)                (used to measure offset HERE)
```

We were doing exactly the thing they suspected: `server_now` rode along
unchanged through both hops, and the browser computed
`skewMs = localAnchorAt − server_now` using its own `Date.now()` at
whatever moment the Socket.IO `gameUpdate` happened to arrive — which is
POST-latency + Node processing + broadcast latency after the real
request/response that produced `server_now`. That delay isn't constant,
so the "skew" (and therefore the displayed clock) shifted by a different
amount on every push.

We don't recalculate time by subtracting 1 per tick anywhere — every
render recomputes `elapsed = (nowCorrected − running_since)` fresh from
timestamps — so that particular failure mode in their list didn't apply
to us. Our countdown rounding was also already `ceil(duration − played)`,
matching their spec.

## What we changed

Moved the offset measurement to the one place that's actually close to
the real round trip: `shufflepolo_sync.js`'s own `fetch()` call.

1. **`shufflepolo_sync.js`** — brackets the snapshot fetch with `t0`/`t1`,
   computes `offset = server_now − midpoint(t0, t1)`, and keeps only the
   reading from the fastest round trip seen (a slower, noisier round trip
   never overwrites a faster one). This precomputed `clock_offset_ms` is
   what gets sent onward — not `server_now`.
2. **`server.js`** — passes `clock_offset_ms` through onto `gameState.clock`
   unchanged. Nothing here re-derives it.
3. **`scorebug-render.js`** — the browser does `skewCorrectedNow =
   Date.now() + clock_offset_ms`, then `elapsed = (skewCorrectedNow −
   running_since) / 1000`. No timestamp comparison happens in the browser
   anymore — just addition of an already-correct number.

Net effect: the clock-sync offset is now measured once, at the real
network round trip, and carried through as a plain number that nothing
downstream ever reinterprets against a timestamp that's gone stale.

## Code

### `shufflepolo_sync/shufflepolo_sync.js`

```js
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
    team1_id: live.team1.team_id,
    team2_id: live.team2.team_id,
    goals: live.goals || [],
    penalties: live.penalties || [],
    timeouts: live.timeouts || [],
  };
}
```

```js
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
  // ... (unchanged backoff/readAgain logic)
}
```

### `server.js`

```js
// Applies a live snapshot from shufflepolo_sync.js to gameState.
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
  // ... (unrelated: goals/penalties/timeouts diffing for our own kill feed)
}
```

### `public/scorebug-render.js`

```js
// skewCorrectedNowMs: this device's current time, adjusted by the skew
// measured against Shufflepolo's server_now at push receipt - i.e. "what
// Shufflepolo's own clock reads right now", not this device's.
function secondsFromShufflepoloClock(clock, skewCorrectedNowMs) {
  const running = clock.status === "running";
  const runningSinceMs = Date.parse(clock.running_since);
  const elapsedSinceRunningStart = running && !isNaN(runningSinceMs)
    ? Math.max(0, (skewCorrectedNowMs - runningSinceMs) / 1000)
    : 0;
  const played = clock.elapsed_seconds + elapsedSinceRunningStart;
  if (clock.duration_seconds == null) {
    return { secs: Math.max(Math.floor(played), 0), overtime: false, running };
  }
  return { secs: Math.max(Math.ceil(clock.duration_seconds - played), 0), overtime: false, running };
}

function computeClockDisplay(currentClock) {
  if (!currentClock) return { text: "--:--", stopped: true };

  const isShufflepolo = currentClock.status !== undefined;
  let secs, overtime, running;
  if (isShufflepolo) {
    const offsetMs = typeof currentClock.clock_offset_ms === "number" ? currentClock.clock_offset_ms : 0;
    const skewCorrectedNowMs = Date.now() + offsetMs;
    ({ secs, overtime, running } = secondsFromShufflepoloClock(currentClock, skewCorrectedNowMs));
  } else {
    // ... Podium path, unchanged
  }

  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  const formatted = mm + ":" + ss;
  return { text: overtime ? "+" + formatted : formatted, stopped: !running };
}
```

## Verified

- Simulated a 3-minute device clock skew end to end — fully corrected,
  matches the no-skew case exactly.
- Simulated a slower, noisier round trip arriving after a faster one —
  correctly ignored, offset stays at the faster reading.
- Live production check: `clock_offset_ms` on a real push came back as
  `138.5` ms, consistent with the 47–215 ms round-trip range you measured
  against the production feed.
- Side-by-side against `shufflepolo.com`'s own game-centre page during a
  live match: both clocks agreed, with the only difference attributable to
  the few seconds between looking at one screen and then the other, not
  accumulating drift.

## Still open on your end

Per your own "What I'd do instead" list, these are unchanged and still
worth doing on Shufflepolo's side:

- Store `elapsed_seconds` as `numeric(10,3)` (milliseconds) instead of
  flooring to whole seconds on every pause/timeout/correction.
- Make the console's repaint scheduled on second boundaries rather than a
  free-running `setInterval(1000)`.
- Use the same round-trip sync measurement on the console itself.
