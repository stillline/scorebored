# Scorebored - Live Scoreboard System

A real-time scoreboard application designed for bicycle polo tournaments and sports events. Features customizable team colors, persistent state, ATEM switcher integration, and a full tournament schedule manager.

## Pages

| URL | Purpose |
|-----|---------|
| `/control` | Main operator control panel |
| `/display` | Clean scoreboard output (fullscreen/overlay) |
| `/bracket` | Tournament schedule manager |
| `/network` | Network and Speedify dashboard |
| `/apchannel` | Wi-Fi access point channel selector |

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
- **Commercial Break** — triggers ATEM switcher cut to graphics input with full audio management (see ATEM section)

---

## Tournament Schedule (`/bracket`)

Pre-populate all tournament matchups and manage results from one page.

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

### Default data

The schedule comes pre-loaded with the Santo tournament (32 games, Grupo A + Grupo B). Default team colors are `#292929` and `#ebebeb`.

---

## Display (`/display`)

Clean scoreboard output — fullscreen this on the display machine.

- Team names with auto-resizing text
- Colored score boxes per team
- Transparent background for chroma/luma keying in OBS or ATEM
- Receives all updates via WebSocket; no manual refresh needed

---

## ATEM Integration

Connects to a Blackmagic ATEM Mini Pro ISO on startup.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `ATEM_IP` | `10.42.0.100` | ATEM IP address |
| `GRAPHICS_INPUT` | `1` | HDMI input number for the scoreboard computer |
| `DOWNSTREAM_KEY` | `1` | DSK number used for the scoreboard overlay |

**Commercial break sequence:**

1. Turns off the upstream key (USK)
2. Fades out the downstream key (DSK)
3. Auto-transitions to the graphics input
4. Mutes all Fairlight audio inputs except the graphics HDMI
5. Plays the selected video on the display page

**End of break:**

1. Cuts back to the previous camera input
2. Turns the DSK back on
3. Turns the USK back on
4. Restores camera audio (mics remain muted for manual restore)

---

## Persistent State

| File | Purpose |
|------|---------|
| `gamestate.json` | Live scoreboard state (scores, colors, ATEM status, active matchup index) |
| `bracket.json` | Tournament schedule with all matchups, colors, and final scores |

Both files are auto-created and updated at runtime. Do not edit while the server is running.

---

## Installation (Raspberry Pi)

```bash
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone https://github.com/stillline/scorebored.git
cd scorebored
npm install

# Start
node server.js
```

### Run as a systemd service

```ini
# /etc/systemd/system/scorebored.service
[Unit]
Description=Scorebored
After=network.target

[Service]
Type=simple
User=matthew
WorkingDirectory=/home/matthew/bin/scorebored
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable scorebored
sudo systemctl start scorebored
```

---

## File Structure

```
scorebored/
├── server.js              # Main server (Express + Socket.IO + ATEM)
├── package.json
├── gamestate.json         # Auto-generated live state
├── bracket.json           # Auto-generated tournament schedule + results
└── public/
    ├── control.html       # Operator control panel
    ├── display.html       # Scoreboard display output
    ├── bracket.html       # Tournament schedule manager
    ├── network.html       # Network / Speedify dashboard
    └── apchannel.html     # Wi-Fi AP channel selector
```

---

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

**ATEM not connecting:**
- Verify `ATEM_IP` env var or default `10.42.0.100`
- Check ATEM is powered and on the same network
- The server retries automatically; use the Connect button on the control panel
