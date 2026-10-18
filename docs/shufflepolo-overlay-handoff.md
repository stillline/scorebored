# Shufflepolo API and overlay logic: handoff for another agent

Written 2026-10-16 from the `API_REWORK` branch of scorebored on the Pi
(`/home/matthew/bin/scorebored`). Everything here is live-tested but
uncommitted. This document is for an agent that needs to build or change
on-air overlay logic against Shufflepolo data. It covers three layers:

1. The Shufflepolo scoreboard feed (the upstream API).
2. How scorebored turns the feed into `gameState` (server side).
3. How a pasted HTML overlay binds to `gameState` in the browser (the part an
   overlay author or overlay-logic agent actually touches).

Full source of every Shufflepolo-related file is in `SHUFFLEPOLO_HANDOFF.md`
(part C). The upstream contract is `shufflepolo_repo/shufflepolo-app-main/docs/scoreboard-feed.md`
(git-ignored local copy). Related docs: `docs/sync.md`, `docs/scorebug-editor.md`,
`docs/shufflepolo-clock-sync-fix.md`.

---

## 1. Shufflepolo scoreboard feed (upstream API)

### 1.1 Endpoint

```
GET https://xavxyvnrtqccnyonlfeu.supabase.co/functions/v1/scoreboard-feed?tournament=<uuid>[&events=all]
```

| Parameter | Required | Meaning |
|---|---|---|
| `tournament` | yes | Tournament UUID. It is the UUID in `https://shufflepolo.com/t/<uuid>`. There is no list endpoint. |
| `events` | no | `active` (default): only games in `live`, `suspended`, `up_next`, `recent_results` and each court's `current_game` carry `goals`/`penalties`/`timeouts`; all other games have those lists as `null`. `all`: every game carries lists. scorebored uses the default. |

- No auth, no headers needed. CORS open. `Cache-Control: no-store`.
- Every 200 carries a weak `ETag` (content hash excluding `server_now`). Send
  it back as `If-None-Match`; an unchanged snapshot answers `304` with no body.
- Published tournaments only. Shows exactly what a signed-out visitor sees.

| Status | Meaning |
|---|---|
| 200 | Snapshot, with ETag. |
| 304 | Unchanged. Keep the snapshot and the clock offset you already hold. |
| 400 | `invalid_tournament` or `invalid_events`. |
| 404 | `not_found`: no such tournament, or unpublished (indistinguishable). Keep the last snapshot on screen. |
| 405 | Only GET served. |
| 503 | `unavailable`, temporary. Keep showing what you have. |

### 1.2 Realtime (change signals)

Each snapshot carries a `realtime` block:

```json
"realtime": {
  "url": "https://xavxyvnrtqccnyonlfeu.supabase.co",
  "websocket_url": "wss://xavxyvnrtqccnyonlfeu.supabase.co/realtime/v1/websocket",
  "api_key": "<public anon key, take it from the snapshot>",
  "topic": "games:<tournament-id>",
  "topics": ["games:<tournament-id>", "feed:<tournament-id>"],
  "private": true
}
```

- Supabase Realtime, private broadcast channels. One client, one socket,
  join every topic in `topics`. Always take url/key/topics from the snapshot;
  the key can rotate.
- `games:<id>` carries scores, clock start/pause/correct/end, games added or
  re-timed, bracket slots filled, referee assigned.
- `feed:<id>` carries goals, penalties, timeouts. Goals and timeouts also hit
  the game topic because they move score or clock. **A penalty is only ever on
  `feed:<id>`.**
- Messages are signals, not data. Never parse event name or payload. Every
  message means "re-read the snapshot".
- Not signalled (picked up by the safety poll only): team renamed, court
  named, tournament details edited, section hidden/shown, final rankings.

### 1.3 Usage rules (the contract's numbers, do not lower them)

1. One websocket per process, all topics joined on it.
2. Re-read on every `SUBSCRIBED` (including after reconnect). Missed messages are not replayed.
3. Throttle re-reads to one per 2 s, with one trailing read after a burst.
4. Re-read once at each live clock's `live_until` (the one change with no message).
5. Safety poll at most once per 5 minutes.
6. Always send `If-None-Match`.
7. Leave `events` at default unless showing play-by-play for out-of-scope games.
8. Unknown `status` value: skip that game, never reject the snapshot.
9. Reconnect backoff 1 s, 2 s, 4 s ... 60 s. `Unauthorized` on join = unpublished; keep last snapshot, keep backing off.

