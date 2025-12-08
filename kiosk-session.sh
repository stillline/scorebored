#!/bin/bash

# Simple X session for kiosk mode
export DISPLAY=:0

# Set background to black
xsetroot -solid black

# Hide cursor after 0.5 seconds of inactivity
unclutter -idle 0.5 -root &

# Prevent screen blanking
xset s off
xset -dpms
xset s noblank

# Keep X session running
while true; do
    sleep 60
done