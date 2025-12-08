#!/bin/bash

# Install ATEM Display Service
# Sets up automatic startup of scoreboard display for ATEM switcher

set -e

echo "Installing ATEM Display Service..."

# Stop and disable any existing display services
echo "Cleaning up existing services..."
sudo systemctl stop scoreboard-display 2>/dev/null || true
sudo systemctl disable scoreboard-display 2>/dev/null || true
sudo systemctl stop atem-display 2>/dev/null || true
sudo systemctl disable atem-display 2>/dev/null || true

# Copy service file to systemd directory
echo "Installing service file..."
sudo cp /home/matthew/bin/scorebored/atem-display.service /etc/systemd/system/

# Set correct permissions
sudo chmod 644 /etc/systemd/system/atem-display.service

# Reload systemd configuration
echo "Reloading systemd configuration..."
sudo systemctl daemon-reload

# Enable the service to start on boot
echo "Enabling ATEM display service..."
sudo systemctl enable atem-display

echo ""
echo "✅ ATEM Display Service installed successfully!"
echo ""
echo "Service commands:"
echo "  sudo systemctl start atem-display     # Start now"
echo "  sudo systemctl stop atem-display      # Stop service"
echo "  sudo systemctl status atem-display    # Check status"
echo "  sudo systemctl restart atem-display   # Restart service"
echo ""
echo "Logs:"
echo "  sudo journalctl -u atem-display -f    # Follow logs"
echo "  sudo journalctl -u atem-display       # View all logs"
echo ""
echo "🎬 The service will automatically start the display on boot"
echo "🎥 Make sure your scoreboard server starts before this service"
echo ""
echo "To start the service now:"
echo "  sudo systemctl start atem-display"