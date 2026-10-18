# Score Data Syncing

Scorebored can pull live score/bracket data from a tournament platform
instead of (or alongside) manual entry on `/control` and `/bracket`. Three
providers are supported — **Challonge**, **Podium**, and **Shufflepolo** —
and exactly one is normally enabled at a time.

## How it works

Each provider is a standalone subprocess (spawned and managed by
`lib/sync.js`'s `SyncManager`) that talks to its platform and writes JSON
state files to its own `state/` directory. While a provider is enabled, it
also overwrites the app's top-level `bracket.json` — the same file
`/bracket` and the control panel's Next/Prev Game buttons read — so
Next/Prev Game navigation works identically whether the schedule came from
a platform or was typed in by hand. **Local edits to `bracket.json` get
overwritten on the next poll/push while a provider is enabled.**

All sync providers are read-only against their platform; none of them
write or PATCH anything back.

| Provider | Subprocess | Delivery | Config file |
|----------|-----------|----------|--------------|
| Challonge | `challonge/challonge_sync.py` (Python) | Polled | `challonge-config.json` |
| Podium | `podium_sync/podium_sync.py` (Python, uses the vendored `libpodium` client) | Pushed (live) | `podium-config.json` |
| Shufflepolo | `shufflepolo_sync/shufflepolo_sync.js` (Node) | Realtime signal + conditional re-read (pushed) | `shufflepolo-config.json` |

Config files are gitignored and auto-created — set them up via the
`/bracket` page's sync panel (API keys show masked as `••••••••` once saved;
re-entering is only needed to change them), not by hand.

## Enabling a provider

On `/bracket`, each provider has a config panel: fill in its required
fields and flip it on. Turning one on starts its subprocess; turning it off
stops it. The REST/socket shape is generic across all three
(`/api/sync/:provider/config|status|participants|bracket`), so the UI code
doesn't need to special-case any provider except where noted below.

### Challonge

- Required: `apiKey` (Challonge v1 API key, from
  `challonge.com/settings/developer` — **not** an OAuth client
  secret), `tourney` (tournament slug).
- Polls `state=open` matches on an interval, resolves participant IDs to
  team names, and writes the next matchups into `bracket.json`, grouped by
  round.
- Challonge-specific extra: a tournament-listing lookup so the UI can offer
  a picker of tournaments visible to the API key, instead of requiring a
  hand-typed slug.
- Free-tier Challonge API caps at 500 requests/month — the poll interval is
  tuned to stay well under that for a tournament weekend.
- `challonge/list_participants.py` is a standalone one-shot script (same
  `CHALLONGE_API_KEY`/`CHALLONGE_TOURNEY` env vars) for sanity-checking the
  roster from the command line, independent of the running server.

### Podium

- Required: `apiKey`, `tournament`, `court`.
- Podium pushes live state (score, clock, penalties, timeouts) to this app
  via `POST /api/sync/podium/push` rather than being polled — so when the
  subprocess exits, `lib/sync.js`'s `onExit` hook explicitly clears
  `gameState.clock`/`penalties`/`timeouts`/`status` rather than leaving a
  stale clock on screen.
- Built on the vendored `libpodium` client in `podium_sync/` — see
  `podium_sync/LIBPODIUM_README.md` and `podium_sync/docs/` for the wire
  protocol and integration details of that library itself.

### Shufflepolo

- Required: `tournamentId` — a bare UUID, or a pasted tournament page URL
  (`https://shufflepolo.com/t/<uuid>`); the server automatically extracts
  the UUID either way (`normalizeField` in the provider definition), since
  Shufflepolo's feed has no list/lookup endpoint and the UUID is only ever
  visible by pasting the page URL.
- Optional: `court` — the court number as shown on shufflepolo.com (default
  1). The sync shows that court's `current_game` as the feed picks it (its
  live game, else the next one after the last finished), so a game on another
  court never reaches the scoreboard.
- No API key — the feed is public/anonymous.
- Follows Shufflepolo's feed contract (`docs/scoreboard-feed.md` in their
  repo; our client is derived from their reference client): one websocket
  joined to every topic the snapshot names (`games:<id>` for scores/clocks,
  `feed:<id>` for goals/penalties/timeouts — a penalty is only ever on the
  second), a re-read on any message throttled to one per 2 s, a re-read at
  each live clock's `live_until`, and a safety poll once per 5 minutes. Every
  read sends `If-None-Match`; a 304 means nothing changed and nothing is
  written or pushed. Pushes therefore arrive only when the tournament
  changed, not on a timer.
- `POST /api/sync/shufflepolo/resync` asks the running sync for a full
  re-read and push even if nothing changed (recovers a display that dropped
  an update). `lib/sync.js` also restarts the child if it exits on its own
  (with backoff) or if its `status.json` goes stale (`staleAfterMs`).
- Timeouts: Shufflepolo's console stops the clock when a timeout is called
  and ends it when the clock starts again; the feed carries no end time, so
  server.js treats "the clock has run since the newest timeout" as the end,
  with the platform's fixed 120 s as a ceiling.
