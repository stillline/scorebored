#!/bin/bash

# ATEM Display Setup Script
# Complete setup for Pi to display scoreboard on HDMI for ATEM switcher

set -e

echo "🎬 ATEM Switcher Display Setup"
echo "==============================="
echo ""

# Update package list
echo "📦 Updating package list..."
sudo apt update

# Install required packages if not already installed
echo "📦 Installing required packages..."
sudo apt install -y \
    chromium \
    xorg \
    xinit \
    x11-xserver-utils \
    unclutter \
    xdotool \
    curl

echo ""
echo "✅ All packages installed successfully!"
echo ""

# Make scripts executable
echo "🔧 Setting up scripts..."
chmod +x /home/matthew/bin/scorebored/start-atem-display.sh
chmod +x /home/matthew/bin/scorebored/install-atem-service.sh
chmod +x /home/matthew/bin/scorebored/kiosk-session.sh

echo "✅ Scripts configured!"
echo ""

echo "🎥 ATEM Display Setup Complete!"
echo "==============================="
echo ""
echo "Next steps:"
echo ""
echo "1. 🖥️  Manual Testing:"
echo "   # Start your scoreboard server first:"
echo "   npm start &"
echo ""
echo "   # Then start the ATEM display (run locally on Pi, not over SSH):"
echo "   ./start-atem-display.sh"
echo ""
echo "2. 🚀 Automatic Startup:"
echo "   # Install the systemd service:"
echo "   ./install-atem-service.sh"
echo ""
echo "   # Enable auto-login (recommended):"
echo "   ./enable-autologin.sh"
echo ""
echo "3. 🎬 ATEM Integration:"
echo "   - Connect Pi's HDMI output to your ATEM switcher"
echo "   - The display will show localhost:3000/display in fullscreen"
echo "   - Control the scoreboard from any device at http://[pi-ip]:3000/control"
echo ""
echo "Troubleshooting:"
echo "   - Make sure to run display scripts locally on the Pi (not over SSH)"
echo "   - Ensure your scoreboard server is running first"
echo "   - Check service status: sudo systemctl status atem-display"
echo "   - View logs: sudo journalctl -u atem-display -f"