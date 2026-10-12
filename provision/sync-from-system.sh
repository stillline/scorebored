#!/bin/bash
# provision/sync-from-system.sh
# Copies the system-side configuration that the scoreboard rig depends on
# into provision/system/ so git can show what changed and what to put back.
# Run it, then `git diff provision/` and commit.
#
# Secrets are deliberately excluded: Wi-Fi client profiles (contain PSKs),
# hostapd.conf (AP passphrase), nginx.conf (YouTube stream key).
set -euo pipefail
cd "$(dirname "$0")"
OUT=system
rm -rf "$OUT"; mkdir -p "$OUT"

copy() { # copy <src> <dest-relative>  (sudo read, owned by user in the repo)
    local src=$1 dst=$OUT/$2
    mkdir -p "$(dirname "$dst")"
    if sudo -n test -e "$src"; then sudo -n cat "$src" > "$dst"; else echo "(missing on system)" > "$dst.MISSING"; fi
}

# Boot and kernel
copy /boot/firmware/config.txt             boot/config.txt
copy /boot/firmware/cmdline.txt            boot/cmdline.txt

# systemd: units we own and drop-ins we added
for u in scorebored atem-discovery-relay companion companion-keyboard-controller; do
    copy /etc/systemd/system/$u.service    systemd/$u.service
done
copy /etc/systemd/journald.conf.d/50-persistent-storage.conf systemd/journald.conf.d/50-persistent-storage.conf
copy /usr/local/bin/atem-discovery-relay.py bin/atem-discovery-relay.py
copy "$HOME/.config/labwc/environment"      labwc/environment
for u in scoreboard-deferred.target scoreboard-kiosk-up.path scoreboard-deferred-fallback.timer; do
    copy /etc/systemd/system/$u             systemd/$u
done
copy /etc/cloud/cloud-init.disabled        cloud/cloud-init.disabled

# NetworkManager: uplink and bridge profiles only (no Wi-Fi client PSKs)
for p in venue_ethernet netgear_hotspot mobile_router tmobile_hotspot switcher-bridge bridge-slave-end0; do
    f=/etc/NetworkManager/system-connections/$p.nmconnection
    sudo -n test -e "$f" && copy "$f" NetworkManager/$p.nmconnection || true
done

# Boot-time scripts
mkdir -p "$OUT/cron"
sudo -n crontab -l > "$OUT/cron/root.crontab" 2>/dev/null || echo "(empty)" > "$OUT/cron/root.crontab"
crontab -l > "$OUT/cron/matthew.crontab" 2>/dev/null || echo "(empty)" > "$OUT/cron/matthew.crontab"
copy /etc/rc.local                         rc.local
copy /etc/hosts                            hosts

# Desktop session (kiosk launch)
copy "$HOME/.config/labwc/autostart"       labwc/autostart
copy "$HOME/.config/autostart/scoreboard-kiosk.desktop" autostart/scoreboard-kiosk.desktop

# Speedify adapter priorities and enabled units, as state listings
speedify_cli show adapters 2>/dev/null | python3 -c '
import json,sys
for a in sorted(json.load(sys.stdin), key=lambda a:a["adapterID"]):
    print(a["adapterID"], a["type"], "priority", a["priority"])' > "$OUT/speedify-adapters.txt" || echo "(speedify_cli unavailable)" > "$OUT/speedify-adapters.txt"
systemctl list-unit-files --state=enabled --no-pager --no-legend | awk '{print $1}' | sort > "$OUT/systemd/enabled-units.txt"

echo "synced into provision/$OUT"
