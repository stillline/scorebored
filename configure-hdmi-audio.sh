#!/bin/bash

# Configure HDMI Audio for ATEM Switcher
echo "🔊 Configuring HDMI Audio Output for ATEM..."

# Set audio output to HDMI (card 0)
echo "Setting default audio output to HDMI 0..."
amixer cset numid=3 2 >/dev/null 2>&1 || echo "amixer config failed (normal if using PulseAudio)"

# Configure PulseAudio if available
if command -v pacmd &> /dev/null; then
    echo "Configuring PulseAudio..."
    pacmd set-default-sink alsa_output.platform-fef00700.hdmi.hdmi-stereo >/dev/null 2>&1 || echo "PulseAudio sink not found"
fi

# Test audio output
echo "Testing audio output..."
if command -v aplay &> /dev/null; then
    # Generate a quick test tone to HDMI
    ( speaker-test -t wav -c 2 -l 1 -D hw:0,0 >/dev/null 2>&1 & )
    sleep 1
    pkill speaker-test >/dev/null 2>&1 || true
fi

# Check current audio routing
echo ""
echo "📊 Current Audio Configuration:"
echo "Available cards:"
cat /proc/asound/cards

echo ""
echo "Current routing:"
amixer cget numid=3 2>/dev/null || echo "Cannot read amixer routing"

echo ""
echo "✅ HDMI Audio Configuration Complete!"
echo ""
echo "💡 Tips:"
echo "   - If using HDMI 1 instead of HDMI 0, change hw:0,0 to hw:1,0"
echo "   - Restart the ATEM display script to apply changes"
echo "   - Check ATEM multiview for audio meters on Camera 1"