- **Clock sync:** Shufflepolo's clock shape (`{status, elapsed_seconds,
  running_since, duration_seconds, overtime, live_until}`) is different from
  Podium's (`{running, phase, remaining_seconds}`); `public/scorebug-render.js`
  detects and renders both. The subprocess measures its own clock-sync
  offset against Shufflepolo's server at the actual HTTP round trip (keeping
  the fastest sample, ageing it, and re-measuring at once if this machine's
  wall clock is stepped — the Pi has no battery-backed clock) and carries it
  through as `clock_offset_ms` rather than letting any downstream consumer
  recompute it against an already-stale timestamp — see
  `docs/shufflepolo-clock-sync-fix.md` for the history.


### Bracket ladder from the tournament page (`shufflepolo_sync/page_bracket.js`, `/ladder`)

The feed lists only games that exist with both teams, so unplayed bracket
games (empty slots) never reach `bracket.json` and a ladder could not be shown
ahead of play. The public tournament page draws the whole ladder, so the sync
renders it with the Pi's Chromium (`chromium --headless=new --dump-dom`, own
profile dir under /tmp, about 3 s) every 2 minutes
(`SHUFFLEPOLO_PAGE_INTERVAL_MS`) and parses the game cards out of the DOM.
Added 2026-10-14.

- Anchors are the page's own `data-testid` hooks (`bracket-game-row-<id>`,
  `bracket-game-number-`, `bracket-game-time-`, `bracket-game-slot-team1/2-`)
  and each card's inline `grid-area` (row / column / row-end), which is the
  page's own layout. Round = column (1, 3, 5, ... are rounds), round labels
  and section names ("Grand Final", "Winners Bracket", "Losers Bracket") are
  read from the text just before the cards. Tailwind class names are not used.
- A render that yields no cards keeps the previous result and logs; a render
  failure (Chromium error, timeout) does the same. The last good parse is
  written as `page_games[]` (plus `page_read_at`) in
  `shufflepolo_sync/state/bracket.json`, served by
  `GET /api/sync/shufflepolo/bracket`.
- `bracket.json` (the Next/Prev Game schedule) now takes its bracket-phase
  matchups from the page, in game-number order with TBD slots and the page's
  local start time, under the bracket's name; group-stage matchups still come
  from the feed. Without a page result it falls back to the feed's bracket
  games as before.
- `/ladder` (`public/bracket-ladder.html`) draws `page_games` like the
  Shufflepolo page, in the on-air scorebug's palette (NAHBPC_2026_2 tokens:
  navy, periwinkle, ice, ink, Chakra Petch): sections, round labels, cards
  placed on the same grid, connectors drawn where a card's row span covers a
  card in the previous round. Winner bold with a navy-deep score chip, loser
  dimmed, TBD in periwinkle. Auto-fits to the window width; `?scale=` forces a
  scale, `?src=` loads another JSON (used for previews). Reloads every 30 s.
- By default `/ladder` shows the tournament the sync follows
  (`shufflepolo-config.json`). Paste any shufflepolo.com tournament link into
  the box at the top (or open `/ladder?t=<link or uuid>`) and the server
  renders that tournament instead via `GET /api/ladder?t=`, cached per
  tournament for 2 minutes with concurrent requests sharing one render; only
  `shufflepolo.com/t/<uuid>` is ever rendered. `?bare=1` hides the box for an
  on-air window.
- **Show on stream** (button on `/ladder`): the display page adds a full-frame
  `#ladderFrame` layer pointed at `/ladder?bare=1&t=<uuid>` when
  `gameState.ladder.active` is set (socket event `setLadder {active,
  tournament}`), above the scorebug overlay and below a commercial break. The
  ladder's background is pure black so the ATEM's luma key drops it and the
  bracket cards sit over the program; every other colour on the page is at or
  above the scorebug's ~25 % luma floor. The button reflects the live state
  (red "Hide from stream" when this tournament is on air) in every open copy
  of the page.
- The page also reads the tournament's Teams section (`team-card-<id>`,
  `team-seed-badge`, `team-roster`) into `teams[]`. `/ladder` has a Bracket /
  Teams toggle; in bare (on-air) mode it alternates the two every 30 s
  (`?cycle=<s>`, `cycle=0` pins the bracket, `?view=teams` starts on teams).
- A **Next up** card sits top right in both views: the live game with score
  if one is on (red header), otherwise the first `up_next` game with court and
  start time in the tournament's time zone. `/api/ladder` merges `live[]`,
  `suspended[]`, `up_next[]` and `time_zone` from the scoreboard feed for the
  same tournament (15 s cache), so the card is live for any pasted link, not
  just the sync's tournament. Hidden when there is nothing live or scheduled.

## Viewing synced data

- **`/teams`** — read-only roster viewer. Tries each provider in turn and
  renders whichever is currently enabled (Challonge > Podium > Shufflepolo
  if more than one were somehow on at once).
- **`/bracket-viewer/:provider`** — a per-provider bracket/standings viewer
  (`public/sync-data-viewer.html`). Kept per-provider rather than unified
  because the three providers' `bracket.json` shapes don't match closely
  enough to render generically.

## Adding a fourth provider

Define a new `SyncManager` in `server.js` alongside the existing three
(`configDefaults`, `requiredFields`, `buildEnv`, `maskConfig`, and
optionally `normalizeField`/`onExit`), point it at a subprocess that writes
state files into its own `state/` dir, and the generic REST routes and
`/bracket` config panel wiring pick it up automatically.
