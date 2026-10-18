# Shufflepolo integration in scorebored: code and decisions

Handoff written 2026-10-14. Branch `API_REWORK` on the Pi (`/home/matthew/bin/scorebored`).
Everything described here is live-tested on the Pi but **not committed to git**
(`git diff --stat` on this branch shows the working tree; the files marked
"untracked" below are new).

This document is self-contained: part A explains the design and why each
decision was made, part B is the current status and open items, part C is the
full source of every Shufflepolo-related file as it exists right now.

---

## A. Design

### A1. What scorebored is

scorebored is a live scoreboard overlay for bike polo broadcasts. A Node/Express
server (`server.js`) holds one `gameState` object, persists it to
`gamestate.json`, and broadcasts it over socket.io to browser pages: `/display`
(a kiosk Chromium feeding an ATEM Mini Pro ISO over HDMI) and `/overlay/:id`
(pasted HTML overlays made in `/overlay-editor`). Live game data can come from
three tournament platforms (Challonge, Podium, Shufflepolo), each as a separate
supervised subprocess. This handoff covers only the Shufflepolo path.

### A2. Data flow

```
shufflepolo.com (Supabase)
  |  GET scoreboard-feed?tournament=<uuid>   (ETag / If-None-Match)
  |  Supabase Realtime: topics games:<id>, feed:<id>   (signals only)
  v
shufflepolo_sync/shufflepolo_sync.js        one process per tournament, spawned by SyncManager
  |  POST /api/sync/shufflepolo/push   (only on a 200, i.e. only when something changed)
  |  writes state/status.json, state/participants.json, state/bracket.json, ../bracket.json
  |  every 2 min: headless Chromium render of the public tournament page -> page_bracket.js
  v
server.js  applyShufflepoloSnapshot() inside commitGameState()
  |  gameState: teams, scores, clock (+clock_offset_ms), penalties, timeouts,
  |             activeTimeout, penaltyLog, gameId, has_game, status
  |  commit is change-gated: identical JSON = no save, no broadcast
  v
socket.io 'gameUpdate'
  v
public/overlay-bind.js  (data-role bindings; penalty/timeout banners)
public/scorebug-render.js  (computeClockDisplay: clock math shared by all pages)
```

The server only ever receives what the sync chose to push for **one court**.
The sync never parses realtime messages; every message is just "re-read now".

### A3. The feed contract we build on

Shufflepolo publishes a contract (`docs/scoreboard-feed.md` in their repo; a
git-ignored copy is at `shufflepolo_repo/shufflepolo-app-main/`). The parts
our code depends on:

- Snapshot: `tournament`, `teams`, `games` (flat, in play order), `live[]`,
  `suspended[]`, `up_next[]`, `recent_results[]`, `courts[]` with
  `current_game`, `realtime {url, api_key, topic, topics[]}`, `server_now`.
- Game status enum: `live`, `suspended`, `final`, `scheduled`. Unknown values
  may appear within v1; skip that game, never reject the snapshot.
- `courts[].current_game` is "what a display following this court should show":
  the court's live game, else the next game after its last finished one, else
  its last game of the day, else `null`. It has no `clock`; take the clock from
  `live[]`/`suspended[]` by id. Event lists (`goals`/`penalties`/`timeouts`)
  are `null` when a read did not include them, never meaning "none".
- Clock: `{status, elapsed_seconds, running_since, duration_seconds, overtime,
  live_until}`. Count locally: `played = elapsed_seconds + (now + offset -
  running_since)`; countdown is `ceil`, overtime counts up with `floor`.
- Usage rules: one socket per process joined to **every** topic in
  `realtime.topics`; re-read on SUBSCRIBED; throttle re-reads to one per 2 s
  with a trailing read; re-read once at each `live_until`; safety poll at most
  once per 5 minutes; always send `If-None-Match`; back off reconnects 1 s to
  60 s; a 404 or `Unauthorized` join means unpublished, keep the last snapshot.
- Realtime: `games:<id>` carries scores/clocks/games; `feed:<id>` carries
  goals, penalties, timeouts. **A penalty is only ever on `feed:<id>`.**

### A4. Decisions and the reasons behind them

Each item is a choice that a reader could reasonably question. The "why"
is what matters when changing it.

1. **Rebuild from the contract, not patch the old client (2026-10-09).**
   The previous client joined only `games:<id>`, so it never heard a penalty
   and had been "fixed" by polling every 2 seconds. That cost Shufflepolo about
   340 MB/day of egress and was still the wrong path. The dev wrote a corrected
   copy of our script against their contract; the current file is derived from
   it plus our own additions. Stability first, use what the API offers before
   asking the dev for anything.

2. **Join all `realtime.topics` on one socket.** This is the whole "realtime
   looks healthy but updates lag" mystery from the old handoff: penalties
   arrive only on `feed:<id>`. The connect code iterates `topicsOf(realtime)`
   and treats any channel error as "drop everything, back off, rejoin all
   together" so the library's own per-channel rejoin loop cannot fight ours.
   A `generation` token ignores status callbacks from a superseded channel set.

3. **Messages are signals, never data.** `channel.on('broadcast', '*')` only
   calls `requestRead()`. Event names and payloads may change without notice;
   a client that only re-reads is unaffected.

4. **ETag on every read; 304 means do nothing.** No state file write, no push,
   no new clock sample. The ETag is stored only after the push succeeded, so a
   failed push is retried by the next read instead of being lost.

5. **Safety poll is once per 5 minutes, as the contract says.** The old
   2-second poll was a workaround for missing penalties. `MIN_READ_INTERVAL_MS
   = 2000` and `SAFETY_POLL_MS = 300000` are the contract's numbers; do not
   lower them. We asked the dev whether a 60 s conditional poll would be
   acceptable as cellular insurance (see `docs/shufflepolo-receiver-update.md`);
   no answer is recorded, so 5 minutes stands.

6. **Re-read at each live clock's `live_until`.** The one change that sends
   no message (full time passing untouched, or a pause turning into a
   suspension). Timers are armed on each 200 and counted against the server's
   clock via the measured offset, plus 500 ms slack.

7. **Follow one court via `courts[].current_game`.** The old `live[0]` logic
   showed whichever game in the tournament was live first, so with two courts
   the scoreboard could show the wrong court. The feed's `current_game` was
   designed for exactly this, so the sync has no selection logic. The court
   number comes from `shufflepolo-config.json` (`court`, default 1), matched
   on `number`, not array position. **`has_game` is true only when that game's
   status is `live`**; for any other status (final, scheduled, suspended,
   unknown) the server keeps the last names and score on screen and clears
   every time-bound field (clock, penalties, timeouts, banners). Suspended is
   deliberately treated as "not live" rather than drawn as a paused clock.

