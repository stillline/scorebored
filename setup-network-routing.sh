#!/bin/bash
# Network routing setup for connecting 10.42.0.0/24 (Pi Access Point) to 192.168.55.0/24 (Home LAN)
# With LM1200 in bridge mode, Pi is directly on 192.168.55.0/24 network
# No NAT needed - pure routing only

# Allow forwarding between networks
iptables -A FORWARD -i br0 -o enx8cae4ccdd68d -s 10.42.0.0/24 -d 192.168.55.0/24 -j ACCEPT 2>/dev/null || true
iptables -A FORWARD -i enx8cae4ccdd68d -o br0 -s 192.168.55.0/24 -d 10.42.0.0/24 -j ACCEPT 2>/dev/null || true

# Get current Pi IP for reference
PI_IP=$(ip route get 192.168.55.1 | grep -oP 'src \K[0-9.]+')

echo "Network routing setup complete - Pi IP: ${PI_IP} (pure routing, no NAT)"