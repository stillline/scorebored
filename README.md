# Scorebored - Live Scoreboard System

A real-time scoreboard application designed for bicycle polo tournaments and sports events. Features customizable team colors, persistent state storage, and overlay-friendly display output for streaming and video production.

## Features

- **Real-time Updates**: Live scoreboard that updates instantly across all connected devices
- **Customizable Colors**: Individual team colors plus global text and background color controls
- **Persistent State**: Automatically saves and restores game state after server crashes or restarts
- **Overlay Ready**: Clean display output optimized for video overlays and streaming
- **Responsive Text**: Automatically resizes team names to fit display area
- **Touch-Friendly Controls**: Easy-to-use control interface for tablets and mobile devices

## Installation on Raspberry Pi

### Prerequisites

1. **Raspberry Pi** (Pi 3 or newer recommended)
2. **Raspberry Pi OS** (latest version)
3. **Network connection** (WiFi or Ethernet)

### Step 1: Update Your Raspberry Pi

```bash
sudo apt update && sudo apt upgrade -y
```

### Step 2: Install Node.js

```bash
# Install Node.js (version 16 or newer)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

### Step 3: Clone and Install the Application

```bash
# Clone the repository
git clone https://github.com/stillline/scorebored.git
cd scorebored

# Install dependencies
npm install
```

### Step 4: Start the Server

```bash
# Start the server
node server.js
```

The server will start on port 3000. You should see:
```
Scoreboard server running on port 3000
Display: http://localhost:3000/display
Control: http://localhost:3000/control
```

### Step 5: Access the Scoreboard

On your Raspberry Pi or any device on the same network:

- **Control Panel**: `http://[PI_IP_ADDRESS]:3000/control`
- **Display**: `http://[PI_IP_ADDRESS]:3000/display`

To find your Pi's IP address: `ip addr show`

## Usage

### Control Panel (`/control`)
- Set team names (up to 16 characters)
- Adjust scores with +/- buttons
- Customize team colors with color pickers
- Set global text and background colors
- Swap teams or reset scores
- All changes are automatically saved

### Display (`/display`)
- Clean scoreboard display
- Team names with auto-resizing text
- Colored score boxes
- Optimized for fullscreen display (press F11)
- Transparent background for video overlays

### Video Production Integration

For **ATEM switchers** or **OBS**:
1. Open display page in fullscreen (F11)
2. Use as video source for overlay keying
3. Background and colors are optimized for chroma/luma keying

## Running as a Service (Auto-start)

To make the scoreboard start automatically on boot:

### Step 1: Create a systemd service

```bash
sudo nano /etc/systemd/system/scorebored.service
```

Add this content (replace `/path/to/scorebored` with actual path):

```ini
[Unit]
Description=Scoreboard Application
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/scorebored
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Step 2: Enable and start the service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable scorebored

# Start the service now
sudo systemctl start scorebored

# Check status
sudo systemctl status scorebored
```

## Network Access

### For Local Network Access

The scoreboard will be accessible to any device on your local network at:
- `http://[PI_IP_ADDRESS]:3000`

### For External Access (Optional)

To access from outside your network, you'll need to:
1. Set up port forwarding on your router (port 3000)
2. Or use a service like ngrok for temporary external access

## Troubleshooting

### Server Won't Start
- Check if port 3000 is already in use: `sudo lsof -i :3000`
- Kill existing processes: `sudo pkill node`

### Can't Access from Other Devices
- Check Pi's firewall: `sudo ufw status`
- Ensure devices are on same network
- Verify Pi's IP address: `ip addr show`

### Performance Issues
- Use Pi 3 or newer for best performance
- Ensure good network connection
- Close unnecessary applications

## File Structure

```
scorebored/
├── server.js              # Main server application
├── package.json           # Node.js dependencies
├── gamestate.json         # Auto-generated state file (don't edit)
├── public/
│   ├── control.html       # Control panel interface
│   ├── display.html       # Scoreboard display
│   └── test.html          # Test page
└── README.md              # This file
```

## Configuration

### Default Settings
- **Port**: 3000
- **Team Names**: Team 1, Team 2
- **Text Color**: White (#ffffff)
- **Background**: Grey (#808080)
- **Score Colors**: Green (#2E7D32), Red (#B71C1C)

### Customization
All settings can be changed through the control panel and are automatically saved to `gamestate.json`.

## Support

For issues or feature requests, please visit the [GitHub repository](https://github.com/stillline/scorebored).

## License

MIT License - See repository for full license text.