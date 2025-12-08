#!/bin/bash

# Move Kiosk to Specific Display
# Usage: ./move-kiosk-to-display.sh [HDMI-A-1|HDMI-A-2]

DISPLAY_NAME=${1:-HDMI-A-2}

echo "🎬 Moving kiosk to $DISPLAY_NAME..."

# Kill existing chromium
echo "🛑 Stopping existing kiosk..."
pkill chromium 2>/dev/null || true
sleep 2

# Set display
export DISPLAY=:0

# Check if display exists
if ! DISPLAY=:0 xrandr --query | grep "$DISPLAY_NAME connected" >/dev/null 2>&1; then
    echo "❌ Display $DISPLAY_NAME not found or not connected"
    echo "Available displays:"
    DISPLAY=:0 xrandr --query | grep " connected" | cut -d' ' -f1
    exit 1
fi

echo "📺 Starting kiosk on $DISPLAY_NAME..."

# Start chromium on specific display
DISPLAY=:0 chromium \
    --kiosk \
    --no-sandbox \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --autoplay-policy=no-user-gesture-required \
    --disable-features=TranslateUI \
    --start-fullscreen \
    --password-store=basic \
    --use-mock-keychain \
    --disable-password-manager-reauthentication \
    --disable-features=PasswordImport \
    --user-data-dir=/tmp/chromium-kiosk-$DISPLAY_NAME \
    http://localhost:3000/display &

CHROMIUM_PID=$!

echo ""
echo "✅ Kiosk moved to $DISPLAY_NAME!"
echo "🎬 Chromium PID: $CHROMIUM_PID"
echo "🌐 URL: http://localhost:3000/display"
echo ""
echo "To stop: kill $CHROMIUM_PID"
echo ""