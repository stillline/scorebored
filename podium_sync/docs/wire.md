# Podium live stream API — wire reference

One WebSocket per consumer. Subscribe to a tournament and a court; get the complete current state back; then get the complete new state every time something changes, with the thing that changed named and attached. Nothing arriving on this socket can modify a tournament.

```
wss://podiumbikepolo.com/api/livestream?key=pk_live_…
wss://eu.podiumbikepolo.com/api/livestream?key=pk_live_…
```

Connect to the region that hosts the tournament — the same host the tournament's page is on.

**There is no version in the path, and there won't be one.** There is one consumer, so the compatibility policy is a conversation rather than a negotiation protocol: fields get added, and if something has to change in a way that breaks a client, it gets changed and the client gets fixed. Don't build version detection against this API — build against the current shape and expect a heads-up.

## Connecting

- The key goes in the query string. A bad, missing or deactivated key is refused **before** the upgrade with HTTP `403`. Keys are issued by hand by a Podium admin, identify a consumer (not a tournament), and work at any tournament in the region.
- No `Origin` check: scripts, Raspberry Pis and browser sources on any host connect the same way.
- Keepalive: the server closes a socket that has sent nothing for **90 seconds**. Send a `ping` op (or a WebSocket ping frame) at least every 60 seconds. Idle is measured on what *you* send; incoming pushes don't count.
- Frames from the client are capped at **64 KB**. Server frames have no cap (a tournament payload can be a few hundred KB).
- No rate limit. One key, one long-lived connection.

## Envelope

Every frame is one JSON object.

**Client → server** frames carry an `id` (any string; you choose it) and an `op`:

```json
{"id":"1","op":"subscribe","tournament":"esq-2026","court":"2"}
```

**Replies** echo the `id`:

```json
{"id":"1","ok":true,"data":{…},"server_now":"2026-08-29T21:31:02.118Z"}
{"id":"1","ok":false,"error":{"code":"not_found","message":"no court \"9\" at esq-2026"},"server_now":"…"}
```

**Pushes** have no `id`. They name what happened (`trigger`), attach the object it happened to (`event`), and carry the complete new state (`data`):

```json
{"push":"game","trigger":"goal","event":{…},"data":{…},
 "server_now":"2026-08-29T21:33:47.902Z","tournament":"esq-2026","court":"2"}
```

Every frame carries `server_now`: the server's UTC clock at serialization, ISO 8601 with milliseconds. Every timestamp anywhere in a payload has that same shape and precision, always UTC (`…Z`).

### Error codes