8. **Clock offset is measured in the sync process at the real HTTP round
   trip** and carried as `clock_offset_ms` on the clock object, through
   server.js untouched, to the browser. History: the browser used to compute
   skew from `server_now` at socket receipt, which baked in POST latency plus
   Node processing plus broadcast latency, different on every push, and the
   clock visibly drifted from Shufflepolo's own site when switching presets.
   The dev diagnosed it. Sampling follows their reference client: keep the
   fastest round trip, age the held sample (0.1 ms per second), and replace it
   at once when the samples disagree beyond their bounds (the Pi has no RTC;
   NTP can step the wall clock mid-game). See
   `docs/shufflepolo-clock-sync-fix.md`.

9. **No kill feed.** The old `gameState.feed` (a persisted, ever-growing
   event log with colliding ids across restarts) and `diffAndLogFeed` were
   removed from server, renderer, overlay binder, display pages and docs.
   `gamestate.json` went from 437 KB to about 1 KB. Nothing persists event
   history now: `penaltyLog` is "what the provider reports for the current
   game right now". Do not reintroduce a persisted event log or per-poll
   pushes. `docs/shufflepolo-killfeed-ordering.md` is therefore moot.

10. **Event lists pass through whole; `null` means "not included".**
    `buildPush` sends `game.goals ?? null` etc. and `applyShufflepoloSnapshot`
    only replaces `penalties`/`timeouts` when the pushed value is an array.
    Goals are pushed but currently ignored by the server (see B3).

11. **Timeout banner: "clock has run since the newest timeout" is the end
    signal.** The feed gives a timeout's `at` but no duration or end.
    Shufflepolo's console stops the clock in the same statement that records a
    timeout and ends it when the clock starts again (their
    `src/lib/gameConsole.ts` and the `call_game_event` DB function). So
    server.js shows the banner while the newest timeout is not in
    `endedTimeoutIds` and the clock is paused, with `SHUFFLEPOLO_TIMEOUT_SECONDS
    = 120` as a ceiling. 120 s and 2 timeouts per team are platform constants
    from their code, not a house rule. `endedTimeoutIds` is in-memory only:
    after a restart the 120 s window hides anything older. The banner shows
    the word only, no countdown. The browser counts the ceiling down locally
    from the update's receipt time because updates arrive only on change.

12. **Penalty banner: id-based detection in the browser.** `overlay-bind.js`
    keeps a `seenPenaltyIds` set against `gameState.penaltyLog.items`. The
    first state a page sees, and the first state of each new `gameId`, seeds
    the set silently so a reload or server restart never replays history.
    After that, an unseen id is queued per side and announced in three
    phases, 2 s each (`PENALTY_PHASE_MS`): "Penalty", player name (skipped
    when none), severity label. Queued, not last-one-wins, because one push
    can carry two penalties for the same side. No countdown: real penalty
    duration is referee-timed and unknowable from the feed.

13. **Penalty codes map to Podium's severity vocabulary** (`bt` turnover,
    `mi` minor, `ma` major, `pm` ejection) so overlays are provider-agnostic.
    Unknown codes pass through as-is and render uppercased.

14. **Change-gated commits.** `commitGameState()` stringifies the state and
    skips save and broadcast when identical to the last commit. Combined with
    the 304 path, an idle tournament produces no disk writes and no socket
    traffic.

15. **State files are written only when their content changed** (sha1 of the
    JSON), via write-then-rename. The Pi's root is an SD card. `status.json`'s
    `last_poll_at` is rounded to the minute so a quiet tournament does not
    rewrite it on every 304, while `SyncManager`'s staleness watchdog
    (`staleAfterMs` 15 min) can still tell a hung child from a quiet one.

16. **SyncManager owns the child.** Crash restart with 1 s to 60 s backoff
    (reset after 5 min of uptime), hung-process watchdog on `status.json`,
    `resync()` by writing `resync\n` to the child's stdin (the next read skips
    the ETag and pushes even if unchanged), `stop()` waits for `close` before
    any restart so no orphan holds the old socket. The old simulator used to
    spawn its own detached, log-less sync process; it now toggles the
    provider through the server's REST routes instead.

17. **Bracket ladder from the public page (added 2026-10-14).** The feed lists
    only games that exist with both teams, so unplayed bracket slots never
    appear and a ladder could not be drawn ahead of play. The public tournament
    page draws the whole ladder, so `page_bracket.js` renders it with the Pi's
    Chromium (`--headless=new --dump-dom`, own profile dir, about 3 s) every 2
    minutes and parses the game cards using the page's own `data-testid`
    hooks and inline `grid-area`, never Tailwind class names. An empty or
    failed render keeps the last good parse. Bracket-phase matchups in the
    app's `bracket.json` now come from the page (TBD slots, local start times);
    group-stage matchups still come from the feed. `/ladder` draws it on air
    (luma-keyed black background) and `/api/ladder?t=` renders any pasted
    tournament link, cached 2 minutes per tournament, feed `live`/`up_next`
    merged with a 15 s cache for the "Next up" card.

18. **Tournament id normalisation.** The feed has no list endpoint and the
    UUID is only visible in the page URL, so the config accepts a pasted
    `https://shufflepolo.com/t/<uuid>` and `normalizeField` strips it to the
    UUID.

---

## B. Status and open items

### B1. Verified live on the Pi

- ETag/304 path against production; idle traffic is the 5-minute 304 only.
- One socket close (code 1006) in a 2.5-hour watch, rejoined within 2 s,
  nothing lost.
- Penalties arrive over `feed:<id>` and the banner plays its phases.
- Timeout banner clears when the clock runs again.
- Clock matches shufflepolo.com's own display.
- Page bracket parsing verified 2026-10-14 against a tournament with a drawn
  bracket (the "Back to School Bash" ladder, id `a17ea158-...`).

### B2. Current live config

`shufflepolo-config.json`: tournament `b3ac9fb1-408d-42eb-a7d7-f93d815ca9c6`
("NAH Testing (LosAngelesBikePolo)", group stage only, no bracket on its page),
court 1, enabled. The sync child is running under `scorebored.service`.

### B3. Known gaps (ordered by my estimate of value)

1. **Overtime clock is wrong.** `secondsFromShufflepoloClock` in
   `public/scorebug-render.js` ignores `clock.overtime`. The contract says a
   bracket game level at full time counts **up** past `duration_seconds` with
   an "Overtime" label; we show `0:00`. Podium's path already supports a "+"
   prefix, so the fix is: when `clock.overtime` is true, return
   `secs = floor(played - duration_seconds)`, `overtime: true`. Also note
   `live_until` is `null` during running overtime, which the sync already
   tolerates (it skips games without one).

2. **Goal banner not built.** The sync pushes `goals`; `applyShufflepoloSnapshot`
   drops them. Matthew's intended design (2026-10-09): a `goalLog` shaped like
   `penaltyLog`, a `goalBanner` data-role, id-based detection in
   `overlay-bind.js` with phased text "GOAL" then scorer, and a block element
   per side in the locked default overlay. Goals carry `player` and `team_id`
   like penalties, so `sideFor` and the same seeding rules apply.

