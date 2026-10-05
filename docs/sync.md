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
| Shufflepolo | `shufflepolo_sync/shufflepolo_sync.js` (Node) | Polled snapshot + realtime subscribe | `shufflepolo-config.json` |

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
- No API key — the feed is public/anonymous.
- Polls a snapshot endpoint and subscribes to a realtime feed for live
  score/clock updates.
- **Clock sync:** Shufflepolo's clock shape (`{status, elapsed_seconds,
  running_since, duration_seconds}`) is different from Podium's
  (`{running, phase, remaining_seconds}`); `public/scorebug-render.js`
  detects and renders both. The subprocess measures its own clock-sync
  offset against Shufflepolo's server close to the actual HTTP round trip
  and carries it through as `clock_offset_ms` rather than letting any
  downstream consumer (this server, the browser) recompute it against an
  already-stale timestamp — see `docs/shufflepolo-clock-sync-fix.md` for
  the full history of why this matters and what broke before it was fixed
  this way.

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