### 1.4 Snapshot schema (version 1)

Times are ISO 8601 UTC. Ids are UUIDs. Unknown fields may appear; ignore them.
The same game object appears in `games`, `live`, `suspended`, `up_next`,
`recent_results` and `courts[].current_game`.

Top level: `version` (1), `server_now`, `tournament {id, name, start_date,
end_date, time_zone, url, archived}`, `courts[]`, `teams[] | null`, `games[]`,
`live[]`, `suspended[]`, `up_next[]` (up to 6 scheduled), `recent_results[]`
(up to 6 final, latest first), `realtime`.

`courts[]`: `{number, name | null, current_game | null}`. Match on `number`,
not array position.

`teams[]`: `{id, name, seed | null, final_rank | null}`. `null` when the
organizer hides teams (player names are then `null` everywhere too).

Game object (`games[]` and all the lists):

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `context` | `"group"` or `"bracket"` | |
| `section` | string or null | Group name or bracket name. |
| `phase` | `{type, loss_tier}` or null | Bracket phase, see 1.8. |
| `round`, `day` | number | Day from 1. |
| `starts_at` | string or null | Scheduled start including delays. |
| `court`, `court_name` | number or null, string or null | |
| `team1`, `team2` | `{team_id, name, score}` | `team_id`/`name` null while TBD; `score` null until scored, a live game starts at 0. |
| `referee` | string or null | |
| `status` | `scheduled`, `live`, `suspended`, `final` | More may be added. |
| `goals`, `penalties`, `timeouts` | array or null | **`null` = not included in this read, never "none".** |

Event item (shared shape): `{id, team_id, game_seconds | null, at, player
{id, name} | null}`. Penalties add `code`. Timeouts always have `player: null`.
`game_seconds` is seconds of play since kickoff (counts up even on a countdown
clock) and is the time to caption with. `at` is wall clock, record keeping only.

Live/suspended entries add `clock`:

| Field | Type | Notes |
|---|---|---|
| `status` | `running` or `paused` | |
| `elapsed_seconds` | number | Banked seconds before the current run, fractional. **Can be negative** (game lengthened before kickoff). |
| `running_since` | string or null | Server-clock time the current run began. Null while paused. |
| `duration_seconds` | number or null | Null = count-up clock with no game length. |
| `overtime` | boolean | True once a level bracket game is counting up past full time (running or paused). |
| `live_until` | string or null | When the game stops being live with nobody pressing anything. Null for count-up clocks, running overtime, and every suspended game. |

`courts[].current_game` has **no `clock`**; when its status is `live`, take
the clock from the `live[]` entry with the same `id`.

### 1.5 Game status semantics

- `live`: clock running short of full time, or paused short of full time with a clock change in the last 10 minutes. A level bracket game at full time is in overtime and stays live.
- `suspended`: paused with no clock change for 10 minutes, or another game started on its court. Holds remaining time and score; becomes live again if restarted. Never a court's `current_game`.
- `final`: both scores in, not live or suspended.
- `scheduled`: everything else. A game with goals but no clock started is not live.
- Archived tournament: `live` empty, all event lists empty.

### 1.6 `courts[].current_game` selection (done upstream, not by us)

1. The court's live game (earliest if two).
2. Else the next game after the court's last finished game. A level bracket game is not finished. Suspended games are skipped.
3. Else the court's last game of the day (status `final`).
4. `null` only for a court with no visible games.

### 1.7 Clock math (contract)

```
offset_ms  = Date.parse(server_now) - (sent_ms + received_ms) / 2    # keep the fastest round trip
played_ms  = elapsed_seconds*1000 + (now_ms + offset_ms - Date.parse(running_since))   # running
played_ms  = elapsed_seconds*1000                                                        # paused
overtime:            show floor((played_ms - duration_seconds*1000)/1000), counting up, "Overtime" label
duration set:        show max(0, ceil((duration_seconds*1000 - played_ms)/1000)), countdown
duration null:       show floor(played_ms/1000), counting up
```

Never decrement a counter per tick; recompute from timestamps every frame
(repaint ~10 times a second). Truncating a countdown shows one second less
than the official's console for the whole game.

### 1.8 Code tables

Penalty `code`: `bt` ball turnover (0 points), `mi` minor (1), `ma` major (2),
`pm` personal misconduct (ejection).

Phase `type`: `winners` Winners, `losers` Losers, `consolation` "n Losses"
(`loss_tier`, "1 Loss" singular), `final` Grand Final, `final_reset` Final
Reset, `ladder` Finals, `third_place` Third Place.