3. **`elapsed_seconds` can be negative** (a game lengthened before kickoff).
   The renderer's `Math.max(0, ...)` on the countdown is fine, but check the
   `played` floor paths.

4. **Suspended games** are treated as "no live game" (clock and banners
   cleared, names kept). The contract suggests drawing a paused clock if shown
   at all. This is a deliberate choice, revisit only if the operator wants it.

5. **Page bracket renders fail intermittently** on the current tournament:
   the journal alternates "no game cards found, keeping previous" (expected,
   the page has no bracket) with "chromium: Command failed" roughly every
   other run. Two manual runs from a different profile dir succeeded. Not
   diagnosed; possible profile-dir lock contention or the 60 s timeout. The
   fallback keeps the last good result, so the effect is only log noise today.

6. **`court` must be set on `/bracket`** for multi-court events; default is 1
   with no warning on the control UI beyond the sync's log line.

7. **The locked default "Scorebug" overlay still has a "Kill Feed" block**;
   it is dead content now that `gameState.feed` is gone.

8. **Two questions to the dev are unanswered** in our records: whether our
   timeout reading is right, and whether a 60 s conditional poll is acceptable.

9. **Debug instrumentation** `debugLogClock` in `scorebug-render.js` is marked
   temporary and can be removed.

### B4. Files

| File | Role | Git state |
|---|---|---|
| `shufflepolo_sync/shufflepolo_sync.js` | feed client, one per tournament | modified |
| `shufflepolo_sync/page_bracket.js` | headless page render + parse | untracked |
| `lib/sync.js` | `SyncManager` (all providers) | modified |
| `server.js` | provider registration, `applyShufflepoloSnapshot`, ladder routes, push/resync routes | modified |
| `public/overlay-bind.js` | data-role binding, banners | untracked |
| `public/scorebug-render.js` | clock math | modified |
| `public/bracket-ladder.html` | `/ladder` page | untracked |
| `simulate-game-states.js` | banner test driver | untracked |
| `docs/sync.md` | user-facing doc | modified |
| `docs/shufflepolo-receiver-update.md` | note sent to the dev 2026-10-09 | tracked |
| `docs/shufflepolo-clock-sync-fix.md` | clock offset history | tracked |
| `docs/shufflepolo-killfeed-ordering.md` | moot (kill feed removed) | untracked |
| `shufflepolo_repo/` | copy of Shufflepolo's repo, contract at `docs/scoreboard-feed.md` | git-ignored |

Dependencies: Node v22.23.3, `@supabase/supabase-js` 2.117.2, `/usr/bin/chromium`.

### B5. Operational notes

- `sudo systemctl restart scorebored.service` picks up server and sync changes.
  The kiosk `/display` page is long-lived; kill `chromium.*display` and
  `launch-display.sh` relaunches it.
- Copy files to the Pi over the wired address `192.168.55.16`; the Wi-Fi
  address replies out the wired side and the connection resets.
- `POST /api/sync/shufflepolo/resync` forces a full read and push.
  `POST /api/sync/shufflepolo/toggle {enabled}` starts/stops the child.
- `node shufflepolo_sync/page_bracket.js <tournament url>` prints the parsed
  ladder for any tournament.
- `node simulate-game-states.js [--once]` cycles the banner states against
  the running server (stops the real sync first, restores it on exit).
- Logs: `journalctl -u scorebored.service`; sync lines are tagged `[shufflepolo]`.

---

## C. Source

Exact contents as of 2026-10-14. Line numbers for `server.js` extracts are
the current ones.


### C1. shufflepolo_sync/shufflepolo_sync.js (full)

```js
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
```

### C2. shufflepolo_sync/page_bracket.js (full)

```js
// Bracket games read from the public shufflepolo.com tournament page.
//
// Why: the scoreboard feed (scoreboard-feed) lists only games that exist with
// both teams; unplayed bracket games (empty slots, "TBD") are not in it, so
// bracket.json could not show the ladder ahead of play. The tournament page
// draws the whole ladder, so we render it headless with the Pi's Chromium and
// read the game cards back out of the DOM. Nothing is fetched beyond what any
// browser loads to show the page.
//
// What the page gives us (verified 2026-10-14 against the Back to School Bash
// bracket): each game card has data-testid="bracket-game-row-<game uuid>",
// with children bracket-game-number-<id> ("Game 16"), bracket-game-time-<id>
// ("02:30 PM", tournament local time) and bracket-game-slot-team1/team2-<team
// uuid> (team name, then the score). The card's wrapper has an inline
// `grid-area: row / column` whose column (1, 3, 5, ...) is the round: the
// section's round labels ("Round 1", ..., "Winners Final") appear in that
// order just before the cards. Sections are "Grand Final", "Winners Bracket",
// "Losers Bracket"; each bracket is headed by an <h3> ("Main Bracket").
//
// These test ids are the page's own stable hooks; the Tailwind class names are
// not relied on. If the page changes shape, parseBracket() returns [] and the
// caller keeps its last good result.
//
// CLI: node page_bracket.js <tournament url>   prints the parsed games as JSON.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
// Own profile dir: never share the kiosk display's (/tmp/chromium-atem-display).
const PROFILE_DIR = path.join(os.tmpdir(), 'chromium-shufflepolo-page');
const RENDER_TIMEOUT_MS = 60000;

/** Renders the page headless and resolves with the DOM as HTML. */
function renderPage(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${PROFILE_DIR}`,
      '--virtual-time-budget=15000', // let the app fetch and draw before dumping
      '--window-size=1400,3000',
      '--dump-dom', url,
    ];
    execFile(CHROMIUM, args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`chromium: ${err.message.split('\n')[0]}`));
      resolve(stdout);
    });
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' ? e.slice(2) : e.slice(1), e[1] === 'x' ? 16 : 10));
    return m;
  });
}

const SECTION_RE = /^(grand final|winners bracket|losers bracket|final|bracket)$/i;
const ROUND_LABEL_RE = /^(round \d+|winners final|losers final|grand final|final|semifinals?|quarterfinals?)$/i;

/**
 * Parses the rendered page into bracket games.
 * @returns {Array<{id, bracket, section, round, roundLabel, number, time, team1, team2, score1, score2}>}
 */
