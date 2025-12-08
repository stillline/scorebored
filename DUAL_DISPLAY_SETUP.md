# Dual Display Setup Guide

## 🎯 Your Perfect Workflow

### Default State: Auto-Kiosk Mode
```bash
# Pi boots automatically into kiosk mode (single display)
# Scoreboard shows on HDMI output
# Access via: http://your-pi-ip:3000/control
```

### Adding GUI Desktop via SSH
```bash
# 1. Plug in second HDMI display
# 2. SSH into the Pi
ssh matthew@your-pi-ip

# 3. Check what displays are connected
./detect-displays.sh

# 4. Switch to dual display mode
./switch-to-dual.sh
```

## 📋 Available Scripts

| Script | Purpose |
|--------|---------|
| `detect-displays.sh` | Show connected displays and current config |
| `switch-to-dual.sh` | Kiosk + Desktop (2 displays) |
| `switch-to-kiosk.sh` | Scoreboard kiosk only |
| `switch-to-desktop.sh` | Desktop GUI only |

## 🔄 Common Scenarios

### Scenario 1: Default Kiosk Operation
```bash
# Pi boots with single HDMI → Auto-starts scoreboard kiosk
# Control remotely via web interface or SSH
```

### Scenario 2: Add GUI Desktop
```bash
# Plug in second HDMI
ssh matthew@pi-ip
./switch-to-dual.sh
# → Display 1: Desktop GUI, Display 2: Scoreboard
```

### Scenario 3: Back to Kiosk Only
```bash
# Unplug second HDMI or run:
./switch-to-kiosk.sh
# → Single display scoreboard only
```

## 🖥️ Display Layout

### Dual Display Mode
```
┌─────────────────┐ ┌─────────────────┐
│   Desktop GUI   │ │  Scoreboard     │
│   (Control Pi)  │ │  (Kiosk Mode)   │
│   HDMI-A-1      │ │  HDMI-A-2       │
│   :0.0          │ │  :0.1           │
└─────────────────┘ └─────────────────┘
```

## ⚙️ Technical Details

### Auto-Start Service
- `atem-display.service` starts kiosk automatically on boot
- Waits for network and scoreboard server to be ready
- Enable: `sudo systemctl enable atem-display`

### Display Management
- Uses `xrandr` for display configuration
- Automatic X server startup if not running
- Separate desktop environment (LXDE) for GUI

### Remote Control
```bash
# Via SSH - Service control
sudo systemctl start/stop/restart atem-display

# Via SSH - Direct switching
./switch-to-dual.sh
./switch-to-kiosk.sh

# Via Web - Control panel
http://your-pi-ip:3000/control
```

## 🔧 Troubleshooting

### Display not detected
```bash
./detect-displays.sh  # Check connection status
xrandr --query         # Raw display info
```

### GUI not starting
```bash
# Check desktop process
ps aux | grep lxsession

# Restart GUI manually
pkill lxsession && DISPLAY=:0 startlxde &
```

### Kiosk not showing
```bash
# Check service status
sudo systemctl status atem-display
sudo journalctl -u atem-display -f

# Manual start
./start-atem-display.sh
```

## 📁 File Overview

**Core Scripts:**
- `start-atem-display.sh` - Main kiosk launcher
- `setup-atem-display.sh` - Initial system setup
- `install-atem-service.sh` - Service installer

**Display Management:**
- `detect-displays.sh` - Display detection
- `switch-to-dual.sh` - Enable dual display mode
- `switch-to-kiosk.sh` - Kiosk-only mode
- `switch-to-desktop.sh` - Desktop-only mode

**System Files:**
- `atem-display.service` - Systemd service
- `kiosk-session.sh` - X session configuration
- `enable-autologin.sh` - Auto-login setup