### 1.9 Play-by-play rules

- Lists are cumulative and in recording order. Diff by `id` in both
  directions: new id = new event, missing id = taken back (remove from screen).
  A game reset empties all lists, scores go to null, status to scheduled.
- Diff only where both snapshots carry a list. Present to `null` means the
  game left the short lists, nothing was taken back. `null` to present is
  history: add ids silently.
- Seed "seen" ids silently from the first snapshot and after any restart.
  Keep the set across reconnects.
- Score is the record of the score; a hand-typed score has no goals behind it.
  Never derive one from the other. Score and events can briefly disagree
  between two reads; the next read settles it.

---

## 2. How scorebored consumes the feed (server side)

### 2.1 Pipeline

```
shufflepolo.com feed + realtime
  -> shufflepolo_sync/shufflepolo_sync.js   (one child process per tournament, run by lib/sync.js SyncManager)
       POST /api/sync/shufflepolo/push   only on a 200 (something changed)
  -> server.js applyShufflepoloSnapshot() inside commitGameState()
       change-gated: identical gameState JSON = no save, no broadcast
  -> socket.io event 'gameUpdate' (the whole gameState object)
  -> browser: public/overlay-bind.js + public/scorebug-render.js
```

Config: `shufflepolo-config.json` `{tournamentId, court, feedUrl, enabled}`.
`court` is the court number shown on shufflepolo.com (default 1). The sync
follows that court's `current_game` only; nothing else reaches the scoreboard.

### 2.2 What the sync pushes (`buildPush` in shufflepolo_sync.js)

```js
{
  connected: true,
  has_game: game.status === 'live',   // true ONLY for status live
  court, game_id, status,
  clock_offset_ms,                     // Shufflepolo clock minus this machine's, measured at the HTTP round trip
  team1: { team_id, name, score },
  team2: { team_id, name, score },
  clock: <clock from live[]/suspended[] by id, or null>,
  goals: game.goals ?? null,
  penalties: game.penalties ?? null,
  timeouts: game.timeouts ?? null,
}
// no game on the court:
{ connected: true, has_game: false, court, game_id: null, status: null }
```

### 2.3 `applyShufflepoloSnapshot` (server.js ~line 397)

- `gameState.gameId = game_id`, `has_game = live`, `status = live ? 'in_progress' : null`.
- `gameState.clock = live ? {...clock, clock_offset_ms} : null`. The offset
  rides on the clock object untouched so browsers never re-measure skew.
- **Not live** (final, scheduled, suspended, unknown): keep last team names
  and scores on screen, clear `penalties`, `timeouts`, `activeTimeout`,
  `penaltyLog`. Suspended is deliberately "not live", not a paused clock.
- **Live**: left/right = team1/team2 unless `gameState.sidesSwapped`.
  `leftTeam`/`rightTeam` = names, `leftScore`/`rightScore` = scores (null -> 0).
  `sideFor(team_id)` maps to `'left'`/`'right'`.
- Penalties (only when the pushed value is an array):
  `{id, side, player: player?.name ?? null, severity}` with code mapped
  `bt->turnover`, `mi->minor`, `ma->major`, `pm->ejection` (unknown codes pass
  through). `gameState.penalties = {left: [...], right: [...]}` and
  `gameState.penaltyLog = {gameId, items: [all]}`.
- Timeouts (only when an array): `gameState.timeouts = {left, right}` =
  remaining count, 2 per team minus used (platform constant). If the clock is
  `running`, every timeout id is added to an in-memory `endedTimeoutIds`.
  `gameState.activeTimeout = computeShufflepoloActiveTimeout(...)`:
  - null if no timeouts, no clock, or clock running;
  - take the newest timeout; null if it is in `endedTimeoutIds`;
  - `remaining = 120 - (nowOnServer - at)/1000` using `clock_offset_ms`;
  - `{side, remainingSeconds: ceil(remaining)}` if > 0, else null.
  Rationale: Shufflepolo's console stops the clock when a timeout is called
  and ends it when the clock starts again. The feed carries no end time, so
  "clock has run since the newest timeout" is the end signal, with 120 s as a
  ceiling. `endedTimeoutIds` is in-memory; after a restart the 120 s window
  hides anything older.
- **Goals are pushed but currently dropped by the server** (see section 5).

### 2.4 `gameState` fields an overlay can see

Broadcast whole on every `gameUpdate`. Fields relevant to overlays:

