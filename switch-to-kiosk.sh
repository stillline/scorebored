#!/bin/bash

# Switch to Kiosk-Only Mode
# Scoreboard fullscreen on primary display, no desktop GUI

set -e

echo "🎬 Switching to Kiosk-Only Mode"
echo "==============================="

export DISPLAY=:0

# Stop desktop GUI if running
echo "🛑 Stopping desktop GUI..."
pkill lxsession 2>/dev/null || true
pkill startlxde 2>/dev/null || true
pkill xfce4-session 2>/dev/null || true

# Stop any existing kiosk
echo "🛑 Stopping existing kiosk..."
sudo systemctl stop atem-display 2>/dev/null || true
pkill -f "chromium.*kiosk" 2>/dev/null || true
sleep 2

# Ensure X server is running
echo "🖥️  Checking X server status..."
if ! pgrep -x "X" > /dev/null && ! pgrep -f "Xorg" > /dev/null && ! pgrep -f "Xwayland" > /dev/null; then
    echo "⚠️  X server not running - restarting display manager..."

    # Stop and restart lightdm to ensure clean X server startup
    sudo systemctl stop lightdm
    sleep 2
    sudo systemctl start lightdm

    # Wait for X server to start with timeout
    echo "⏳ Waiting for X server to start..."
    timeout=30
    while [ $timeout -gt 0 ]; do
        if pgrep -x "X" > /dev/null || pgrep -f "Xorg" > /dev/null || pgrep -f "Xwayland" > /dev/null; then
            echo "✅ X server started successfully"
            break
        fi
        sleep 1
        ((timeout--))
    done

    if [ $timeout -eq 0 ]; then
        echo "❌ ERROR: X server failed to start within 30 seconds"
        echo "   Trying manual X server troubleshooting..."
        echo "   Current X processes:"
        ps aux | grep -E "(X|Xorg|lightdm)" | grep -v grep
        echo "   You may need to connect a monitor and restart the Pi"
        exit 1
    fi

    # Give X server a moment to fully initialize
    sleep 3
else
    echo "✅ X server is already running"
fi

# Verify display is accessible
echo "🔍 Verifying display accessibility..."
export DISPLAY=:0
if ! timeout 10 xrandr --query &>/dev/null; then
    echo "⚠️  Display :0 not accessible, trying to restart X server..."
    sudo systemctl restart lightdm
    sleep 5

    if ! timeout 10 xrandr --query &>/dev/null; then
        echo "❌ ERROR: Cannot access display :0"
        echo "   This usually happens when no monitor is connected"
        echo "   Please ensure a monitor is connected to HDMI and try again"
        exit 1
    fi
fi
echo "✅ Display :0 is accessible"

# Get connected displays
DISPLAYS=$(xrandr --query | grep " connected" | grep -v "disconnected" | cut -d' ' -f1)
PRIMARY_DISPLAY=$(echo "$DISPLAYS" | head -1)
DISPLAY_COUNT=$(echo "$DISPLAYS" | wc -l)

echo "📺 Found $DISPLAY_COUNT display(s): $DISPLAYS"

if [ "$DISPLAY_COUNT" -eq 1 ]; then
    echo "📺 Configuring single display mode on $PRIMARY_DISPLAY..."
    xrandr --output "$PRIMARY_DISPLAY" --mode 1920x1080 --pos 0x0 --primary
else
    echo "📺 Multiple displays detected - using $PRIMARY_DISPLAY for kiosk..."
    # Configure primary display and turn off others
    xrandr --output "$PRIMARY_DISPLAY" --mode 1920x1080 --pos 0x0 --primary

    # Turn off additional displays one by one
    for display in $(echo "$DISPLAYS" | tail -n +2); do
        echo "📺 Disabling additional display: $display"
        xrandr --output "$display" --off 2>/dev/null || echo "   (Failed to disable $display - may already be off)"
    done
fi

sleep 2

# Start the ATEM kiosk service
echo "🎬 Starting scoreboard kiosk..."
sudo systemctl start atem-display

echo ""
echo "✅ Kiosk-Only Mode Activated!"
echo "============================="
echo ""
echo "🎬 Scoreboard: $PRIMARY_DISPLAY (fullscreen)"
echo "🌐 Display URL: http://localhost:3000/display"
echo "🎮 Control URL: http://localhost:3000/control"
echo ""
echo "📋 Management Commands:"
echo "   ./detect-displays.sh     - Check current status"
echo "   ./switch-to-dual.sh      - Switch to dual display (if 2nd connected)"
echo "   sudo systemctl stop atem-display  - Stop kiosk"
echo ""