# Scorebored — Live Scoreboard System

A real-time scoreboard application for bicycle polo tournaments and similar
sports events. One Node server drives a live scoreboard overlay, a
tournament schedule, an ATEM switcher, networking/bonding on the Pi, and
score data pulled live from a tournament platform — all kept in sync over
Socket.IO across every connected page.

## Quick start

```bash
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone https://github.com/stillline/scorebored.git
cd scorebored
npm install
node server.js
```

For running unattended on a Raspberry Pi (systemd service + kiosk
display), see [docs/kiosk-display.md](docs/kiosk-display.md).

## Pages

| URL | Purpose |
|-----|---------|
| `/control` | Main operator control panel |
| `/display` | Clean scoreboard output (fullscreen/overlay) |
| `/bracket` | Tournament schedule manager + score-sync provider config |
| `/editor` | Scorebug visual design editor |
| `/teams` | Read-only roster viewer for the active sync provider |
| `/bracket-viewer/:provider` | Per-provider bracket/standings viewer |
| `/network` | Network dashboard (Wi-Fi AP, Speedify, RTMP, iPhone pairing) |
| `/apchannel` | Wi-Fi access point channel selector (also reachable from `/network`) |
| `/display-legacy` | Older SVG scorebug overlay, kept as a fallback |

## Features

- **[Control panel & tournament schedule](#control-panel-control)** —
  running a game day-to-day (below)
- **[ATEM switcher integration](docs/atem.md)** — commercial breaks,
  downstream key management, audio muting
- **[Score data syncing](docs/sync.md)** — Challonge, Podium, and
  Shufflepolo live score/bracket feeds
- **[Scorebug editor](docs/scorebug-editor.md)** — visual design and
  preset system for the on-air scoreboard
- **[Network dashboard](docs/network.md)** — Wi-Fi AP, Speedify bonding,
  RTMP relay, iPhone tether pairing
- **[Kiosk display & systemd service](docs/kiosk-display.md)** — Pi
  autostart, fullscreen Chromium kiosk, server-as-a-service

---

## Control Panel (`/control`)

The primary interface for running a game.

- **Team names** — editable text fields; changes broadcast instantly to all displays
- **Score controls** — `+` / `−` buttons per team; scores never go below 0
- **Team colors** — color picker per team; also controls the score box background
- **Score text colors** — separate color picker per team score
- **Global colors** — text color and scoreboard background color
- **Color presets** — 20 saved color swatches (persisted in browser localStorage); click to apply, long-press or use paste button to set
- **Swap Sides** — mirrors left/right teams, scores, and colors
- **Reset Game** — sets both scores to 0
- **Prev Game / Next Game** — navigate through the tournament schedule; loads the next/previous matchup's teams and colors onto the scoreboard, resetting scores to 0. Saving a final score for the active matchup is done on the `/bracket` page (see below), not from the control panel.
- **Commercial Break** — triggers ATEM switcher cut to graphics input with full audio management ([details](docs/atem.md))

When a score-sync provider is enabled, live score/clock/penalty data from
the platform takes over these fields automatically — see
[docs/sync.md](docs/sync.md).

## Tournament Schedule (`/bracket`)

Pre-populate all tournament matchups and manage results from one page, or
drive the schedule live from Challonge/Podium/Shufflepolo
([docs/sync.md](docs/sync.md)).

### Layout

Each row shows:
- Drag handle (`⠿`) — drag to reorder
- Match number and scheduled time (click time to edit inline)
- Left team: color swatch + name
- `VS`
- Right team: color swatch + name
- Final score boxes (left score `−` right score)
- `↺` — reset to unplayed (clears the final flag, keeps scores visible)
- `Save` — write the score boxes to `bracket.json` and mark the game as final without touching the scoreboard
- `Load` / `Now Playing` — load this matchup onto the scoreboard (team names, colors, and saved scores)
- `✕` — delete the row

### Visual states

- **Normal** — upcoming or in-progress game
- **Greyed out** — game has been finalized (both scores saved with `final: true`)
- **Now Playing** — the matchup currently active on the scoreboard

### Live updates

- Score boxes update in real time as scores change on the scoreboard (for the active, non-finalized game)

### Workflow

1. Open `/bracket` and hit **Save Schedule** on first use (creates `bracket.json`)
2. Click **Load** on a matchup — teams, colors, and any existing scores load onto the scoreboard
3. Play the game; scores update live in the schedule
4. At the end, hit **Save** on the bracket page — scores are saved and the game is greyed out as final
5. Use **Next Game** on the control page to load the next matchup (resets scores to 0)
6. To correct a finalized result: change the score boxes on the bracket page and hit **Save** again
7. To un-finalize a game: click `↺` — the game returns to normal appearance but retains whatever scores were entered

## Display (`/display`)

Clean scoreboard output — fullscreen this on the display machine.

- Team names with auto-resizing text
- Colored score boxes per team
- Transparent background for chroma/luma keying in OBS or ATEM
- Receives all updates via WebSocket; no manual refresh needed
- Renders whichever scorebug preset is currently active ([details](docs/scorebug-editor.md))

---

## Persistent State

| File | Purpose |
|------|---------|
| `gamestate.json` | Live scoreboard state (scores, colors, ATEM status, active matchup index) |
| `bracket.json` | Tournament schedule with all matchups, colors, and final scores |
| `presets/` | Scorebug designs (see [docs/scorebug-editor.md](docs/scorebug-editor.md)) |
| `*-config.json` (challonge/podium/shufflepolo) | Score-sync provider config (see [docs/sync.md](docs/sync.md)) |

All of the above are gitignored and auto-created at runtime. Do not edit
them by hand while the server is running.

## File structure

```
scorebored/
├── server.js              # Main server (Express + Socket.IO + routes)
├── lib/
│   ├── atem.js             # ATEM switcher control
│   ├── network.js          # Wi-Fi AP / scan+connect / iPhone pairing
│   ├── rtmp.js              # RTMP destination editor
│   ├── speedify.js          # Speedify bonding stats
│   └── sync.js              # Shared score-sync provider lifecycle
├── challonge/               # Challonge sync provider subprocess
├── podium_sync/             # Podium sync provider subprocess (vendors libpodium)
├── shufflepolo_sync/        # Shufflepolo sync provider subprocess
├── public/                  # All pages (control, display, bracket, editor, ...)
├── presets/                 # Scorebug designs (gitignored, runtime)
└── docs/                    # Per-feature documentation
```

## Troubleshooting

**Port already in use:**
```bash
sudo lsof -i :3000
sudo pkill node
```

**Can't access from other devices:**
- Confirm devices are on the same network
- Check firewall: `sudo ufw status`
- Find Pi IP: `ip addr show`

**ATEM not connecting:** see [docs/atem.md](docs/atem.md#troubleshooting).