| Field | Shape | Notes |
|---|---|---|
| `leftTeam`, `rightTeam` | string | Team names (already side-resolved). |
| `leftScore`, `rightScore` | number | |
| `leftColor`, `rightColor`, `leftScoreTextColor`, `rightScoreTextColor`, `textColor`, `backgroundColor` | css color strings | Manual colours from /control; not bound by overlay-bind.js. |
| `sidesSwapped` | boolean | Applied server-side already. |
| `clock` | Shufflepolo clock object + `clock_offset_ms`, or null | Also Podium shape `{running, phase, remaining_seconds}` when that provider is on. |
| `penalties` | `{left: [{id, side, player, severity}], right: [...]}` or null | Current game's penalties per side. No duration fields from Shufflepolo. |
| `timeouts` | `{left: n, right: n}` or null | Remaining timeouts per side. |
| `activeTimeout` | `{side, remainingSeconds}` or null | Computed at update time. |
| `penaltyLog` | `{gameId, items: [{id, side, player, severity}]}` or null | What the provider reports right now, not a persisted log. |
| `gameId` | string or null | Shufflepolo game id. Lets a page tell new game from same game. |
| `has_game` | boolean | True only when the followed game is live. |
| `status` | `'in_progress'` or null | |
| `activeKind`, `activeId` | `'preset'`/`'overlay'`/null, id | What /display renders. |
| `ladder` | `{active, tournament}` | Bracket ladder layer on /display. |
| `commercialBreak` | `{active, videoPath, ...}` | |

Browser-only fields added on receipt by overlay-bind.js (underscore-prefixed,
never sent by the server): `_clockAnchorAt`, `_currentClock`,
`_activeTimeoutAnchorAt`.

---

## 3. Overlay system (what an overlay-logic agent touches)

### 3.1 Overlay files and composition

- An overlay is `overlays/overlay_<id>.json`: `{id, name, versions[],
  activeVersion, logos[], blockTransforms{}, locked?, rating, createdAt,
  updatedAt}`. Each version has `blocks[]`, each block `{id, name, html}` where
  `html` is a complete self-contained HTML document (own `<style>`).
- `GET /overlay/:id` serves the composite: a fixed 1920x1080 black page with
  one `<iframe src="/overlay/:id/block/:blockId">` per block (positioned by
  its `blockTransforms` entry: zoomX/zoomY/posX/posY/rotation/z, Resolve-style,
  centred on 960,540) plus logo `<img>`s. Not responsive by design.
- `GET /overlay/:id/block/:blockId` serves one block's document with the
  runtime injected (`injectBlockRuntime`): `<style>html,body{overflow:hidden
  !important}</style>` into `<head>`, and before `</body>`:
  `/socket.io/socket.io.js`, `/scorebug-render.js`, `/overlay-bind.js`.
- Each block is its own iframe, so CSS and ids never collide across blocks,
  and each block runs its own socket + its own banner state.
- The kiosk Chromium renders `/display`, which hosts the active overlay; the
  ATEM keys on **luma**: pure black is transparent. Keep backgrounds `#000`
  and keep colours above the ~25% luma floor so they are not keyed away.
  Logos are hard-thresholded and flattened to black server-side for the same
  reason.
- The locked default "Scorebug" is `overlays/overlay_daca270d.json`
  (`locked: true`, tracked in git). Edit routes answer 423 for it. Change it
  by editing the block `html` in the file, then `POST /api/display/reload`.
  It still contains a dead "Kill Feed" block (the kill feed was removed).

### 3.2 Live data binding contract (`public/overlay-bind.js`)

Mark elements with `data-role` and, where relevant, `data-side="left|right"`.
Everything without `data-role` is never touched. The script only ever sets
`textContent`, toggles the `data-live-hidden` attribute, and (for text roles)
sets `white-space: nowrap` and shrinks `font-size`.

| `data-role` | `data-side` | Resolves to (`resolveBinding` in scorebug-render.js) |
|---|---|---|
| `teamName` | yes | `leftTeam` / `rightTeam` |
| `score` | yes | `String(leftScore ?? 0)` / right |
| `clock` | no | `computeClockDisplay(_currentClock).text`: `M:SS`, `+M:SS` in overtime, `--:--` when no clock |
| `timeouts` | no | `"<left> - <right>"` remaining |
| `penalties` | no | Combined string `"A <player|severity|PEN> <time>  ·  ... B ..."`; time shows `--` when frozen or from `remaining_seconds` (Shufflepolo gives none, so it renders `0:00`) |
| `timeoutCount` | yes | remaining timeouts for that side as a string |
| `penaltyCount` | yes | number of penalties for that side as a string |
| `timeoutBanner` | yes | Transient. Text `"Timeout"` while `activeTimeout.side === side` and the locally counted-down ceiling is > 0; otherwise `data-live-hidden` set. |
| `penaltyBanner` | yes | Transient. Phased announcement, see 3.4. Not resolved by `resolveBinding` (returns null); overlay-bind.js owns it. |

