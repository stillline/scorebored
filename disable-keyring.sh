#!/bin/bash

# Disable/Configure Keyring for Automated Startup
# Multiple approaches to prevent keyring password prompts

echo "🔓 Configuring keyring for automated startup..."

# Method 1: Set empty keyring password (if you don't store sensitive data)
echo "Method 1: Setting empty keyring password..."
echo "Note: This will remove password protection from your keyring!"
read -p "Continue? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # This requires the gnome-keyring tools
    if command -v gnome-keyring-daemon &> /dev/null; then
        echo "Setting empty password for login keyring..."
        # This would need to be run interactively
        echo "Run this command manually: gnome-keyring-daemon --unlock"
        echo "Then press Enter (empty password) when prompted"
    fi
fi

# Method 2: Configure chromium to not use keyring
echo ""
echo "Method 2: Create chromium config to bypass keyring..."
mkdir -p ~/.config/chromium/Default
cat > ~/.config/chromium/Default/Preferences << 'EOF'
{
   "profile": {
      "password_manager_enabled": false
   }
}
EOF

echo "✅ Chromium configured to not use password manager"

# Method 3: Environment variable approach
echo ""
echo "Method 3: Setting environment variables..."
cat >> ~/.bashrc << 'EOF'

# Disable keyring for automated applications
export GNOME_KEYRING_CONTROL=""
export GNOME_KEYRING_PID=""
EOF

echo "✅ Environment variables set (will take effect on next login)"

echo ""
echo "🎯 Keyring bypass configured!"
echo ""
echo "Restart your session or reboot to test the changes."
echo "The kiosk should now start without requiring password unlock."