function parseBracket(html) {
  // Tokenize: tags and text, in document order.
  const tokens = [];
  const re = /<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<\/([a-zA-Z][a-zA-Z0-9]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) tokens.push({ open: m[1].toLowerCase(), attrs: m[2] || '' });
    else if (m[3]) tokens.push({ close: m[3].toLowerCase() });
    else if (m[4]) { const t = unescapeHtml(m[4]).trim(); if (t) tokens.push({ text: t }); }
  }
  const testid = (attrs) => { const a = /data-testid="([^"]+)"/.exec(attrs); return a ? a[1] : null; };
  const gridArea = (attrs) => { const a = /grid-area:\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/.exec(attrs); return a ? { row: Number(a[1]), column: Number(a[2]), rowEnd: a[3] ? Number(a[3]) : Number(a[1]) + 1 } : null; };

  const games = [];
  let bracket = null, section = null, roundLabels = [];
  let lastArea = null, inH3 = false, h3TextSeen = false;
  let game = null, slot = null, depthAtGame = 0, depth = 0;

  const finish = () => { if (game) { games.push(game); game = null; slot = null; } };

  for (const tok of tokens) {
    if (tok.open) {
      depth++;
      const id = testid(tok.attrs);
      const area = gridArea(tok.attrs); if (area) lastArea = area;
      if (tok.open === 'h3') { inH3 = true; h3TextSeen = false; }
      if (id && id.startsWith('bracket-game-row-')) {
        finish();
        const column = lastArea ? lastArea.column : 1;
        const round = Math.floor((column + 1) / 2); // columns 1,3,5,... are rounds 1,2,3,...
        game = { id: id.slice('bracket-game-row-'.length), bracket, section, round,
          grid: lastArea ? { row: lastArea.row, rowEnd: lastArea.rowEnd, column } : null,
          roundLabel: roundLabels[round - 1] || (roundLabels.length === 0 && section ? section : `Round ${round}`),
          number: null, time: null, team1: null, team2: null, score1: null, score2: null };
        depthAtGame = depth; lastArea = null;
      } else if (game && id && id.startsWith('bracket-game-slot-team')) {
        slot = id.startsWith('bracket-game-slot-team1') ? 1 : 2;
        const teamId = id.replace(/^bracket-game-slot-team[12]-?/, '');
        game[`team${slot}Id`] = teamId || null;
      } else if (game && id && id.startsWith('bracket-game-number-')) game._want = 'number';
      else if (game && id && id.startsWith('bracket-game-time-')) game._want = 'time';
    } else if (tok.close) {
      if (tok.close === 'h3') inH3 = false;
      if (game && depth === depthAtGame) finish();
      depth--;
    } else if (tok.text) {
      const t = tok.text;
      if (game) {
        if (game._want === 'number') { const n = /(\d+)/.exec(t); if (n) game.number = Number(n[1]); delete game._want; }
        else if (game._want === 'time') { game.time = t; delete game._want; }
        else if (slot && game[`team${slot}`] === null) game[`team${slot}`] = t;
        else if (slot && /^\d+$/.test(t) && game[`score${slot}`] === null) game[`score${slot}`] = Number(t);
      } else if (inH3) {
        // first text only: the h3 also holds a "(double elimination)" span
        if (!h3TextSeen) { bracket = t; section = null; roundLabels = []; h3TextSeen = true; }
      }
      else if (SECTION_RE.test(t)) { section = t; roundLabels = []; }
      else if (ROUND_LABEL_RE.test(t)) roundLabels.push(t);
    }
  }
  finish();
  for (const g of games) { delete g._want; if (g.team1 === null) g.team1 = 'TBD'; if (g.team2 === null) g.team2 = 'TBD'; }
  return games;
}

/** The tournament's name: the page's first <h1>. */
function parseTitle(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? unescapeHtml(m[1].replace(/<[^>]+>/g, '')).trim() : null;
}

/**
 * The page's Teams section: data-testid="team-card-<team uuid>" wrapping the
 * name, a "Seed N" badge (team-seed-badge) and the roster (team-roster,
 * "A · B · C"). Returns [{ id, name, seed, roster: [names] }] sorted by seed.
 */
function parseTeams(html) {
  const teams = [];
  const re = /data-testid="team-card-([0-9a-f-]{36})"([\s\S]*?)(?=data-testid="team-card-|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const chunk = m[2];
    const texts = []; const tre = /data-testid="([^"]+)"|>([^<>]+)</g; let t;
    while ((t = tre.exec(chunk)) !== null) {
      if (t[1]) texts.push({ id: t[1] });
      else if (t[2] && t[2].trim()) texts.push({ text: unescapeHtml(t[2].trim()) });
    }
    const team = { id: m[1], name: null, seed: null, roster: [] };
    let want = 'name';
    for (const x of texts) {
      if (x.id === 'team-seed-badge') want = 'seed';
      else if (x.id === 'team-roster') want = 'roster';
      else if (x.id) continue;
      else if (want === 'name' && team.name === null) team.name = x.text;
      else if (want === 'seed') { const n = /(\d+)/.exec(x.text); if (n) team.seed = Number(n[1]); want = null; }
      else if (want === 'roster') { team.roster = x.text.split(/\s*[·•]\s*/).filter(Boolean); want = null; }
    }
    if (team.name) teams.push(team);
  }
  return teams.sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999) || a.name.localeCompare(b.name));
}

/** Render + parse title, games and teams. Rejects only on render failure. */
async function readBracketPage(url) {
  const html = await renderPage(url);
  return { title: parseTitle(html), games: parseBracket(html), teams: parseTeams(html) };
}

/** Render + parse. Resolves with [] (never rejects on page shape) but rejects on render failure. */
async function readBracketGames(url) {
  const html = await renderPage(url);
  return parseBracket(html);
}

module.exports = { renderPage, parseBracket, parseTitle, parseTeams, readBracketGames, readBracketPage };