Legacy preset-only role: `label` (static text from the element definition).
Unknown roles resolve to `""`.

### 3.3 Render loop

- On `gameUpdate`: stamp `_clockAnchorAt = Date.now()` and
  `_activeTimeoutAnchorAt = Date.now()` **before anything else**, build
  `_currentClock = {...clock, localAnchorAt}`, run `notePenalties`, store the
  state, render every bound node.
- Every 250 ms: recompute clock text for all `[data-role="clock"]`, re-evaluate
  timeout banners (ceiling counts down locally from receipt because updates
  only arrive on change), advance penalty banner phases.
- Clock in the browser (`computeClockDisplay`): if `clock.status` is defined
  it is Shufflepolo: `skewCorrectedNow = Date.now() + clock_offset_ms`,
  `played = elapsed_seconds + max(0, (skewCorrectedNow - running_since)/1000)`
  when running. Countdown is `ceil`, count-up is `floor`. `stopped` is true
  when not running. **Known gap: `clock.overtime` is ignored, so overtime
  shows `0:00` instead of counting up with a `+`.** Podium's path already
  renders `+M:SS`, so the fix is in `secondsFromShufflepoloClock`.
- `shrinkToFit`: every non-banner text node is forced single-line and its
  font-size reduced in 1 px steps (floor 10 px) until `scrollWidth <=
  clientWidth`, resetting to the CSS-authored size first on each update. Give
  bound text nodes an explicit width or they never shrink.

### 3.4 Penalty banner logic (browser, id-based)

- State per block page: `seenPenaltyIds`, `seenGameId`, `seeded`, per-side
  queues and the current announcement.
- `notePenalties(gameState)`: if not yet seeded, or `penaltyLog.gameId`
  changed, replace the seen set with all current ids **silently** (no
  announcement). This means a page reload, a server restart, or a new game
  never replays history. Otherwise, each id not yet seen is added and queued
  on its `side` (ids with a side other than left/right are ignored).
- Phases, 2000 ms each (`PENALTY_PHASE_MS`): `"Penalty"`, then the player
  name (skipped when null), then the severity label from
  `PENALTY_SEVERITY_LABEL` (`minor->MINOR`, `major->MAJOR`,
  `turnover->TURNOVER`, `ejection->EJECTED`; unknown severities render
  uppercased). Then hidden.
- Queued per side, not last-one-wins: a push with two penalties for one side
  plays both in full, the banner staying out and restarting the sequence.
- No countdown by design: the feed has no penalty duration.
- Note: taken-back penalties (id disappears) are not un-announced; the
  banner is already gone within 6 s.

### 3.5 Timeout banner logic

- Driven by `gameState.activeTimeout` from the server (section 2.3). The word
  only, no countdown (operator decision).
- Browser: visible while `activeTimeout.side === side` and
  `remainingSeconds - (Date.now() - _activeTimeoutAnchorAt)/1000 > 0`.
- It clears when the clock runs again (server recomputes on the next push)
  or when the 120 s ceiling expires locally.

### 3.6 Authoring rules for transient banners (from docs/scorebug-editor.md)

1. Always include a CSS rule for `[data-live-hidden]`; the script never sets
   `display:none` itself.
2. Put `data-live-hidden` on the element in the pasted markup so the first
   show animates from a hidden state instead of snapping.
3. Give banners a fixed `width` and `box-sizing: border-box` so only position
   animates, not size.
4. Slide each side away from its own team box (left banner translates
   negative, right banner positive).

```html
<style>
  .timeout-banner, .penalty-banner {
    color:#fff; font-weight:bold; padding:8px 20px; font-size:22px;
    width:220px; box-sizing:border-box; transform:translateX(0);
    transition:transform .5s ease-out;
  }
  .timeout-banner { background:#1e3a8a } .penalty-banner { background:#c0392b }
  [data-side="left"][data-live-hidden]  { transform:translateX(-120px); pointer-events:none }
  [data-side="right"][data-live-hidden] { transform:translateX(120px);  pointer-events:none }
</style>
<div class="timeout-banner" data-role="timeoutBanner" data-side="left" data-live-hidden></div>
<div class="penalty-banner" data-role="penaltyBanner" data-side="left" data-live-hidden></div>
```