| code | when |
|---|---|
| `bad_request` | Frame isn't JSON, has no `op`, names an unknown op, or is missing a required field (`tournament`, `court`). |
| `not_found` | No tournament with that slug (drafts and archived tournaments are indistinguishable from nonexistent ones; sandboxes **are** reachable — see [Visibility](#visibility)), or no court with that name at it. |

An error never closes the socket. A connection-level failure is the `403` at connect.

## Ops

### `subscribe`

```json
→ {"id":"1","op":"subscribe","tournament":"esq-2026","court":"2"}
← {"id":"1","ok":true,"data":{"tournament":{…},"game":{…}|null},"server_now":"…"}
```

`tournament` is the slug from the tournament's URL. `court` is the court's name as shown on the schedule (case-insensitive).

The reply's `data` is the **full current state**: the complete `tournament` payload and the `game` in progress on that court, or `null` if nothing is in progress (the court's finished games are in `tournament.completed_games`). From then on the socket streams pushes for changes to that state. There is no separate snapshot op; subscribing is how you get a snapshot, and a reconnect is the same single call.

A connection holds one subscription. Subscribing again replaces it (you stop receiving the old tournament's pushes). `unsubscribe` drops it.

### `unsubscribe`

```json
→ {"id":"2","op":"unsubscribe"}
← {"id":"2","ok":true,"data":null,"server_now":"…"}
```

### `bracket`

```json
→ {"id":"7","op":"bracket","tournament":"esq-2026"}
← {"id":"7","ok":true,"data":{
     "b3f1…":{"name":"Championship","format":"double","state":"live","brackets":[
        {"id":"…","role":"winners","state":"complete","current":false,"html":"<div class=\"pdm-bracket\" …"},
        {"id":"…","role":"losers","state":"live","current":true,"html":"…"},
        {"id":"…","role":"finals","state":"pending","current":false,"html":"…"}
     ]}
   },"server_now":"…"}
```

Every bracket set at the tournament, keyed by set id, each of its brackets rendered as semantic, unstyled HTML. Request/response only — never streamed. The `tournament` push with trigger `structure_changed` is the cue to re-request. See [Bracket HTML](#bracket-html) below and `bracket.css` for a starter stylesheet.

### `ping`

```json
→ {"id":"p","op":"ping"}
← {"id":"p","ok":true,"data":{"pong":true},"server_now":"…"}
```

Keeps the socket alive; the reply's `server_now` is also a cheap way to re-measure clock offset.

## Pushes

Two push types, split by how often they change.

**`game`** — the game on the subscribed court. Seconds-to-minutes cadence. The scorebug and nothing else. After `game_finished`, `data` is the finished game with its final score; the next `game_started` replaces it.

**`tournament`** — identity, standings, structure, and the subscribed court's queue. Fires at game boundaries and structural changes. When several changes land in one moment (a game ends: standings recompute, the next game promotes onto the court, the bracket advances) the server reads the tournament once and sends one push per distinct trigger, in the order `tournament_changed`, `structure_changed`, `standings_changed`, `queue_changed`.

Both are full state. At a game boundary both fire and **order does not matter** — each replaces its object wholesale, so either arrival order renders the same thing. Every push is idempotent: applying it twice is harmless.

### Triggers

`event` always carries the object the trigger is about, and its type is fixed per trigger. The four tournament-level triggers and `subscribed` carry `null` — there is no discrete object to point at.

| push | trigger | `event` | fires when |
|---|---|---|---|
| — | `subscribed` | `null` | *Client-side only.* The Python client fires it once after the subscribe reply so initial state and later pushes go through the same handlers. Nothing on the wire. |
| `game` | `game_started` | Game | A game on the court goes in progress (first goal, clock start, or Start). Carries the running clock if it was started by the clock. |
| `game` | `goal` | Goal | A goal was recorded. |
| `game` | `goal_removed` | Goal | A goal was deleted (a correction). `event` is the goal as it was. |
| `game` | `clock_started` | Clock | The clock went from stopped to running. |
| `game` | `clock_stopped` | Clock | The clock went from running to stopped (a whistle in the last two minutes, a timeout, a pause). |
| `game` | `clock_adjusted` | Clock | Remaining time was edited without changing running state. |
| `game` | `period_changed` | Clock | Regulation → overtime (golden goal). |
| `game` | `penalty` | Penalty | A penalty was issued. |
| `game` | `penalty_ended` | Penalty | A timed penalty's window closed — early (`ended_reason: "goal"`) or on the clock (`"expired"`). The server derives expiry from the game clock and never announces it while the clock is stopped. |
| `game` | `timeout` | Timeout | A team took a timeout. Followed by `clock_stopped`. |
| `game` | `game_finished` | Game | The game was completed. `data` and `event` both carry `ended_at` and the final score. |
| `game` | `game_changed` | Game | Anything else about the game: court reassignment, ref change, score correction, goal attribution, a removed penalty, a roster or team-name edit. |
| `tournament` | `standings_changed` | `null` | A game was scored or finished anywhere at the tournament. |
| `tournament` | `queue_changed` | `null` | What's on court / on deck / in the hole may have moved: a game started, finished, was created, deleted or reassigned. |
| `tournament` | `structure_changed` | `null` | A stage, bracket, court or team was created, edited, seeded, advanced or deleted. Re-request `bracket` on this. |
| `tournament` | `tournament_changed` | `null` | Tournament identity or rules changed, or the tournament was completed. |

A single scorekeeper action can produce more than one game push: a goal inside the last two minutes is `goal` then `clock_stopped`; a timeout is `timeout` then `clock_stopped`. Each carries the state as of that moment.

## `game` payload

```json
{
  "id":"0f3a…","court":"2","status":"in_progress",
  "round":"Round 4","stage":{"kind":"group","id":"…","name":"Group A"},"series_game":null,
  "started_at":"2026-08-29T21:31:02.000Z","ended_at":null,
  "home":{"team_id":"…","name":"Beavers","score":4,"seed":2,
          "record":{"wins":4,"losses":1,"ties":0,"byes":0,"points":8,"goals_for":21,"goals_against":9,"games_played":5}},
  "away":{"team_id":"…","name":"Chum Bucket","score":2,"seed":5,"record":{…}},
  "clock":{"remaining_ms":231000,"elapsed_ms":489000,"running":false,"running_since":null,
           "phase":"regulation","game_seconds":720,"regulation_expired":false},
  "goals":[{"id":"…","at":"2026-08-29T21:33:47.000Z","elapsed_ms":165000,"side":"home",
            "player":{"id":"…","name":"Priya S.","club":"SEA"}}],
  "penalties":[{"id":"…","at":"2026-08-29T21:38:10.000Z","side":"away","severity":"minor",
                "player":{"id":"…","name":"Pablo R.","club":null},
                "issued_elapsed_ms":428000,"duration_ms":45000,"ended_elapsed_ms":null,"ended_reason":null}],
  "timeouts":[{"id":"…","at":"2026-08-29T21:40:55.000Z","side":"home","duration_ms":120000,
               "ends_at":"2026-08-29T21:42:55.000Z","ended_reason":null}]
}
```

| field | |
|---|---|
| `id` | Game id. Stable across pushes. |
| `court` | Court name, or `null`. |
| `status` | `scheduled` · `in_progress` · `completed` |
| `round` | Human label: `"Round 4"` in group/Swiss play; the bracket position otherwise (`"Winners Bracket Semifinal"`, `"Tournament Final"`, `"Losers Bracket Round 2"`). Series games append `" · Game 2"`. |
| `stage` | `{kind, id, name}` — `kind` is `group`, `swiss` or `bracket`; for a bracket, `id`/`name` are the bracket *set*'s. |
| `series_game` | 1-based index within a best-of-N matchup, else `null`. |
| `started_at`, `ended_at` | UTC instants. `ended_at` is written once when the game completes and never moves afterward, so it's safe to chapter a recording on. `null` until then. |
| `home`, `away` | `team_id`, `name`, `score` (`null` before the game starts), `seed`, `record`. |
| `home.seed` | The seed as the game's own stage numbers it: bracket seed in a bracket, prerank in a Swiss session, tournament seed in a group. |
| `home.record` | The team's record across **every completed game in the tournament so far**, computed the way Podium's standings do (an Instant Mix game counts as a bye). Denormalized here so a scorebug never joins against the standings. |
| `clock` | See [Three clocks](#three-clocks). `null` when the game has no armed clock (time tracking off, or not started by the clock). |
| `rules` | The rules **this game** is being played under — see [Rules](#rules). A game snapshots them when its clock is armed, so changing a tournament setting mid-day never moves a game already in play. Before that it mirrors the tournament's current rules. |
| `goals` | Cumulative, oldest first. `at` is the wall-clock instant; `elapsed_ms` the game-clock position (total game time played, overtime included) or `null` if recorded without a clock; `side` is `home`/`away`; `player` is `null` for an unattributed goal. |
| `penalties` | Cumulative, oldest first. `severity` is `turnover` · `minor` · `major` · `ejection`. `player` is `null` for a team-level penalty. Timed severities carry `issued_elapsed_ms` + `duration_ms`; a `turnover` has `duration_ms: null`. `ended_elapsed_ms`/`ended_reason` are set once the window is over: `goal` (a Minor cleared by a goal against the short-handed team) or `expired` (the clock reached the end of the window — derived at serialization time, not stored). |
| `timeouts` | Cumulative, oldest first. Runs on the wall clock from `at` to `ends_at`. `ended_reason` is `null` while it's counting, `resumed` once play restarted before `ends_at` (the scorekeeper started the clock early), or `expired` once `ends_at` has passed. Derived at serialization time, like a penalty's expiry. |

Player `name` is the name as entered in Podium; `club` is the club code or `null`.

## `tournament` payload

```json
{
  "id":"…","slug":"esq-2026","name":"Emerald City Open 2026","status":"active",
  "timezone":"America/Los_Angeles","starts_on":"2026-08-29","ends_on":"2026-08-30","game_seconds":720,
  "court":{"id":"…","name":"2","game_id":"0f3a…",
           "on_deck":{"game_id":"…","game_number":null,"status":"scheduled","round":"Round 4",
                      "stage":{"kind":"group","id":"…","name":"Group A"},
                      "home":{"team_id":"…","name":"Sasquatch"},"away":{"team_id":"…","name":"Hot Karls"}},
           "in_the_hole":{"game_id":null,"game_number":9,"status":"scheduled","round":"Losers Bracket Round 1",
                          "stage":{"kind":"bracket","id":"…","name":"Championship"},
                          "home":{"team_id":"…","name":"Beavers"},"away":{"team_id":null,"name":"Loser of Game 2"}}},
  "courts":[{"id":"…","name":"1","active":true},{"id":"…","name":"2","active":true}],
  "teams":[{"id":"…","name":"Beavers","seed":1},…],
  "completed_games":[{"id":"…","started_at":"…","ended_at":"…","round":"Round 3","stage":{…},
                      "home":{"team_id":"…","name":"Beavers","score":5},"away":{"team_id":"…","name":"Hot Karls","score":2}}],
  "stages":[…],
  "brackets":[…]
}
```

| field | |
|---|---|
| `slug`, `name`, `status` | `status` is `published` · `active` · `completed`. |
| `timezone` | IANA zone of the tournament, for rendering local time. Never guess; use it. |
| `game_seconds` | Regulation length the tournament's rules set. A game in play carries its own snapshot in `game.clock.game_seconds`. |
| `rules` | The tournament's **current** rules — see [Rules](#rules). For anything about a game in play, prefer that game's own `rules`. |
| `court` | The subscribed court: `game_id` of the game on it (or `null`), and what's **on deck** and **in the hole** for it. Each queue item names its two sides — a team (`team_id` + `name`) or, when not yet decided, `team_id: null` and a resolved label as the name (`"Winner of Game 3"`, `"TBD"`). Bracket matchups carry a `game_number`; group/Swiss games don't. |
| `courts`, `teams` | Every court and (non-filler) team, by seed. |
| `completed_games` | The day's finished games **on the subscribed court**, oldest first, with both timestamps. Rides the subscribe reply so a client that reboots at 2pm gets the morning's chapter markers back. |
| `stages` | Group and Swiss stages, in running order. See below. |
| `brackets` | Bracket sets, in running order. See below. |

### Rules

The same block rides on the tournament (its current settings) and on each game (the snapshot that game is being played under).

```json
"rules": {"game_seconds":720,"time_tracking":true,
          "stop_clock_final_two":true,"stoppage_window_ms":120000,
          "timeouts_per_team":2,"timeout_seconds":120,
          "penalties_enabled":true,"minor_seconds":45,"major_seconds":120,
          "win_points":2,"swiss_tiebreaker":"goals"}
```

| field | |
|---|---|
| `game_seconds` | Regulation length. |
| `time_tracking` | False when the tournament runs without a clock at all — every game's `clock` is then `null`. |
| `stop_clock_final_two`, `stoppage_window_ms` | Whether a whistle stops the clock, and how much regulation has to be left for it to. See [Three clocks](#three-clocks). |
| `timeouts_per_team` | Each team's allowance **per game**. Subtract the timeouts already in `game.timeouts` for that side to show how many are left — the payload deliberately doesn't do that arithmetic for you. |
| `timeout_seconds` | Length of a timeout. Each timeout also carries its own `duration_ms`. |
| `penalties_enabled` | False when the tournament doesn't call penalties; don't draw a penalty box. |
| `minor_seconds`, `major_seconds` | Standard advantage lengths. Each penalty carries its own `duration_ms`, which is what a countdown should use — a Personal Misconduct's window doesn't come from either of these. |
| `win_points` | Points a win is worth, which is what a standings `points` column is counting. |
| `swiss_tiebreaker` | `goals` or `strength` (Buchholz) — how a Swiss stage broke ties. |

### Stages

```json
{"kind":"group","id":"…","name":"Group A","state":"live","total_rounds":5,"current_round":4,
 "teams":[{"team_id":"…","name":"Beavers","seed":1,"position":1,
           "wins":4,"losses":1,"ties":0,"byes":0,"points":8,
           "goals_for":21,"goals_against":9,"goal_differential":12,"games_played":5}, …]}
```

Raw rows, already ranked and sorted — no rendered table. `kind` is `group` (round robin) or `swiss`. `state` is `pending` (no games yet), `live`, or `complete` (every planned round played). `position` is the team's rank **as it stands**: provisional while `state` is `live`, and shared by tied teams (the next position skips). `seed` is the tournament seed for a group, the prerank for a Swiss session.

### Brackets

```json
{"id":"…","name":"Championship","format":"double","team_count":8,"state":"live",
 "brackets":[
   {"id":"…","role":"winners","state":"complete","current":false,
    "rounds":[{"round":1,"name":"Winners Bracket Quarterfinal","matches":[{…},{…},{…},{…}]},
              {"round":2,"name":"Winners Bracket Semifinal","matches":[{…},{…},null,null]},
              {"round":3,"name":"Winners Bracket Final","matches":[{…},null,null,null]}]},
   {"id":"…","role":"losers","state":"live","current":true,"rounds":[…]},
   {"id":"…","role":"finals","state":"pending","current":false,"rounds":[…]}
 ]}
```

A **bracket set** is the organizer-facing thing ("Championship"), with `format` `single`, `double` or `series` (best-of-N). It contains one or more **brackets** by `role`: a single-elim or series set has one (`main`); a double-elim set has three (`winners`, `losers`, `finals`). Each role is addressed and rendered separately — a whole double-elim is far too big to put on screen at once.

**Exactly one bracket across the whole tournament is `current: true`**: the one holding a game in progress (the subscribed court's first), else the next one with play left, else the last one finished. "Show the bracket they're playing" is a filter on that flag.

`state` on a set and on a bracket is `pending` (not seeded yet), `live`, or `complete`.

A bracket is **columns of rounds**; each round is a fixed list of match slots, **padded with `null`** to the widest round of that bracket, so `rounds[r].matches[s]` is a regular grid. It is deliberately not a tree — a losers bracket isn't one.

A match slot:

```json
{"id":"…","game_number":9,"round":1,"slot":0,"label":"Losers Bracket Round 1","status":"scheduled",
 "home":{"team":null,"seed":null,"score":null,"label":"Loser of Game 1"},
 "away":{"team":{"team_id":"…","name":"Sasquatch"},"seed":3,"score":null,"label":null},
 "winner":null,
 "winner_to":{"match_id":"…","game_number":13,"slot":"home"},"loser_to":null,
 "home_from":{"match_id":"…","game_number":1,"result":"loser"},"away_from":null,
 "court":"2","game_id":null,"series":[]}
```

| field | |
|---|---|
| `game_number` | The human "Game N" the bracket numbers its matchups by. |
| `round`, `slot` | Column and row (0-based) in the grid. |
| `label` | The round's name. |
| `status` | `scheduled` · `in_progress` · `completed` |
| `home`, `away` | `team` (`{team_id, name}` or `null`), `seed`, `score`, and — only when `team` is `null` — a **server-resolved `label`**: `"Winner of Game 3"`, `"Loser of Game 7"`, `"Bye"`, or `"TBD"`. Draw `team.name` or `label`; never walk a link. |
| `winner` | `home`, `away`, or `null`. |
| `winner_to`, `loser_to` | Where each side goes next (`slot` is the side they land on), or `null` at the end of the line. |
| `home_from`, `away_from` | Where each side comes from (`result` is `winner`/`loser`), or `null` for a seeded slot. Raw pointers for connector lines; nothing needs them. |
| `series` | For a best-of-N matchup, one entry per game: `{game_id, game, home_score, away_score, status}`. `home.score`/`away.score` are then games won, not goals. Empty otherwise. |

### Bracket HTML

The `bracket` op returns each bracket as HTML built from exactly the shape above: a `.pdm-bracket` holding one `.pdm-round` per column, each with a `.pdm-round-name` and a `.pdm-matches` list of `.pdm-match` boxes (padding slots are `.pdm-match.pdm-match-empty`). A box has a `.pdm-match-title` ("Game 9") and two `.pdm-side` rows (`.pdm-home`, `.pdm-away`), each with `.pdm-seed`, `.pdm-name` (team name or resolved label) and `.pdm-score`.

Data attributes carry state for styling: on the bracket `data-role`, `data-state`, `data-current`, `data-format`, `data-rounds`; on a round `data-round`; on a match `data-game-number`, `data-round`, `data-slot`, `data-status`, `data-winner`, `data-court`; on a side `data-side`, `data-winner`, `data-tbd`, `data-team-id`. There is no inline style. `bracket.css` is a starting point that draws connectors with pseudo-elements; override or replace it.

## Three clocks

Never render a clock reading we sent — by the time it's on screen it's stale. Each frame carries anchors; you derive the current value on your own repaint schedule. Three countdowns run on **three different axes**:

| | counts | axis | ends early? |
|---|---|---|---|
| Game clock | down in regulation; **up, unbounded** in overtime | wall time, only while `running` | — |
| Penalty | down | game-clock **elapsed** — freezes during any stoppage | yes (`ended_reason: "goal"`) |
| Timeout | down | wall clock, independent of the game clock | yes (`ended_reason: "resumed"`) |

**When a whistle stops the clock.** A goal or a penalty stops it only inside the last `stoppage_window_ms` of regulation, and only when `stop_clock_final_two` is on; in overtime any whistle stops it. A **timeout always** stops it, whatever the time — the team paid for the stoppage. So a penalty at 8:00 with the clock still running is correct, not a dropped `clock_stopped`: check the game's `rules` before treating it as a bug.

Let `drift` = milliseconds since you received the frame, measured with a **monotonic** clock (`time.monotonic()`, not wall time — a Pi without an RTC jumps when NTP syncs).

**Game clock** (`game.clock`):

```
moved      = running ? drift : 0
regulation: remaining_now = max(remaining_ms - moved, 0)
            elapsed_now   = min(elapsed_ms + moved, game_seconds * 1000)
overtime:   remaining_now = remaining_ms + moved        // counts UP: this is overtime elapsed
            elapsed_now   = elapsed_ms + moved
```

`phase: "overtime"` means golden goal: `remaining_ms` is time *played* in overtime, counting up, first goal wins. Don't render it as a countdown. `regulation_expired` is true at 0:00 in regulation while the game isn't over (the scorekeeper hasn't finished it, or it's about to go to overtime).

A finished game's clock is frozen where it stood at `ended_at` (`running: false`).

**Penalty** (`game.penalties[]`, timed severities only):

```
remaining_now = max(issued_elapsed_ms + duration_ms - elapsed_now, 0)      // elapsed_now from the game clock
active        = remaining_now > 0 && ended_elapsed_ms == null
```

Because it's on the elapsed axis, a penalty stops counting the instant the game clock stops and resumes with it — a client that puts penalties on wall time will show them ticking during a timeout. `penalty_ended` arrives when the server's view of the clock crosses the end; you'll usually have already computed it.

**Timeout** (`game.timeouts[]`):

```
remaining_now = ended_reason == null ? max((ends_at - server_now) - drift, 0) : 0
active        = remaining_now > 0
```

The game clock is stopped during a timeout; the timeout keeps counting. It ends the moment play resumes: the `clock_started` push that restarts the game carries the timeout with `ended_reason: "resumed"`, so drop it from the screen on that frame rather than counting on to `ends_at`.

**Rounding — get this right or your overlay reads a second off the scorekeeper's phone.** A countdown **ceils**: `0:01` stays on screen until the clock truly reaches zero, and `0:00` appears only at zero. Something counting up — overtime — **floors**. So:

```
regulation / penalty / timeout:   seconds_shown = ceil(remaining_now / 1000)
overtime:                         seconds_shown = floor(remaining_now / 1000)
```

Podium's own scoreboard does exactly this (`formatClockDown` / `formatClockUp`); flooring a countdown makes every reading one second low except on the exact boundary.

Whole-second displays flip at `remaining_now % 1000` — schedule your next repaint there, not on a fixed interval, or seconds will stutter.

## Reconnecting

Reconnect with backoff and send the same `subscribe`. The reply replaces everything you had; you lost nothing that matters, because the reply is the current state and every push is full state. Pushes that arrived during the gap are already reflected in it. `completed_games` on the subscribed court is in the reply, so chapter markers survive a reboot.

There is no message replay and no sequence numbers by design.

## Visibility

A draft or an archived tournament answers `not_found`, indistinguishable from a slug that doesn't exist. A completed tournament stays readable — the bracket is still worth having for post-production.

**Sandbox tournaments work**, and they're the right place to build an overlay against. A sandbox is a private playground an organizer creates to experiment in: it never appears in any public list, and its slug is a random token rather than a name, so it's reachable only by someone who has been given the slug. Point your client at one while you're developing — the alternative, publishing a throwaway tournament, puts a fake event in front of everyone looking at the real ones.
