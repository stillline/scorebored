# Kiosk Display & Service Setup (Raspberry Pi)

How the Pi boots straight into a fullscreen `/display` kiosk with no manual
steps, and how the server itself runs as a system service.

## Server as a systemd service

`scorebored.service` runs `node server.js` under systemd:

```bash
sudo cp scorebored.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scorebored
sudo systemctl start scorebored
```

Restarts automatically on failure (`RestartSec=5`). Logs go to the
journal (`journalctl -u scorebored -f`), tagged `scorebored`.

This replaced an earlier `npm start`-based autostart entry — if you find
remnants of that on a given Pi image, remove them in favor of the unit
file.

## Kiosk display (`launch-display.sh`)

Runs from `labwc`'s (Wayland compositor) autostart on the display-driving
Pi. Sequence:

1. Covers the HDMI output with a black fullscreen window
   (`black-cover.py`, a Tkinter always-on-top window) immediately, before
   anything else, so the raw desktop is never visible during boot.
2. Disables the cursor, screen blanking, and DPMS.
3. Waits (up to 60s) for the scoreboard server to respond on port 3000.
4. Kills any stale Chromium instance and clears stale singleton-lock files
   left behind by an unclean shutdown (e.g. the Pi's hardware watchdog
   firing) — a stale lock from a previous boot can otherwise make the next
   launch hang.
5. Launches Chromium in kiosk mode against `/display`, with a long list of
   flags disabling anything that could interrupt a fullscreen unattended
   display (infobars, session-restore prompts, notifications, popup
   blocking, password manager, background throttling).
6. After Chromium paints its first frame (~4s), removes the black cover.
7. If Chromium exits for any reason, the script restarts itself (`exec
   "$0"`), relaunching Chromium again.

### Related one-time setup scripts

- **`enable-autologin.sh`** — enables auto-login on the display user so the
  graphical session (and therefore `labwc`'s autostart) comes up on boot
  with no manual login.
- **`disable-keyring.sh`** — prevents a keyring password prompt from
  blocking unattended startup.
- **`configure-hdmi-audio.sh`** — routes audio output to HDMI for the ATEM.

Run these once per fresh Pi image, not on every boot.

## Networking (venue-specific)

**`setup-network-routing.sh`** sets up `iptables` forwarding between the
Pi's own access-point subnet (`10.42.0.0/24`) and a specific home-network
range (`192.168.55.0/24`) through a specific router in bridge mode. This is
tuned to one specific venue/network topology — treat the IPs and interface
names in it as examples to adapt, not a general-purpose script to run
as-is on a different network.

## Full reboot test

Both boot paths (the systemd service and the kiosk's `labwc` autostart)
need to come up correctly from a cold power cycle — not just survive a
warm `systemctl restart` — with no manual intervention. If you're setting
up a new Pi or changing either path, do a real `sudo reboot` test before
trusting it unattended at an event.
