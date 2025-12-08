#!/bin/bash

# Setup Auto-Start for Kiosk Mode
# Configures the Pi to automatically start kiosk on boot

echo "🚀 Setting up auto-start configuration..."

# Create autostart directory if it doesn't exist
mkdir -p ~/.config/autostart

# Create desktop entry for auto-start
cat > ~/.config/autostart/scoreboard-kiosk.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=Scoreboard Kiosk
Exec=/home/matthew/bin/scorebored/delayed-kiosk-start.sh
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
StartupNotify=false
EOF

# Create delayed startup script (waits for everything to be ready)
cat > /home/matthew/bin/scorebored/delayed-kiosk-start.sh << 'EOF'
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
EOF

# Make the delayed start script executable
chmod +x /home/matthew/bin/scorebored/delayed-kiosk-start.sh

echo "✅ Auto-start configured!"
echo ""
echo "📋 Configuration:"
echo "   - Kiosk will auto-start after desktop login"
echo "   - Waits for network and server to be ready"
echo "   - Uses the working start-kiosk-stable.sh script"
echo "   - Logs to: /tmp/kiosk-autostart.log"
echo ""
echo "🔧 To test:"
echo "   1. Enable auto-login: ./enable-autologin.sh"
echo "   2. Reboot the Pi"
echo "   3. Kiosk should start automatically"
echo ""
echo "🛑 To disable:"
echo "   rm ~/.config/autostart/scoreboard-kiosk.desktop"
echo ""