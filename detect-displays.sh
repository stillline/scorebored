#!/bin/bash

# Display Detection and Configuration Script
# Detects connected displays and shows current configuration

echo "🖥️  Display Detection & Configuration"
echo "======================================"

# Ensure we can access the display
export DISPLAY=:0

# Check if X is running and accessible
if ! DISPLAY=:0 xdpyinfo >/dev/null 2>&1; then
    echo "❌ X server not accessible on DISPLAY=:0"
    echo "   Try: sudo systemctl start atem-display"
    echo "   Or run this script from a local terminal session"
    exit 1
fi

echo ""
echo "📺 Connected Displays:"
echo "----------------------"

# Get connected displays
CONNECTED_DISPLAYS=$(xrandr --query | grep " connected" | grep -v "disconnected")

if [ -z "$CONNECTED_DISPLAYS" ]; then
    echo "❌ No displays detected"
    exit 1
fi

# Count and list displays
DISPLAY_COUNT=$(echo "$CONNECTED_DISPLAYS" | wc -l)
echo "Found $DISPLAY_COUNT connected display(s):"
echo ""

# Parse each display
while IFS= read -r line; do
    DISPLAY_NAME=$(echo "$line" | cut -d' ' -f1)
    RESOLUTION=$(echo "$line" | grep -o '[0-9]*x[0-9]*+[0-9]*+[0-9]*' | head -1)
    STATUS=$(echo "$line" | grep -o 'primary\|connected')

    if [[ "$line" == *"primary"* ]]; then
        echo "🟢 $DISPLAY_NAME (PRIMARY) - $RESOLUTION"
    else
        echo "🔵 $DISPLAY_NAME - $RESOLUTION"
    fi
done <<< "$CONNECTED_DISPLAYS"

echo ""
echo "📊 Current Configuration:"
echo "------------------------"

# Check what's running
if pgrep -f "chromium.*kiosk" > /dev/null; then
    CHROMIUM_DISPLAY=$(ps aux | grep "chromium.*kiosk" | grep -v grep | head -1)
    echo "🎬 Kiosk Mode: ACTIVE"
    echo "   Scoreboard running in Chromium"
else
    echo "🎬 Kiosk Mode: INACTIVE"
fi

# Check for desktop environment
if pgrep -x "lxsession\|startlxde\|xfce4-session" > /dev/null; then
    echo "🖱️  Desktop GUI: ACTIVE"
else
    echo "🖱️  Desktop GUI: INACTIVE"
fi

echo ""
echo "🔧 Available Actions:"
echo "--------------------"

if [ "$DISPLAY_COUNT" -eq 1 ]; then
    echo "📱 Single Display Mode Options:"
    echo "   ./switch-to-kiosk.sh     - Scoreboard kiosk only"
    echo "   ./switch-to-desktop.sh   - Desktop GUI only"
elif [ "$DISPLAY_COUNT" -eq 2 ]; then
    echo "🖥️  Dual Display Mode Options:"
    echo "   ./switch-to-dual.sh      - Kiosk + Desktop (recommended)"
    echo "   ./switch-to-kiosk.sh     - Kiosk only (both displays)"
    echo "   ./switch-to-desktop.sh   - Desktop only (both displays)"
else
    echo "⚠️  Multiple displays detected - manual configuration may be needed"
fi

echo ""