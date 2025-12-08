#!/bin/bash

# Delayed Kiosk Startup - Waits for system to be ready
# This runs automatically after desktop login

# Wait a bit for system to stabilize
sleep 10

# Wait for network
echo "Waiting for network..." >> /tmp/kiosk-autostart.log
while ! ping -c1 127.0.0.1 >/dev/null 2>&1; do
    sleep 1
done

# Wait for scoreboard server
echo "Waiting for scoreboard server..." >> /tmp/kiosk-autostart.log
while ! curl -sf http://localhost:3000/ >/dev/null 2>&1; do
    sleep 2
done

# Start the kiosk
echo "Starting kiosk..." >> /tmp/kiosk-autostart.log
cd /home/matthew/bin/scorebored
./start-kiosk-stable.sh >> /tmp/kiosk-autostart.log 2>&1

echo "Kiosk startup completed" >> /tmp/kiosk-autostart.log
