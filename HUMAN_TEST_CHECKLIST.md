# Human test checklist — foundation hardening refactor

Features touched by the refactor that were verified by code review + boot
checks only (no live ATEM hardware, no real tournament data) and need a
human pass — ideally during one of the shakedown test streams before the
next tournament — before being trusted in production.

Check items off as they're verified. Add a line with what broke (if
anything) and how it was fixed.

## ATEM control (extracted to lib/atem.js)

- [x] **Connect on startup** — verified against the real switcher during
      this refactor: `connectToAtem()` connected successfully, correctly
      populated `atemStatus` (currentInput: 3, downstreamKeyEnabled: ON,
      upstreamKeyEnabled: ON) through the new module.
- [x] **Keyboard-controller REST API** (`/api/atem/input/:num`) — verified
      against the real switcher: `POST /api/atem/input/3` returned
      `{"success":true,"input":3}` and actually commanded the cut.
- [ ] **Commercial break start** — cuts to graphics input, downstream key
      fades in, audio snapshot/mute sequencing still fires in the right
      order (`startCommercialBreak` socket handler). NOT exercised against
      real hardware during the refactor - code-reviewed only.
- [ ] **Commercial break stop** — downstream key fades out, switches back to
      `previousInput`, audio restores to its pre-break snapshot. NOT
      exercised against real hardware - code-reviewed only.
- [ ] **Manual ATEM controls** on the control panel: switch input button,
      toggle downstream key, toggle upstream key, start bars. Only the
      keyboard-controller route and startup connect were exercised against
      real hardware; the socket-driven manual controls were not.
- [ ] **Bars mode** (start/stop) — snapshots audio, cuts to bars input 1000,
      restores on stop. Not exercised against real hardware.
- [ ] **DSK/USK state tracking** — `atemStatus` in gameState (connected,
      currentInput, downstreamKeyEnabled, upstreamKeyEnabled) stays accurate
      after a real switcher state change (e.g. someone else touches the
      physical ATEM panel during a show). The `stateChanged` listener logic
      was moved as-is but not independently re-verified against a live
      external change.

## Tournament-sync unification (Phase 4 — lib/sync.js)

- [ ] **Challonge**, during a real poll cycle against a real tournament:
      confirm `/bracket` page's Challonge panel still toggles/saves/lists
      tournaments correctly, and bracket.json still gets overwritten as
      expected.
- [ ] **Podium**, during a real live-stream event: confirm score/clock
      pushes still land on the display correctly through the new generic
      `/api/sync/podium/push` route.
- [x] **Shufflepolo** — run end to end against a real published tournament
      ("NAH Testing", LosAngelesBikePolo): snapshot read, realtime subscribe,
      live score/clock showing up on `/display`, bracket.json sync all
      confirmed working. Two things broke and were fixed along the way:
      (1) `shufflepolo-config.json` had the full tournament page URL pasted
      into `tournamentId` instead of the bare UUID, which the feed API
      rejects with `400 invalid_tournament` — fixed the config, and added a
      `normalizeField` hook (`lib/sync.js` + `server.js`) so the shufflepolo
      provider now extracts the UUID automatically if a full URL is pasted
      in via the bracket page UI. (2) An orphaned `node server.js` process
      from an earlier manual run (not managed by systemd) was still running
      alongside the real systemd-managed one, and its own stale shufflepolo
      child process was racing to overwrite `state/status.json` with the old
      error — killed the orphan tree, no code change needed for that part.
      (3) `/display`'s clock renderer only understood Podium's clock shape
      (`{running, phase, remaining_seconds}`); Shufflepolo's is completely
      different (`{status, elapsed_seconds, running_since,
      duration_seconds}`), passed through to `gameState.clock` untranslated
      — fixed by teaching `renderClockNow()` in `public/display.html` to
      detect and render both shapes. Confirmed live against a running game
      (Deez Netz vs Hammers), countdown ticking correctly on both a desktop
      browser and the kiosk's physical HDMI output. Note for next time: the
      kiosk Chromium (launched once by `launch-display.sh`, Wayland/labwc,
      no auto-reload) doesn't pick up static file changes on its own —
      `pkill -x chromium` is the way to force it to reload, since the
      script's own watchdog relaunches it immediately.
- [ ] **teams.html / bracket-viewer.html** still work against whichever
      provider is actually enabled (currently only re-pointed at
      `/api/sync/challonge/*` — not yet provider-agnostic, that's Phase 6).

## iPhone pairing panel (Phase 1b — public/network.html)

- [ ] **Pair New Phone** button, with a real brand-new iPhone plugged in on
      site — confirm the trust-prompt flow and resulting bonded interface
      actually show up correctly, not just that the socket call succeeds.

## systemd service (Phase 7)

- [x] Service starts, restarts, and responds correctly - verified live on
      the Pi (HTTP/display/network pages, ATEM reconnect, Speedify/Podium
      subprocess spawning, wpctl and sudo-gated nmcli/hostapd calls, kiosk
      browser's socket.io auto-reconnect) without a full reboot.
- [ ] **Full reboot test** - the one thing not exercised: power-cycle (or
      `sudo reboot`) the Pi and confirm the server comes up via systemd,
      and the kiosk display comes up via labwc's autostart + launch-display.sh
      waiting for it, with no manual intervention needed. This is the real
      test of whether the two boot paths actually coordinate correctly from
      a cold start, not just from a warm `systemctl restart`.

## Node 22 upgrade (Phase 3)

- [ ] Confirm nothing else on the Pi that might incidentally shell out to
      `node` (cron jobs, other scripts) broke silently from the version
      bump — spot-checked logs at upgrade time but worth another look after
      a few days of normal use.

---
Delete this file once everything above is checked off and trusted.
