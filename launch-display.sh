#!/bin/bash
# launch-display.sh
# Runs from labwc autostart. Immediately covers HDMI-A-2 with a black window,
# waits for the scoreboard server, then launches Chromium kiosk and removes
# the cover. Restarts Chromium automatically if it exits.

export DISPLAY=:0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ts() { echo "launch-display: $1 at $(date +%T.%3N) (up $(cut -d' ' -f1 /proc/uptime)s)" >&2; }
ts begin

# Clear system-injected Chromium flags — /etc/chromium.d/extensions adds
# --load-extension= (empty, no extensions installed) which breaks kiosk mode.
unset CHROMIUM_FLAGS

# Suppress cursor on X display (Xwayland)
pkill -x unclutter 2>/dev/null || true
unclutter -idle 0.1 -root &

# Solid black X root (visible under Xwayland before cover window appears)
xsetroot -solid black

# Disable screen blanking / DPMS
xset s off
xset -dpms
xset s noblank

# Black fullscreen cover over HDMI-A-2 — hides naked desktop during startup.
# Killed once Chromium has painted its first frame.
rm -f /tmp/cover-window.pid
python3 "$SCRIPT_DIR/black-cover.py" &
COVER_PID=$!

# Brief pause to let the cover window render before anything else appears
sleep 0.5

# Wait for scoreboard server on port 3000 (up to 60 seconds)
ts "cover up, waiting for server"
for i in $(seq 1 60); do
    if curl -sf http://localhost:3000/ -o /dev/null 2>/dev/null; then
        break
    fi
    sleep 1
done
ts "server answered"

# Kill any stale Chromium instance
pkill -x chromium 2>/dev/null || true
sleep 0.5

# Clear stale singleton-lock artifacts. A hard reset (e.g. the Pi's hardware
# watchdog firing) never lets Chromium exit cleanly, so these can point at a
# PID from a previous boot and make the next launch hang/misbehave resolving
# the lock instead of starting normally.
rm -f /tmp/chromium-atem-display/SingletonLock \
      /tmp/chromium-atem-display/SingletonCookie \
      /tmp/chromium-atem-display/SingletonSocket

# Launch Chromium in kiosk mode on the primary X display (Xwayland → HDMI-A-2)
chromium \
    --kiosk \
    --noerrdialogs \
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
    http://localhost:3000/display &

CHROMIUM_PID=$!
ts "chromium started (pid $CHROMIUM_PID)"

# Wait for Chromium to paint, then remove the black cover. Kill the cover by
# the PID we started, not via its pid file: on a slow cold boot the cover can
# take longer than this to map its window and write the file, and a kill
# keyed on the file then silently misses, leaving the cover on top forever.
sleep 4
ts "removing cover (pid $COVER_PID)"
kill "$COVER_PID" 2>/dev/null || true
rm -f /tmp/cover-window.pid

# Tell systemd the overlay is on screen: scoreboard-kiosk-up.path starts the
# deferred services (Companion, keypad bridge) on this file.
touch "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/scoreboard-kiosk-up"

# Restart automatically if Chromium exits
wait "$CHROMIUM_PID"
ts "chromium exited (status $?), restarting"
sleep 2
exec "$0"