---

## 4. Server surface relevant to overlay work

REST (all JSON):

| Route | Purpose |
|---|---|
| `GET /api/overlays`, `GET /api/overlays/:id` | List / read overlays |
| `POST /api/overlays` | Create |
| `POST /api/overlays/:id/versions` | Save (snapshots all blocks as a new version) |
| `PUT /api/overlays/:id/active-version` | Point the overlay at a version |
| `POST /api/overlays/:id/duplicate` | Save as copy (how to edit the locked default) |
| `PUT /api/overlays/:id/rating` | 0-3 stars |
| `POST/PUT/DELETE /api/overlays/:id/blocks[/:blockId]`, `PUT .../transform` | Block CRUD and transform (`?version=` selects the version, default active) |
| `POST/PUT/DELETE /api/overlays/:id/logos[/:logoId]`, `POST /api/logos` | Logos (PNG, 10 MB) |
| `POST /api/display/reload` | Reload the kiosk page |
| `GET /api/sync/shufflepolo/config|status|participants|bracket` | Sync state files |
| `POST /api/sync/shufflepolo/push` | Used by the sync child only |
| `POST /api/sync/shufflepolo/resync` | Force a full read and push |
| `POST /api/sync/shufflepolo/toggle {enabled}` | Start/stop the child |
| `GET /api/ladder?t=<uuid|url>` | Rendered bracket ladder for any tournament |

Socket.io events a page may care about: `gameUpdate` (server to client, the
whole gameState), `setActive {kind:'overlay', id}` (client to server, makes
/display render that overlay), `setLadder {active, tournament}`,
`reloadDisplay`, `updateScore`, `updateTeamName`, `swapSides`.

Test driver: `node simulate-game-states.js [--once]` cycles live, timeout and
penalty states through the server (stops the real sync first, restores it on
exit). Logs: `journalctl -u scorebored.service`, sync lines tagged `[shufflepolo]`.

---

## 5. Open items that touch overlay logic

1. **Overtime clock** (highest value): `secondsFromShufflepoloClock` ignores
   `clock.overtime`. Fix: when true return `secs = floor(played -
   duration_seconds)`, `overtime: true`; `computeClockDisplay` already prefixes
   `+`. `live_until` is null in running overtime; the sync tolerates that.
2. **Goal banner** (planned 2026-10-09, not built): add `gameState.goalLog =
   {gameId, items: [{id, side, player}]}` in `applyShufflepoloSnapshot` the
   same way as `penaltyLog` (goals carry `team_id` and `player` like
   penalties, so `sideFor` applies); add a `goalBanner` data-role with the
   same id-based detection and seeding rules as the penalty banner, phased
   text `"GOAL"` then scorer; add a block element per side in the locked
   default. Remember `game_seconds`, not `at`, if a time is ever captioned.
3. **Negative `elapsed_seconds`**: the countdown path is clamped at 0; check
   any count-up or `played` floor path you add.
4. **Suspended games** render as "no live game" (names kept, clock and
   banners cleared). Deliberate; revisit only if the operator asks.
5. The `penalties` combined-string role shows `0:00` for Shufflepolo
   penalties because there is no `remaining_seconds`; prefer `penaltyCount`
   or the banner for Shufflepolo-driven overlays.
6. `debugLogClock` in scorebug-render.js is temporary instrumentation
   (`window.CLOCK_DEBUG = true` in a page console enables it).

---

## 6. Platform facts and constants

- Timeout length 120 s and 2 timeouts per team are Shufflepolo platform
  constants from their console code, not house rules.
- The feed's ETag/304 path is verified against production. Idle traffic is
  one 304 every 5 minutes.
- The Pi has no RTC; all clock math uses `clock_offset_ms` measured in the
  sync child, never re-derived downstream.
- Current live config (2026-10-16): tournament
  `b3ac9fb1-408d-42eb-a7d7-f93d815ca9c6` (NAH Testing, group stage only),
  court 1, enabled, running under `scorebored.service`.
- Browser access to the Pi is `192.168.55.16:3000` (wired address). Static
  files under `public/` go live without a restart; `server.js` changes need
  `sudo systemctl restart scorebored.service`. Never start a second
  `node server.js` on the Pi.
