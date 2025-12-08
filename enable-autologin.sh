#!/bin/bash

# Enable auto-login for graphical display

echo "Configuring auto-login for display user..."

# Enable auto-login in raspi-config style
sudo raspi-config nonint do_boot_behaviour B4

# Alternative method using systemd override
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
sudo cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin matthew --noclear %I \$TERM
EOF

echo "Auto-login configured for user 'matthew'"
echo "The Pi will automatically log in and can start the display service"