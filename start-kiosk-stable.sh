#!/bin/bash

# Start Kiosk Mode - SSH-Safe Version
# Uses nohup and proper backgrounding for stability

echo "🎬 Starting stable kiosk mode..."

# Kill any existing chromium
pkill chromium 2>/dev/null || true
sleep 2

# Check if server is running
if ! curl -sf http://localhost:3000/ >/dev/null 2>&1; then
    echo "❌ Scoreboard server not running!"
    echo "   Start it with: npm start"
    exit 1
fi

echo "✅ Server is running"

# Start chromium with nohup for persistence
echo "🚀 Starting chromium kiosk..."

nohup chromium \
    --display=:0 \
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
    --user-data-dir=/tmp/chromium-stable-kiosk \
    --no-first-run \
    --disable-default-apps \
    --disable-popup-blocking \
    http://localhost:3000/display \
    > /tmp/chromium-kiosk.log 2>&1 &

CHROMIUM_PID=$!

echo ""
echo "✅ Kiosk started successfully!"
echo "🎬 Chromium PID: $CHROMIUM_PID"
echo "🌐 URL: http://localhost:3000/display"
echo "📄 Log: /tmp/chromium-kiosk.log"
echo ""
echo "To stop: pkill chromium"
echo "To check: ps aux | grep chromium"
echo ""