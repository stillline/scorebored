#!/bin/bash

# Switch to Desktop-Only Mode
# Desktop GUI only, no scoreboard kiosk

set -e

echo "🖱️  Switching to Desktop-Only Mode"
echo "=================================="

export DISPLAY=:0

# Stop kiosk service and any running kiosk
echo "🛑 Stopping scoreboard kiosk..."
sudo systemctl stop atem-display 2>/dev/null || true
pkill -f "chromium.*kiosk" 2>/dev/null || true
sleep 2

# Check if X is running, start if needed
if ! pgrep -x "X" > /dev/null; then
    echo "🖥️  Starting X server..."
    sudo startx /home/matthew/bin/scorebored/kiosk-session.sh -- :0 &
    sleep 5
fi

# Get displays and configure
DISPLAYS=$(xrandr --query | grep " connected" | grep -v "disconnected" | cut -d' ' -f1)
DISPLAY_COUNT=$(echo "$DISPLAYS" | wc -l)

echo "📺 Configuring $DISPLAY_COUNT display(s) for desktop use..."

if [ "$DISPLAY_COUNT" -eq 1 ]; then
    # Single display setup
    PRIMARY_DISPLAY=$(echo "$DISPLAYS" | head -1)
    xrandr --output "$PRIMARY_DISPLAY" --mode 1920x1080 --pos 0x0 --primary
    echo "   Single display: $PRIMARY_DISPLAY"
elif [ "$DISPLAY_COUNT" -eq 2 ]; then
    # Dual display extended desktop
    DISPLAY1=$(echo "$DISPLAYS" | sed -n '1p')
    DISPLAY2=$(echo "$DISPLAYS" | sed -n '2p')
    xrandr --output "$DISPLAY1" --mode 1920x1080 --pos 0x0 --primary \
           --output "$DISPLAY2" --mode 1920x1080 --pos 1920x0
    echo "   Extended desktop: $DISPLAY1 (left) + $DISPLAY2 (right)"
fi

sleep 2

# Start desktop environment if not already running
if ! pgrep -x "lxsession" > /dev/null; then
    echo "🖱️  Starting desktop GUI..."
    DISPLAY=:0 startlxde &
    sleep 3
else
    echo "🖱️  Desktop GUI already running"
fi

echo ""
echo "✅ Desktop-Only Mode Activated!"
echo "==============================="
echo ""
echo "🖱️  Desktop GUI: Active on all displays"
echo "🎬 Scoreboard:   Stopped"
echo ""
echo "📋 You can now:"
echo "   - Use the desktop GUI normally"
echo "   - Open web browser to http://localhost:3000/control"
echo "   - SSH in to run ./switch-to-kiosk.sh when ready"
echo ""
echo "📋 Management Commands:"
echo "   ./detect-displays.sh     - Check current status"
echo "   ./switch-to-kiosk.sh     - Switch back to kiosk mode"
echo "   ./switch-to-dual.sh      - Dual display mode (if 2 displays)"
echo ""