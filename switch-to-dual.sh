#!/bin/bash

# Switch to Dual Display Mode
# Scoreboard on one display, Desktop GUI on the other

set -e

echo "🖥️  Switching to Dual Display Mode"
echo "=================================="

export DISPLAY=:0

# Check if X is running
if ! pgrep -x "X" > /dev/null; then
    echo "❌ X server not running - starting it first..."
    sudo systemctl start atem-display
    sleep 5
fi

# Get connected displays
DISPLAYS=$(xrandr --query | grep " connected" | grep -v "disconnected" | cut -d' ' -f1)
DISPLAY_COUNT=$(echo "$DISPLAYS" | wc -l)

if [ "$DISPLAY_COUNT" -lt 2 ]; then
    echo "❌ Need at least 2 displays connected for dual mode"
    echo "   Currently connected: $DISPLAY_COUNT"
    echo "   Try: ./detect-displays.sh"
    exit 1
fi

# Get the two displays
DISPLAY1=$(echo "$DISPLAYS" | sed -n '1p')
DISPLAY2=$(echo "$DISPLAYS" | sed -n '2p')

echo "📺 Configuring displays:"
echo "   $DISPLAY1 - Desktop GUI (left)"
echo "   $DISPLAY2 - Scoreboard Kiosk (right)"

# Configure extended desktop: GUI on left, Kiosk on right
echo "🔧 Setting up extended desktop..."
xrandr --output "$DISPLAY1" --mode 1920x1080 --pos 0x0 --primary \
       --output "$DISPLAY2" --mode 1920x1080 --pos 1920x0

sleep 2

# Stop any existing kiosk
echo "🛑 Stopping existing kiosk..."
sudo systemctl stop atem-display 2>/dev/null || true
pkill -f "chromium.*kiosk" 2>/dev/null || true
sleep 2

# Start desktop environment on primary display (DISPLAY1)
echo "🖱️  Starting desktop GUI on $DISPLAY1..."

# Check if desktop is already running
if ! pgrep -x "lxsession" > /dev/null; then
    # Start LXDE desktop environment
    DISPLAY=:0.0 startlxde &
    sleep 3
fi

# Start scoreboard kiosk on secondary display (DISPLAY2)
echo "🎬 Starting scoreboard kiosk on $DISPLAY2..."

# Launch chromium on the second display
DISPLAY=:0.1 chromium \
    --kiosk \
    --no-sandbox \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-features=TranslateUI \
    --disable-ipc-flooding-protection \
    --disable-dev-shm-usage \
    --disable-gpu-sandbox \
    --disable-web-security \
    --disable-notifications \
    --disable-popup-blocking \
    --autoplay-policy=no-user-gesture-required \
    --start-fullscreen \
    --window-position=1920,0 \
    --window-size=1920,1080 \
    --force-device-scale-factor=1 \
    --user-data-dir=/tmp/chromium-dual-kiosk \
    --password-store=basic \
    --use-mock-keychain \
    --disable-password-manager-reauthentication \
    --disable-features=PasswordImport \
    http://localhost:3000/display &

CHROMIUM_PID=$!

echo ""
echo "✅ Dual Display Mode Activated!"
echo "==============================="
echo ""
echo "🖱️  Desktop GUI: $DISPLAY1 (left display)"
echo "🎬 Scoreboard:   $DISPLAY2 (right display)"
echo "🌐 Kiosk URL:    http://localhost:3000/display"
echo "🎮 Control URL:  http://localhost:3000/control"
echo ""
echo "📋 Management Commands:"
echo "   ./detect-displays.sh     - Check current status"
echo "   ./switch-to-kiosk.sh     - Switch to kiosk-only"
echo "   kill $CHROMIUM_PID       - Stop kiosk manually"
echo ""
echo "🔧 To stop dual mode:"
echo "   pkill chromium && pkill lxsession"
echo ""