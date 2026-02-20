#!/bin/bash

# ATEM Switcher Display Script
# Optimized for feeding HDMI signal to ATEM switcher
# Displays localhost:3000/display in fullscreen kiosk mode

set -e

echo "Starting ATEM switcher display for scoreboard..."
echo "Target URL: http://localhost:3000/display"

# Kill any existing chromium processes to avoid conflicts
echo "Cleaning up any existing browser processes..."
pkill chromium 2>/dev/null || true
pkill chromium-browser 2>/dev/null || true

# Wait a moment for cleanup
sleep 2

# Ensure we're using the primary display
export DISPLAY=:0

# Check if X server is running and accessible
if ! pgrep -x "Xwayland" > /dev/null; then
    echo "❌ Xwayland not running - cannot start display"
    echo "   Run this from a local session or start X server manually"
    exit 1
else
    echo "✅ Xwayland is running"
fi

# Wait for display to be available with timeout
echo "Waiting for display to be available..."
timeout=30
while [ $timeout -gt 0 ]; do
    if xdpyinfo &>/dev/null; then
        echo "Display :0 is ready!"
        break
    fi
    echo "Waiting for display... ($timeout seconds remaining)"
    sleep 1
    ((timeout--))
done

if [ $timeout -eq 0 ]; then
    echo "ERROR: Display not available after 30 seconds"
    exit 1
fi

# Configure display settings for optimal ATEM capture
echo "Configuring display settings..."

# Move cursor to bottom-right corner to keep it out of the way
echo "Moving cursor to bottom-right corner..."
sudo python3 ./move-cursor.py

# Disable screen blanking and power management
xset s off 2>/dev/null
xset -dpms 2>/dev/null
xset s noblank 2>/dev/null

# Set black background (good for keying)
xsetroot -solid black 2>/dev/null

# Configure audio output to HDMI for ATEM audio meters
echo "Configuring audio output to HDMI..."
export PULSE_DEFAULT_AUDIO_OUTPUT="vc4hdmi0"
export ALSA_DEFAULT_AUDIO_OUTPUT="hw:0,0"

# Set default audio output to HDMI 0 (change to hw:1,0 for HDMI 1 if needed)
amixer cset numid=3 2 >/dev/null 2>&1 || true  # Force to HDMI
pacmd set-default-sink alsa_output.platform-fef00700.hdmi.hdmi-stereo >/dev/null 2>&1 || true

echo "Starting Chromium in kiosk mode for ATEM capture..."

# Launch chromium with ATEM-optimized settings and keyring bypass
chromium \
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
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --autoplay-policy=no-user-gesture-required \
    --start-fullscreen \
    --window-position=0,0 \
    --window-size=1920,1080 \
    --force-device-scale-factor=1 \
    --user-data-dir=/tmp/chromium-atem-display \
    --password-store=basic \
    --use-mock-keychain \
    --disable-password-manager-reauthentication \
    --disable-features=PasswordImport \
    --enable-audio-service-api \
    --disable-audio-input \
    --disable-audio-input-capabilities \
    --alsa-output-device=hw:0,0 \
    --enable-aggressive-domstorage-flushing \
    http://localhost:3000/display &

CHROMIUM_PID=$!

echo ""
echo "✅ ATEM Display Started Successfully!"
echo ""
echo "🎥 Chromium PID: $CHROMIUM_PID"
echo "🖥️  Display: :0 (Primary HDMI)"
echo "🌐 URL: http://localhost:3000/display"
echo "🎬 Ready for ATEM switcher input!"
echo ""
echo "📺 The scoreboard should now be visible on your HDMI output"
echo "🔌 Connect this HDMI output to your ATEM switcher as a video source"
echo ""
echo "To stop the display: kill $CHROMIUM_PID"
echo "To restart: ./start-atem-display.sh"

# Wait for chromium to exit
wait $CHROMIUM_PID

echo "ATEM display stopped."