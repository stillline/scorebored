# Kiosk Display & Service Setup (Raspberry Pi)

How the Pi boots straight into a fullscreen `/display` kiosk with no manual
steps, and how the server itself runs as a system service. State as of
2026-10-12; the earlier two-monitor assumptions are gone.

## Display topology

The Pi has exactly one HDMI output in use: HDMI-A-2, cabled to the ATEM
Mini Pro ISO as a graphics input. HDMI-A-1 is never used. Everything the
compositor draws lands on the ATEM feed, so nothing but black or the
overlay may ever be on screen: no panel, no desktop icons, no cursor, no
dialogs.

## Server as a systemd service

`scorebored.service` runs `node server.js` under systemd:

```bash
sudo cp scorebored.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scorebored
sudo systemctl start scorebored
```

Restarts automatically on failure (`RestartSec=5`). Logs go to the
journal (`journalctl -u scorebored -f`), tagged `scorebored`. The journal
is persistent (see below), so logs survive reboots.

## Session: lightdm, labwc and the autostart

lightdm auto-logs the display user into a labwc (Wayland) session. labwc
runs two autostart files concurrently: the system one in
`/etc/xdg/labwc/autostart`, which launches the desktop panel
(`wf-panel-pi`) and the desktop manager (`pcmanfm --desktop`) under
`lwrespawn` watchers, and ours in `~/.config/labwc/autostart`.

Ours exists to undo the system one. It waits for each system watcher to
appear (they start at the same time as us, so an immediate `pkill` can
miss them and they then respawn the panel: that was the "two panels on the
ATEM feed" bug), kills the watchers, kills the panel and the desktop
process, relaunches nothing, and starts `launch-display.sh`. Five seconds
later it writes a warning to `~/.xsession-errors` if any panel or desktop
process is still alive. A copy of the file is kept in
`provision/system/labwc/autostart`.

## Kiosk display (`launch-display.sh`)

Sequence:

1. Covers the output with a black fullscreen window (`black-cover.py`, a
   Tkinter always-on-top window) so the bare compositor background is
   never visible during boot.
2. Disables the cursor, screen blanking, and DPMS (via Xwayland).
3. Waits (up to 60s) for the scoreboard server to respond on port 3000.
4. Kills any stale Chromium instance and clears stale singleton-lock files
   left behind by an unclean shutdown; a stale lock from a previous boot
   can otherwise make the next launch hang.
5. Launches Chromium in kiosk mode against `/display`, with a long list of
   flags disabling anything that could interrupt a fullscreen unattended
   display (infobars, session-restore prompts, notifications, popup
   blocking, password manager, background throttling).
6. After a fixed 4 s, removes the black cover.
7. If Chromium exits for any reason, the script restarts itself (`exec
   "$0"`), relaunching Chromium again.

Known weakness: step 6 is a timer, not a "first frame painted" signal.
Under heavy boot load Chromium has taken close to a minute to paint, during
which the cover was already gone. With the panel and desktop no longer
running, what shows in that gap is plain black, which is acceptable; the
proper fix is in the migration plan.

`/display` reloads itself when the server's instance id changes, so a code
deploy (`systemctl restart scorebored`) reaches the kiosk without
restarting Chromium.

## Reliability and crash capture

- **Hardware watchdog:** systemd arms the BCM2835 watchdog with a 1 minute
  timeout (Raspberry Pi OS default). A kernel panic or a hung PID 1 reboots
  the board within a minute; the kernel itself is set to hang on panic.
- **Persistent journal:** `/etc/systemd/journald.conf.d/50-persistent-storage.conf`
  overrides Pi OS's volatile default (256 MB cap). After an unexplained
  reboot, `journalctl --list-boots` and `journalctl -b -1` show the previous
  boot. journald syncs every 5 minutes, so a hard power cut loses the last
  few minutes.
- **Kernel panic capture:** `dtoverlay=ramoops-pi4,total-size=0x40000,record-size=0x20000`
  in `/boot/firmware/config.txt` reserves 256 KB of RAM for the panic text.
  It survives a watchdog reset and is archived by `systemd-pstore` on the
  next boot into `/var/lib/systemd/pstore/`. Check there after any boot
  loop. It does not survive a power cut.
- **Clock at boot:** the Pi 5 RTC has no battery, so every boot starts at
  1970, jumps to the last saved timestamp, then steps forward once NTP
  answers. Fitting the RTC battery removes this.

## Related one-time setup scripts

- **`enable-autologin.sh`**: enables auto-login on the display user so the
  graphical session comes up on boot with no manual login.
- **`disable-keyring.sh`**: prevents a keyring password prompt from
  blocking unattended startup.
- **`configure-hdmi-audio.sh`**: routes audio output to HDMI for the ATEM.
- **`setup-network-routing.sh`**: retired. It added iptables rules for a
  USB NIC that no longer exists and was removed from root's crontab on
  2026-10-12. Kept in the repo for reference only.

Run the first three once per fresh Pi image, not on every boot.

## Full reboot test

Both boot paths (the systemd service and the kiosk's `labwc` autostart)
need to come up correctly from a cold power cycle, not just survive a warm
`systemctl restart`, with no manual intervention. After any change to
either path, or to the system config under `provision/`, do a real
`sudo reboot` and confirm: overlay on the ATEM feed, no panel
(`pgrep -x wf-panel-pi` returns nothing), server answering on 3000, all
expected uplinks leased, `/var/lib/systemd/pstore/` empty.

Power the Pi off with `sudo poweroff`, not by cutting 12 V, when you can.