if (require.main === module) {
  const url = process.argv[2];
  if (!url) { console.error('usage: node page_bracket.js <tournament url> [saved.html]'); process.exit(2); }
  const run = process.argv[3] ? Promise.resolve(parseBracket(fs.readFileSync(process.argv[3], 'utf8'))) : readBracketGames(url);
  run.then((games) => { console.log(JSON.stringify(games, null, 1)); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
```

### C3. server.js: gameState fields the sync owns (lines 51-77)

```js
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
  ladder: { active: false, tournament: null }, // bracket ladder layer on /display (setLadder); tournament uuid or null = the sync's
```

### C4. server.js: commitGameState (lines 140-148)

```js
function commitGameState(mutate) {
  mutate();
  const json = JSON.stringify(gameState);
  if (json === lastCommittedJson) return false;
  lastCommittedJson = json;
  saveGameState();
  io.emit('gameUpdate', gameState);
  return true;
}
```

### C5. server.js: Shufflepolo SyncManager registration (lines 251-287)

```js
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
```

### C6. server.js: applyShufflepoloSnapshot, penalty code map, timeout logic (lines 381-471)

```js
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

```

### C7. server.js: ladder routes (lines 515-573)

```js
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
```

### C8. server.js: generic sync push and resync routes (lines 633-662)

```js
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

```

### C9. lib/sync.js: SyncManager (full)

```js
// Shared subprocess-management + state-file helpers for scorebored's
// tournament-sync integrations (Challonge, Podium, Shufflepolo).
//
// Each provider is a standalone, toggleable, read-only-against-the-platform
// subprocess that writes atomic JSON state files to its own `state/` dir and,
// while enabled, overwrites the app's top-level bracket.json (the file
// Next/Prev Game navigation walks). This module owns the parts that are
// identical across providers: spawn/stop lifecycle, config load/save,
// state-file reads. Provider-specific behavior (what env vars to pass, what
// extra config fields to mask, provider-only routes like Challonge's
// tournament lookup) stays in each provider's own definition, not here.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// A sync child that exits on its own (a crash, an unhandled rejection) is
// respawned after a backoff that doubles up to a minute and resets once the
// child has stayed up for a while. An operator stop or restart never
// backs off.
const CRASH_BACKOFF_START_MS = 1_000;
const CRASH_BACKOFF_MAX_MS = 60_000;
const CRASH_BACKOFF_RESET_AFTER_MS = 5 * 60_000;

/**
 * @typedef {object} SyncProvider
 * @property {string} name - e.g. "challonge" - used in logs and as the REST/socket key.
 * @property {string} dir - absolute path to the provider's script directory.
 * @property {string} script - absolute path to the script to spawn.
 * @property {string[]} [args] - extra argv for the script (e.g. shufflepolo's node script, no args needed).
 * @property {string} command - the interpreter to spawn, e.g. "python3" or "node".
 * @property {string} configFile - absolute path to the provider's `<provider>-config.json`.
 * @property {object} configDefaults - shape/defaults for the config object.
 * @property {string[]} requiredFields - config fields that must be truthy to start.
 * @property {(config: object, context: object) => object} buildEnv - maps config -> subprocess env vars.
 * @property {string} stateDir - absolute path to the provider's `state/` dir.
 * @property {(config: object) => object} maskConfig - returns the config shape safe to expose over REST/socket (secrets masked).
 * @property {(key: string, value: string) => string} [normalizeField] - optional per-field cleanup applied to incoming config values before they're stored (e.g. stripping a pasted URL down to the UUID it contains).
 * @property {number} [staleAfterMs] - optional: if the child's state/status.json `last_poll_at` is older than this while the child is running, the child is assumed hung and restarted.
 */

class SyncManager {
  /** @param {SyncProvider} provider */
  constructor(provider) {
    this.provider = provider;
    this.config = { ...provider.configDefaults };
    this.proc = null;
    this.restartPending = false;
    this.onExit = null; // optional (code) => void, for provider-specific cleanup on process exit
    this.stopping = false; // true while an operator-requested stop is in flight, so a crash restart is not scheduled
    this.startedAt = 0;
    this.crashBackoffMs = CRASH_BACKOFF_START_MS;
    this.crashRestartTimer = null;
    this.staleTimer = null;
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.provider.configFile)) {
        const saved = JSON.parse(fs.readFileSync(this.provider.configFile, 'utf8'));
        this.config = { ...this.config, ...saved };
      }
    } catch (error) {
      console.error(`Error loading ${this.provider.name} config:`, error);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.provider.configFile, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error(`Error saving ${this.provider.name} config:`, error);
    }
  }

  /**
   * Applies incoming field updates (e.g. from a socket `setConfig` event) to
   * this provider's config, generically: any string field present in
   * configDefaults gets trimmed and set, except a masked-secret placeholder
   * ('••••••••') is left untouched since that means "field not re-entered by
   * the operator, don't overwrite the real value with the mask". Fields not
   * part of this provider's config shape (e.g. sending Podium fields to
   * Challonge) are silently ignored. Does not touch `enabled` - that's
   * changed only via toggle(), never bundled into a config-field update.
   */
  applyConfigFields(fields) {
    for (const key of Object.keys(this.provider.configDefaults)) {
      if (key === 'enabled') continue;
      const value = fields[key];
      if (typeof value === 'string' && value !== '••••••••') {
        const trimmed = value.trim();
        this.config[key] = this.provider.normalizeField
          ? this.provider.normalizeField(key, trimmed)
          : trimmed;
      }
    }
  }

  maskedConfig() {
    return this.provider.maskConfig(this.config);
  }

  readStateFile(filename) {
    try {
      const filePath = path.join(this.provider.stateDir, filename);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error(`Error reading ${this.provider.name} state/${filename}:`, error);
      return null;
    }
  }

  isRunning() {
    return this.proc !== null;
  }

  start(context) {
    if (this.proc) return;
    const missing = this.provider.requiredFields.filter((f) => !this.config[f]);
    if (missing.length) {
      console.log(`${this.provider.name}: cannot start, missing ${missing.join(', ')}`);
      return;
    }

    console.log(`${this.provider.name}: starting sync`);
    clearTimeout(this.crashRestartTimer);
    this.crashRestartTimer = null;
    this.stopping = false;
    this.startedAt = Date.now();
    const env = { ...process.env, ...this.provider.buildEnv(this.config, context) };
    this.proc = spawn(this.provider.command, [this.provider.script, ...(this.provider.args || [])], {
      cwd: this.provider.dir,
      env,
    });

    const tag = this.provider.name;
    this.proc.stdout.on('data', (chunk) => console.log(`[${tag}] ${chunk.toString().trim()}`));
    this.proc.stderr.on('data', (chunk) => console.error(`[${tag}] ${chunk.toString().trim()}`));
    this.proc.on('close', (code) => {
      console.log(`${this.provider.name} sync process exited with code ${code}`);
      this.proc = null;
      this._stopStaleWatch();
      if (this.onExit) this.onExit(code);
      if (this.restartPending) {
        this.restartPending = false;
        this.start(context);
        return;
      }
      if (this.stopping || !this.config.enabled) return;
      // Nobody asked for this exit: respawn with backoff.
      if (Date.now() - this.startedAt > CRASH_BACKOFF_RESET_AFTER_MS) this.crashBackoffMs = CRASH_BACKOFF_START_MS;
      console.error(`${this.provider.name}: sync exited unexpectedly; restarting in ${this.crashBackoffMs / 1000}s`);
      this.crashRestartTimer = setTimeout(() => this.start(context), this.crashBackoffMs);
      this.crashBackoffMs = Math.min(this.crashBackoffMs * 2, CRASH_BACKOFF_MAX_MS);
    });
    this.proc.on('error', (err) => {
      console.error(`${this.provider.name} sync spawn error:`, err.message);
      this.proc = null;
    });
    this._startStaleWatch(context);
  }

  // Hung-process watchdog: a child that is alive but no longer reading (a
  // socket that died without an error, a stuck fetch) keeps its status.json
  // frozen. Providers that write it on every read can set staleAfterMs.
  _startStaleWatch(context) {
    const limit = this.provider.staleAfterMs;
    if (!limit) return;
    this._stopStaleWatch();
    this.staleTimer = setInterval(() => {
      if (!this.proc || Date.now() - this.startedAt < limit) return;
      const status = this.readStateFile('status.json');
      const lastPoll = status && status.last_poll_at ? Date.parse(status.last_poll_at) : NaN;
      if (Number.isNaN(lastPoll) || Date.now() - lastPoll < limit) return;
      console.error(`${this.provider.name}: no read since ${status.last_poll_at}; restarting hung sync`);
      this.restart(context);
    }, Math.max(30_000, Math.floor(limit / 4)));
  }

  _stopStaleWatch() {
    clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  /**
   * Asks the child for a full re-read and push (it listens for the line
   * "resync" on stdin). Returns false when nothing is running or the child
   * does not accept it.
   */
  resync() {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return false;
    this.proc.stdin.write('resync\n');
    return true;
  }

  /**
   * .kill() only sends SIGTERM — it doesn't wait for the process to actually
   * exit. Callers must not spawn a replacement until the previous process's
   * 'close' event has fired, or a stop()+start() pair leaks an orphaned
   * subprocess still holding the old connection/subscription. `callback`
   * fires once the process has actually closed (or immediately if it wasn't
   * running).
   */
  stop(callback) {
    this.stopping = true;
    clearTimeout(this.crashRestartTimer);
    this.crashRestartTimer = null;
    if (!this.proc) {
      if (callback) callback();
      return;
    }
    console.log(`${this.provider.name}: stopping sync`);
    this.proc.once('close', () => { if (callback) callback(); });
    this.proc.kill();
  }

  /** Signals the subprocess to poll immediately, for providers that support it (e.g. Challonge). Others ignore this. */
  pollNow() {
    if (this.proc) this.proc.kill('SIGUSR1');
  }

  restart(context) {
    if (this.proc) {
      this.restartPending = true;
      this.proc.kill();
    } else {
      this.start(context);
    }
  }

  /** Sets config.enabled and starts/stops the subprocess to match. Persists the config either way. */
  toggle(enabled, context) {
    this.config.enabled = !!enabled;
    this.saveConfig();
    if (this.config.enabled) {
      this.start(context);
    } else {
      this.stop();
    }
  }
}

module.exports = { SyncManager };
```

### C10. public/overlay-bind.js (full)

```js
// Injected into every /overlay/:id page (see server.js's GET /overlay/:id),
// right after socket.io.js and scorebug-render.js. Makes a pasted,
// self-contained HTML document live without the author needing to write
// any JS themselves: scans for [data-role] elements and keeps their text
// content in sync with the real gameState, using the exact same
// resolveBinding()/computeClockDisplay() the preset-based /display uses.
//
// Convention: data-role="teamName|score|clock|penalties|timeouts|
// timeoutCount|penaltyCount|timeoutBanner|penaltyBanner" and, where
// relevant, data-side="left|right". Anything without a data-role is left
// completely untouched - a pasted document can be as much or as little
// live as the author wants.
//
// timeoutBanner/penaltyBanner are transient, unlike every other role: a
// data-live-hidden attribute is toggled on the node when there's nothing to
// show (no active timeout / no penalty being announced for that side), and
// the author's own CSS decides what that means visually (display:none, a
// fade, a slide - see docs/scorebug-editor.md) rather than this script
// forcing display:none directly, so a custom show/hide transition stays
// possible.
//
// Deliberately much dumber than renderPreset(): no x/y/w/h layout, no
// autoSize, no element array - the author's own HTML/CSS IS the layout.
// This only ever touches textContent and the data-live-hidden attribute.
"use strict";

(function () {
  const socket = io();
  let latestGameState = null;

  // ------------------------------------------------------- penalty banner
  //
  // A penalty is announced as one banner that slides out once and changes
  // its word in three phases - "Penalty", then the player's name (skipped
  // when nobody was credited), then the severity - then slides back in.
  //
  // Which penalties are new is decided here, by id, against
  // gameState.penaltyLog (the current game's penalties as the provider
  // reports them right now - see server.js). The first state this page
  // sees, and the first state of every new game, seeds the "already shown"
  // set silently, so a page reload or a server restart never replays the
  // game's history. After that, an id not yet seen is a penalty to announce.
  //
  // Queued per side, not last-one-wins: one update can carry several real
  // penalties for the same side (two calls close together, a late poll),
  // each with its own player/severity. Each plays out in full; while the
  // queue is non-empty the banner stays out and restarts the sequence for
  // the next one rather than sliding in and out between them.
  const PENALTY_PHASE_MS = 2000;
  const penaltyQueues = { left: [], right: [] }; // side -> [{phases: [text, ...]}, ...]
  const penaltyAnnouncements = { left: null, right: null }; // side -> {phases, startedAt}
  let seenPenaltyIds = new Set();
  let seenGameId = null;
  let seeded = false;

  function penaltyPhases(penalty) {
    const phases = ["Penalty"];
    if (penalty.player) phases.push(penalty.player);
    const label = PENALTY_SEVERITY_LABEL[penalty.severity];
    phases.push(label || (penalty.severity ? String(penalty.severity).toUpperCase() : "Penalty"));
    return phases;
  }

  function notePenalties(gameState) {
    const log = gameState.penaltyLog;
    const gameId = log ? log.gameId : null;
    const items = (log && log.items) || [];
    if (!seeded || gameId !== seenGameId) {
      seenPenaltyIds = new Set(items.map(p => p.id));
      seenGameId = gameId;
      seeded = true;
      return;
    }
    for (const penalty of items) {
      if (penalty.id == null || seenPenaltyIds.has(penalty.id)) continue;
      seenPenaltyIds.add(penalty.id);
      if (penalty.side !== "left" && penalty.side !== "right") continue;
      penaltyQueues[penalty.side].push({ phases: penaltyPhases(penalty) });
    }
  }

  // The text the side's penalty banner should show right now, or null to
  // hide it. Advances phases by elapsed time and starts the next queued
  // announcement the moment the current one ends.
  function penaltyTextFor(side, now) {
    let current = penaltyAnnouncements[side];
    if (current) {
      const phase = Math.floor((now - current.startedAt) / PENALTY_PHASE_MS);
      if (phase < current.phases.length) return current.phases[phase];
      current = penaltyAnnouncements[side] = null;
    }
    const next = penaltyQueues[side].shift();
    if (!next) return null;
    penaltyAnnouncements[side] = { phases: next.phases, startedAt: now };
    return next.phases[0];
  }

  // ------------------------------------------------------- timeout banner
  //
  // gameState.activeTimeout is {side, remainingSeconds} or null, worked out
  // by server.js from the provider's data at the moment of the update
  // (Shufflepolo: a timeout stops the clock and ends when the clock runs
  // again, with a 120 s ceiling; Podium reports the countdown directly).
  // Updates only arrive when something changed, so the ceiling is counted
  // down locally from the update's arrival rather than waiting for one.
  function timeoutActiveFor(side) {
    const at = latestGameState.activeTimeout;
    if (!at || at.side !== side) return false;
    const elapsed = (Date.now() - latestGameState._activeTimeoutAnchorAt) / 1000;
    return at.remainingSeconds - elapsed > 0;
  }

  // ------------------------------------------------------------ rendering

  function boundNodes() {
    return document.querySelectorAll("[data-role]");
  }

  function setLiveHidden(node, hidden) {
    if (hidden) node.setAttribute("data-live-hidden", "");
    else node.removeAttribute("data-live-hidden");
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function renderPenaltyBanner(node, now) {
    const text = penaltyTextFor(node.dataset.side || null, now);
    setLiveHidden(node, text == null);
    if (text != null) setText(node, text);
  }

  function renderTimeoutBanner(node) {
    const side = node.dataset.side || null;
    const active = timeoutActiveFor(side);
    setLiveHidden(node, !active);
    if (active) setText(node, resolveBinding("timeoutBanner", side, latestGameState, null) || "Timeout");
  }

  function renderNode(node) {
    const role = node.dataset.role;
    const side = node.dataset.side || null;
    if (!latestGameState) return;
    if (role === "penaltyBanner") return renderPenaltyBanner(node, Date.now());
    if (role === "timeoutBanner") return renderTimeoutBanner(node);
    node.textContent = resolveBinding(role, side, latestGameState, null);
    shrinkToFit(node);
  }

  // Team names (and any other single-line data-role text) come from
  // whatever the real roster/platform data says - an author's pasted CSS
  // sizes its box/font against whatever placeholder text they happened to
  // test with (often short, like "Hammers"), so a longer real name
  // wrapping to a second line - breaking a fixed-height single-row layout
  // - is a near-certain live-game surprise, not an edge case. Rather than
  // require every overlay author to hand-tune font-size for worst-case
  // name length, every data-role text node gets this generically: force
  // single-line (no wrap), then shrink font-size in integer px steps
  // until it fits the node's own width, down to a floor that keeps it
  // legible rather than shrinking to nothing for a truly long name.
  // Grows back toward the CSS-authored size first (not just shrinks),
  // since a later update's text might be SHORTER than a previous one that
  // triggered shrinking (e.g. a team name correction, or switching games).
  const SHRINK_FLOOR_PX = 10;
  const SHRINK_STEP_PX = 1;
  const naturalFontSizeCache = new WeakMap(); // node -> the CSS-authored font-size, read once

  function shrinkToFit(node) {
    if (!node.textContent) return;
    node.style.whiteSpace = "nowrap";
    const computed = getComputedStyle(node);
    if (!naturalFontSizeCache.has(node)) {
      naturalFontSizeCache.set(node, parseFloat(computed.fontSize));
    }
    const naturalSize = naturalFontSizeCache.get(node);
    // Reset to the natural size first - this update's text may fit fine
    // even if a previous update's (longer) text didn't.
    node.style.fontSize = naturalSize + "px";
    let size = naturalSize;
    while (node.scrollWidth > node.clientWidth && size > SHRINK_FLOOR_PX) {
      size -= SHRINK_STEP_PX;
      node.style.fontSize = size + "px";
    }
  }

  function renderAll() {
    boundNodes().forEach(renderNode);
  }

  // Same 250ms clock-tick cadence as display.html: the clock interpolates
  // between updates, the timeout ceiling counts down, and penalty phases
  // advance - none of which get an update of their own from the server.
  setInterval(() => {
    if (!latestGameState) return;
    latestGameState._currentClock = latestGameState.clock
      ? { ...latestGameState.clock, localAnchorAt: latestGameState._clockAnchorAt }
      : null;
    document.querySelectorAll('[data-role="clock"]').forEach(node => {
      setText(node, computeClockDisplay(latestGameState._currentClock || null).text);
    });
    document.querySelectorAll('[data-role="timeoutBanner"]').forEach(renderTimeoutBanner);
    const now = Date.now();
    document.querySelectorAll('[data-role="penaltyBanner"]').forEach(node => renderPenaltyBanner(node, now));
  }, 250);

  socket.on("gameUpdate", (gameState) => {
    // Anchor the clock to this device's receipt time - see display.html's
    // own identical comment on gameState._clockAnchorAt for why this must
    // happen before anything else touches the clock.
    gameState._clockAnchorAt = Date.now();
    gameState._currentClock = gameState.clock ? { ...gameState.clock, localAnchorAt: gameState._clockAnchorAt } : null;
    // Same receipt-time anchoring for the timeout ceiling.
    gameState._activeTimeoutAnchorAt = Date.now();
    notePenalties(gameState);
    latestGameState = gameState;
    renderAll();
  });
})();
```

### C11. public/scorebug-render.js: clock section (lines 1-148)

```js
"use strict";
// Shared rendering/data-binding logic for the scorebug system. Two
// consumers: public/display.html (renderPreset/tickClockElements, for the
// legacy element-based preset layout still supported for backward
// compatibility) and public/overlay-bind.js (resolveBinding/
// computeClockDisplay only, for the [data-role] live-binding on pasted
// HTML overlays - see docs/sync.md and docs/scorebug-editor.md). Both
// paths share the exact same gameState -> display-text resolution, so
// they can never drift apart by having two hand-kept implementations.
//
// Everything here is pure / stateless except where explicitly noted (the
// clock helpers take an externally-anchored clock object rather than
// tracking time themselves, so callers own their own render loop).

// ---------------------------------------------------------------- clock
//
// Each sync provider pushes its own native clock shape into gameState.clock
// rather than a common one, and each is kept in sync with the real game
// clock by a different means:
//
//   Podium:       { running, phase, remaining_seconds, formatted, ... }
//                 pushed on discrete events (goal, penalty, start/stop) PLUS
//                 a 100ms re-push ticker while running, so remaining_seconds
//                 is never more than ~100ms stale - interpolating the small
//                 gap locally (from THIS device's own receipt time) is a
//                 fine approximation at that push rate.
//
//   Shufflepolo:  { status, elapsed_seconds, running_since, duration_seconds,
//                   server_now }
//                 pushed only on realtime signals (score/clock change) -
//                 could be many seconds or minutes between pushes, so
//                 interpolating from local receipt time would accumulate
//                 real drift from anything that delays the moment this
//                 device actually processes a push (a slow preset fetch, a
//                 busy event loop, network jitter) - see the incident this
//                 is fixing, where switching presets visibly desynced the
//                 clock from Shufflepolo's own site.
//
//                 Instead, elapsed time is computed as
//                 (their-clock-right-now - running_since), where "their
//                 clock right now" is this device's Date.now() plus
//                 clock_offset_ms - a clock-sync offset MEASURED ONCE, as
//                 close as possible to the real network round trip, by
//                 shufflepolo_sync.js (see its updateClockOffset: a
//                 t0/t1-bracketed request, offset = server_now -
//                 midpoint(t0,t1), keeping only the fastest round trip
//                 seen). Per a Shufflepolo dev's own analysis of our
//                 drift: computing that offset any later - e.g. here in
//                 the browser, against a server_now that already crossed
//                 this process's own POST + this server's socket
//                 broadcast - bakes in however long those extra hops took
//                 as permanent (and different every time) error. Using a
//                 precomputed offset instead of a raw server_now means
//                 nothing downstream of the original round trip ever
//                 re-measures skew against stale data.

function secondsFromPodiumClock(clock, elapsedSeconds) {
  if (!clock.running) return { secs: clock.remaining_seconds, overtime: clock.phase === "overtime" };
  if (clock.phase === "overtime") {
    return { secs: Math.floor(clock.remaining_seconds + elapsedSeconds), overtime: true };
  }
  return { secs: Math.max(Math.ceil(clock.remaining_seconds - elapsedSeconds), 0), overtime: false };
}

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

// currentClock: gameState.clock spread with a localAnchorAt (Date.now() at
// receipt), or null. Returns { text, stopped } - stopped is true when the
// clock should render dim/paused styling.
// TEMPORARY debug instrumentation for tracking down a live clock-desync
// report (editor/display/Shufflepolo's own site disagreeing after Save +
// Set Active) - logs at most once every CLOCK_DEBUG_INTERVAL_MS per page,
// tagged with window.CLOCK_DEBUG_LABEL (set that in each page's console,
// e.g. CLOCK_DEBUG_LABEL="editor", to tell surfaces apart in a shared log).
// Remove this block once the bug's confirmed fixed.
const CLOCK_DEBUG_INTERVAL_MS = 2000;
let _lastClockDebugLogAt = 0;
function debugLogClock(currentClock, result){
  if (typeof window === "undefined" || !window.CLOCK_DEBUG) return;
  const now = Date.now();
  if (now - _lastClockDebugLogAt < CLOCK_DEBUG_INTERVAL_MS) return;
  _lastClockDebugLogAt = now;
  const label = window.CLOCK_DEBUG_LABEL || "?";
  console.log("[clock:" + label + "]", {
    now: new Date(now).toISOString(),
    status: currentClock && currentClock.status,
    running_since: currentClock && currentClock.running_since,
    elapsed_seconds: currentClock && currentClock.elapsed_seconds,
    duration_seconds: currentClock && currentClock.duration_seconds,
    clock_offset_ms: currentClock && currentClock.clock_offset_ms,
    result: result.text,
  });
}

// Shared by the main clock and timeoutBanner - plain "M:SS", no sign/
// padding beyond seconds (a timeout never runs into overtime, so this never
// needs computeClockDisplay's "+" prefix handling).
function formatMinutesSeconds(totalSeconds) {
  const secs = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  return mm + ":" + ss;
}

function computeClockDisplay(currentClock) {
  // "--:--" rather than "" - an empty string measures to ~0 width, which
  // collapses an autoSized clock element down to the Math.max(1,...) floor
  // (a near-invisible 1x1px box) whenever there's no live game, instead of
  // just showing no time. A placeholder keeps the box's size (and
  // visibility) stable regardless of whether a game is currently running.
  if (!currentClock) return { text: "--:--", stopped: true };

  const isShufflepolo = currentClock.status !== undefined;
  let secs, overtime, running;
  if (isShufflepolo) {
    // Falls back to 0 (trust local time as-is) if clock_offset_ms wasn't
    // sent - shouldn't happen with a current shufflepolo_sync.js, but a
    // mid-rollout mismatch or an old cached push shouldn't hard-fail the
    // clock.
    const offsetMs = typeof currentClock.clock_offset_ms === "number" ? currentClock.clock_offset_ms : 0;
    const skewCorrectedNowMs = Date.now() + offsetMs;
    ({ secs, overtime, running } = secondsFromShufflepoloClock(currentClock, skewCorrectedNowMs));
  } else {
    const elapsedSeconds = (Date.now() - currentClock.localAnchorAt) / 1000;
    ({ running } = currentClock);
    ({ secs, overtime } = secondsFromPodiumClock(currentClock, elapsedSeconds));
  }

  const formatted = formatMinutesSeconds(secs);
  const result = { text: overtime ? "+" + formatted : formatted, stopped: !running };
  debugLogClock(currentClock, result);
  return result;
}

```

### C12. simulate-game-states.js (full)

```js
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
```

### C13. shufflepolo-config.json (current)

```json
{
  "tournamentId": "b3ac9fb1-408d-42eb-a7d7-f93d815ca9c6",
  "court": "1",
  "feedUrl": "",
  "enabled": true
}
```

### C14. docs/shufflepolo-receiver-update.md (sent to the dev 2026-10-09)

```markdown
# scorebored receiver update for the Shufflepolo dev (2026-10-09)

Thanks for the contract write-up and the corrected copy of our sync script.
We rebuilt our receiver on it. Summary of what changed on our side, and two
small questions at the end.

## What we fixed

- **We now join every topic in `realtime.topics`.** Our old client joined
  `games:<id>` only, so it never heard a penalty (those are on `feed:<id>`
  alone). That was the whole "realtime looks healthy but updates lag"
  mystery: penalties only showed up on our next safety poll.
- **We stopped polling every 2 seconds.** That was our workaround for the
  missing penalties. The safety poll is back to the contract's once per
  5 minutes; realtime is the update path again, with the 2-second re-read
  throttle and one trailing read after a burst.
- **Every read sends `If-None-Match`.** A 304 costs you one function call
  and no egress, and we write and push nothing on it. Idle, our receiver
  now generates no traffic beyond the 5-minute 304s.
- **We re-read at each live clock's `live_until`**, counted against
  `server_now` with our measured offset.
- **We follow one court via `courts[].current_game`** (court number from
  our config) and take the clock from `live[]`/`suspended[]` by id. The
  old `live[0]` logic is gone.
- **Clock offset** now uses your reference client's sampling: fastest
  round trip wins, held samples age, and a wall-clock step on our side
  (the Pi has no RTC) re-measures immediately.
- **`null` event lists are "not included", never "none"**; an unknown
  `status` makes a game not live rather than failing the read. We only use
  the default `events=active` scope: we dropped our play-by-play feed, so
  we never need `events=all`.
- The receiver pushes to our scoreboard only when the snapshot changed,
  and our server only saves/broadcasts on an actual change.

## What we observed

- The ETag/304 path works exactly as documented against production.
- One socket close (code 1006) during a 2.5-hour watch, rejoined within
  two seconds, no reads lost. Matches your "disconnects are normal" note.
- Our previous 2-second full reads were costing roughly 340 MB per
  10-hour day of your egress. Sorry about that; it is near zero now.

## Two questions

1. **Timeouts.** We found `TIMEOUT_SECONDS = 120` and `timeout_ends_at` in
   your console code, and that calling a timeout stops the clock in the
   same statement. We show the timeout banner while the newest timeout is
   more recent than the last clock start and the clock is paused, with
   120 s as a ceiling. Is that the right reading? If `timeout_ends_at`
   ever makes it into the feed we would use it directly, but this works
   without it.
2. **Safety poll interval.** 5 minutes is what we run. If you are
   comfortable with a shorter conditional poll (say 60 s, always with
   `If-None-Match`, so a 304 when idle), we would take it as extra
   insurance on cellular. If not, 5 minutes is fine.
```
