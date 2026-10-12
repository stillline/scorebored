# Handoff: switcherpi, the bike polo broadcast appliance

Written 2026-10-11 for a reviewing agent. Purpose: describe the current system
completely enough that you can propose a better way to reach the same result
than the plan in `docs/embedded-migration-plan.md`. Challenge the plan; do not
assume it is right. Everything in section 2 was read off the running machine
today, not from documentation.

## 1. What we are trying to achieve

A Raspberry Pi 5 that behaves like a broadcast appliance at a bike polo
tournament. From power-on, with nobody touching it, it must:

1. Put a live scoreboard overlay (a web page) on its single HDMI output,
   which feeds a Blackmagic ATEM Mini Pro ISO as a graphics input. The ATEM
   keys it over the camera feed. Nothing but black or the overlay may ever
   appear on that output: no desktop, no panel, no cursor, no splash, no
   error dialog, no browser chrome.
2. Serve the operator web UIs (score control, bracket, network dashboard,
   overlay editor) to phones and laptops on its own Wi-Fi access point and
   on venue Wi-Fi.
3. Pull live scores and brackets from one of three tournament platforms.
4. Control the ATEM over the network for commercial breaks (cut to the
   graphics input, fade the downstream key, mute audio, play a video with
   sound over HDMI).
5. Relay the ATEM's RTMP program stream to YouTube over a bonded internet
   connection (Speedify over venue Wi-Fi + a cellular hotspot + iPhones on
   USB).
6. Host Bitfocus Companion (a stream-deck style controller) and a USB keypad
   bridge into it.
7. Survive power loss, hard resets and the hardware watchdog without manual
   recovery, and leave logs behind when something goes wrong.
8. Be reproducible: a second SD card we can build, test on the bench, and
   swap in or out.

Today all of this runs on the stock Raspberry Pi OS desktop image, bent
into a kiosk. That works most of the time, but it is a desktop with a
desktop's failure modes, and the migration plan is about replacing it with
something appliance-shaped. The tournament is about 12 days out; the
production card will not change before it. The migration target is a
second card.

What we want from you: the most efficient, robust and maintainable way to
get the same result. Alternatives to any layer are welcome: a different base
OS, a different display stack, a different way to package the app, a
different way to build or update the card, a different way to handle
read-only root and state. Keep in mind the constraints in section 4 and the
evaluation criteria in section 7. If you think the plan is already the right
shape, say so and point at the weakest parts.

## 2. The system as it exists today

### 2.1 Hardware

- Raspberry Pi 5 Model B rev 1.1, 8 GB RAM, 64 GB SD card (21 GB used).
- OS: Raspberry Pi OS desktop, Debian 13 Trixie, 64-bit, kernel
  6.12.47+rpt-rpi-2712. labwc Wayland compositor, lightdm autologin.
- Exactly one HDMI cable, ever: HDMI-A-2 to the ATEM. The ATEM's EDID shows
  as "HXA BMD HDMI", 1920x1080@60. HDMI-A-1 is empty and will stay empty.
- Audio: HDMI audio to the ATEM through PipeWire/WirePlumber. The server
  shells out to `wpctl set-volume 56 1.0` with a hard-coded sink id.
- PCIe HAT with two Realtek RTL8125 2.5 GbE ports (`enP1p3s0` unused,
  `enP1p4s0` to a Netgear cellular hotspot).
- Onboard `end0` Ethernet to the ATEM side. Onboard `wlan0` as a client to
  venue Wi-Fi.
- Two Realtek 8812AU/8821AU USB Wi-Fi dongles. One (`wlx00c0cab7e676`) runs
  the access point. One is dormant. They are driven by two different
  drivers: the out-of-tree `8821au` DKMS module (package
  `realtek-rtl8188eus` dkms, built against the rpt kernel headers) and the
  in-tree `rtw88_8821cu`.
- USB HID: an Apple wireless receiver and a "LiQi" composite device, read
  through evdev by the Companion keypad bridge.
- iPhones on USB for Speedify bonding, via `usbmuxd` and
  `libimobiledevice-utils`.
- Pi 5 RTC present, no battery fitted. Each boot starts at 1970, systemd
  advances to the last timesync stamp, NTP then steps the clock about five
  minutes forward once the network is up. Any process started before that
  sees the step.
- Hardware watchdog (BCM2835) armed by systemd with a 1 minute timeout,
  from Raspberry Pi OS's default `40-rpi-enable-watchdog.conf`.
- `/boot/firmware/config.txt`: `dtoverlay=vc4-kms-v3d`, `dtparam=audio=on`,
  `disable_splash=1`, `usb_max_current_enable=1`, `arm_boost=1`, defaults
  otherwise.

### 2.2 Network

- `br0` bridges `end0` and the AP dongle. NetworkManager owns `br0` in
  `shared` mode at `10.42.0.1/24`; NM's dnsmasq does DHCP and DNS for that
  segment. The ATEM is at `10.42.0.100`. The Pi is also `10.42.0.2` on
  `end0` for historical reasons.
- `hostapd` runs the AP on the dongle: SSID `switcher_net`, 5 GHz, channel
  36, 80 MHz, WPA2-PSK. The server edits `channel=` in
  `/etc/hostapd/hostapd.conf` with `sudo sed` and restarts hostapd when the
  operator changes channel from the web UI.
- Uplinks: `wlan0` (venue Wi-Fi, several saved NM profiles), `enP1p4s0`
  (hotspot, DHCP), iPhones (USB tether). Speedify bonds them into a tun
  interface `connectify0` and is the default route.
- `/etc/hosts` pins `a.rtmp.youtube.com` to an IPv4 address because the Pi
  has an IPv6 address with no IPv6 connectivity and nginx-rtmp resolves to
  AAAA and hangs. Root cause (broken IPv6) never fixed.
- Cron `@reboot` runs `setup-network-routing.sh`, which adds iptables
  FORWARD rules between `br0` and a USB NIC `enx8cae4ccdd68d` that no longer
  exists. Stale. `rc.local` runs `iw wlan0 set power_save off`.
- `atem-discovery-relay.service` (root, python3) relays UDP 9910 broadcasts
  between `wlan0` and `end0` so Wi-Fi clients could discover the ATEM. It
  predates `br0`; probably redundant now, unverified.
- Also present and probably unnecessary: rpcbind/NFS client bits, avahi,
  cups, RealVNC server on 5900, iperf3 server on 5201 (iperf3 is used for
  bench tests and is wanted).

Listening today: tcp 22 ssh, 80 nginx (`/stat`), 1935 nginx-rtmp, 3000
scorebored, 5201 iperf3, 5900 RealVNC, 8000 Companion, 9330 Speedify,
16622/16623 Companion internals; udp 53/67 dnsmasq on br0, 5353 mDNS
(avahi, node, speedify), 9910 ATEM relay, assorted Speedify UDP.

### 2.3 Services

| Unit | What | User | Depends on |
|---|---|---|---|
| `scorebored.service` | Node 22 app, `node server.js` in `/home/matthew/bin/scorebored`, `Restart=on-failure`, `After=network-online.target` | matthew | node, python3, speedify_cli, nmcli, PipeWire, sudo |
| `companion.service` | Bitfocus Companion headless. Self-contained in `/opt/companion` (0.7 GB, ships its own node runtime). Config in `~/.config/companion-nodejs`. Web UI on 8000 | matthew | nothing system-level |
| `companion-keyboard-controller.service` | python3 script in `~/keycontrol`, reads evdev devices, posts to Companion's HTTP API on 8000 | root | python3-evdev, python3-requests |
| `atem-discovery-relay.service` | python3 UDP relay, see 2.2 | root | - |
| `nginx.service` | RTMP relay: `application live`, ATEM publishes to `rtmp://10.42.0.x/live`, nginx pushes to the YouTube ingest URL (stream key inside `nginx.conf`, world-readable). HTTP `/stat` on 80 | www-data | libnginx-mod-rtmp |
| `speedify.service`, `speedify-sharing.service` | Proprietary bonding VPN from Connectify's apt repo, version 16.1.1. Licence tied to an account login | root | - |
| `hostapd.service` | AP | root | dongle driver |
| `NetworkManager.service` | everything in 2.2 | root | - |
| `usbmuxd.service` | iPhone USB | root | - |
| `iperf3.service` | bench testing | iperf3 | - |
| `lightdm.service` | autologin to labwc session for user matthew | root | desktop stack |
| `vncserver-x11-serviced` | RealVNC, proprietary, desktop only | root | desktop |
| `ssh` | admin | root | - |

Sudo: `matthew ALL=(ALL) NOPASSWD: ALL`. The app relies on this.

### 2.4 The scorebored application

Repo: `/home/matthew/bin/scorebored`, branch `API_REWORK`, ~2300 line
`server.js` plus `lib/` modules. Express static site + REST + Socket.IO.

Pages (all served from `public/`): `/display` (the overlay the ATEM sees),
`/display-legacy`, `/control` (scores, teams, colours, ATEM buttons,
commercial break), `/bracket` (schedule, next/prev game, sync provider
config), `/teams`, `/bracket-viewer/:provider`, `/network` (AP channel,
Wi-Fi join, Speedify stats, RTMP destination, iPhone pairing),
`/apchannel`, `/overlay-editor` (paste-HTML scorebug designer with
versions and logo compositing), `/overlay/:id` (renders a design).

REST: `/api/score/:side/:change`, `/api/prev-game`, `/api/next-game`,
`/api/swap-sides`, `/api/atem/input/:num`, `/api/bracket`,
`/api/sync/:provider/{config,status,participants,bracket,push,resync,toggle}`,
`/api/display/reload`, `/api/videos`, `/api/presets...`, `/api/overlays...`
(versions, duplicate, rating, logos, blocks, transforms), `/api/logos`
(multipart upload, resized with `sharp`).

Socket.IO events from clients: `updateScore`, `updateTeamName`,
`updateTeamColor`, `updateGlobalColor`, `swapSides`, `resetGame`,
`loadMatchup`, `navigateMatchup`, `setActive`, `setDebugOverlay`,
`reloadDisplay`, `atemConnect`, `atemSwitchInput`, `atemToggleDownstreamKey`,
`atemToggleUpstreamKey`, `atemStartBars`, `startCommercialBreak`,
`stopCommercialBreak`, `getApConfig`, `setApChannel`, `scanApChannels`,
`getInterfaces`, `getWifiNetworks`, `connectWifi`, `reconnectPrevious`,
`getIphones`, `pairIphone`, `getSpeedifyState/Adapters/Server/Settings`,
`runStreamTest`, `getNginxStreamDest`, `setNginxStreamDest`,
`getSyncConfig`, `setSyncConfig`, `toggleSync`, `listChallongeTournaments`.
Server broadcasts: `gameUpdate` (full game state, every change),
`displayBlack`, `reloadDisplay`, `overlayContentChanged`, `speedifyStats`.

Game state: one JSON object (teams, scores, colours, clock with
`running_since`/`elapsed_seconds`/`clock_offset_ms`, penalties, timeouts,
active overlay/preset) persisted to `gamestate.json` on every change and
reloaded at start. Includes `_serverInstanceId`; `/display` reloads itself
when that id changes, which is how a code deploy reaches the kiosk without
restarting Chromium.

Sync providers, each a child process managed by `lib/sync.js` with
restart-with-backoff and stale-status detection:
- Challonge: `challonge/challonge_sync.py`, python3 stdlib, polls the
  Challonge v1 API over https (500 req/month cap).
- Podium: `podium_sync/podium_sync.py`, python3 stdlib only by design
  (vendored `libpodium` client), websocket push from Podium, posts to
  `http://localhost:3000/api/sync/podium/push`.
- Shufflepolo: `shufflepolo_sync/shufflepolo_sync.js`, node with
  `@supabase/supabase-js`, Supabase realtime websocket + ETag re-reads,
  measures its own clock offset against their server because the Pi's
  clock steps at boot.

ATEM: `lib/atem.js` with the `atem-connection` npm package, UDP 9910 to
`10.42.0.100`, env `ATEM_IP`, `GRAPHICS_INPUT`, `DOWNSTREAM_KEY`.
Commercial break: USK off, DSK fade, auto-transition to graphics input,
mute all Fairlight inputs except the graphics HDMI, play a video on
`/display` with HDMI audio.

Shell-outs from the server (all must exist on any replacement):
`speedify_cli` (one persistent `-s stats` stream plus one-shots), `nmcli`
(with and without sudo: status, wifi list/rescan, con up/modify),
`sudo iwlist scan`, `idevicepair`, `idevice_id`, `ideviceinfo`,
`wpctl`, `cat /etc/hostapd/hostapd.conf`, `sudo sed -i` on it,
`sudo systemctl restart hostapd`, `sudo tee` of a send-buffer script.

npm deps: express, socket.io, multer, sharp (native, prebuilt libvips for
linux-arm64 glibc), atem-connection, @supabase/supabase-js. Node 22.23.
Python 3.13.

Persistent files in the repo tree (must survive reboots and a read-only
root): `gamestate.json`, `bracket.json`, `overlays/*.json`, `presets/`,
`public/logos/`, `public/videos/` (4.3 GB of mp4), `challonge-config.json`,
`podium-config.json`, `shufflepolo-config.json` (API keys),
`*/state/*.json`, `iphone-names.json`. System-side state: NM connection
profiles (Wi-Fi passwords), `hostapd.conf`, `nginx.conf` (stream key),
Speedify login/licence state, `/var/lib/lockdown` (iPhone pairing),
Companion config, journal.

### 2.5 The display pipeline today (the fragile part)

lightdm autologins user matthew into a labwc Wayland session. labwc runs
`/etc/xdg/labwc/autostart` and `~/.config/labwc/autostart` concurrently.
The system one starts `wf-panel-pi` (top panel) and `pcmanfm --desktop`
under `lwrespawn` watchers. Until today the user one tried to `pkill` those
watchers and relaunch them "on HDMI-A-1", a monitor that does not exist,
then launched `launch-display.sh`.

`launch-display.sh` (bash, 110 lines): sets `DISPLAY=:0` (Xwayland),
starts `unclutter`, `xsetroot -solid black`, `xset s off / -dpms`, starts a
Tk fullscreen black "cover" window, waits up to 60 s for `curl
localhost:3000`, kills any Chromium, removes stale `SingletonLock` files
left by hard resets, launches Chromium under Xwayland with `--kiosk
--no-sandbox --disable-gpu-sandbox --user-data-dir=/tmp/chromium-atem-display
--autoplay-policy=no-user-gesture-required --password-store=basic
--use-mock-keychain --window-size=1920,1080` and ~15 more flags, sleeps a
fixed 4 s, kills the cover window, waits on Chromium, and `exec`s itself
when Chromium exits.

Known failure modes, all seen:
- The 4 s cover timer versus Chromium's actual first paint. This morning
  Chromium took ~50 s to paint under boot load, so the bare desktop (with
  two panels) was on the ATEM feed for most of a minute.
- The panel-kill race: the two autostart files run concurrently; a `pkill`
  that runs before the system watcher has exec'd misses it, the watcher
  respawns a second panel. Fixed today by not running the panel or desktop
  at all (wait for the watchers, kill them, do not relaunch).
- Chromium's network service crashed and restarted on first load this boot
  (`Network service crashed, restarting service` in `.xsession-errors`).
- Hard resets leave Chromium singleton lock files; handled by deleting them.
- A hard reset of the whole Pi happened this morning between 03:22 and
  03:26 while the overlay was up. Cause unknown. The previous session log
  ends in null bytes (unclean shutdown). The journal was volatile
  (Raspberry Pi OS default), so the previous boot's kernel and systemd
  logs are gone. Candidates: the 1 minute hardware watchdog firing after a
  PID 1 stall, power, or something else. `vcgencmd get_rsts` says `1000`;
  the firmware power-reset flag is 0; no under-voltage flags.
- The clock step at boot (section 2.1) hits every timestamp-dependent
  process started before NTP answers.

### 2.6 Changes made today on the production card

- journald switched to persistent storage with a 256 MB cap via
  `/etc/systemd/journald.conf.d/50-persistent-storage.conf` (overriding Pi
  OS's volatile default). Current boot flushed to disk.
- `~/.config/labwc/autostart` rewritten: wait for the system `lwrespawn`
  watchers to exist, kill them, kill `wf-panel-pi`, the `pcmanfm-pi`
  wrapper and `pcmanfm`, do not relaunch anything, start
  `launch-display.sh`, and after 5 s log a warning to `.xsession-errors`
  if any panel or desktop process is still alive. Applied live too.

Added 2026-10-12, after the handoff was first written:
- ramoops crash capture (`dtoverlay=ramoops-pi4`) after a boot loop with a
  kernel panic that evening; the panic text was not captured that time.
- `provision/` snapshot of system config in the repo plus etckeeper on
  `/etc` (see `docs/system-config.md`).
- Stale `@reboot` routing cron removed; `atem-discovery-relay.service`
  disabled after confirming ATEM Software Control discovers the ATEM across
  the bridge from switcher_net Wi-Fi.
- Uplinks finished: Netgear LM1200 (Verizon) in Router mode on PCIe port 2,
  T-Mobile hotspot on PCIe port 1, ASIX USB Ethernet adapter for venue
  Ethernet, all "always" in Speedify; AP dongle set to "never". Hotspots
  are powered off unless testing or streaming. Verizon SIM verified on LTE;
  throughput at home unusable (SINR 0 dB).

## 3. The current plan (what you are asked to improve on)

Full text in `docs/embedded-migration-plan.md`. Summary:

- Base: Raspberry Pi OS Lite Trixie 64-bit, not Buildroot/Yocto, because
  Speedify (proprietary, Debian packages only), the DKMS Wi-Fi driver and
  Companion's bundled runtime are all known-good on it, and nobody is
  available to maintain a Yocto layer.
- Display: no display manager, no desktop. `cage` (single-app Wayland
  kiosk compositor) running Chromium natively on Wayland as a user systemd
  service bound to `scorebored.service`, `Restart=always`. Fallback: labwc
  with a panel-free config under the same unit if cage misbehaves on vc4.
  Audio via PipeWire user services or Chromium straight to ALSA; test both.
- Services: every component a systemd unit with restart policy;
  `scorebored` gets `WatchdogSec` + sd_notify; cron and rc.local folded
  into a fixups unit; RealVNC, desktop, Guake, Speedify tray dropped.
- Storage: read-only root with overlayfs, a third partition `/data`
  holding all state and secrets from 2.4, bind-mounted into place. The app
  pointed at `/data` via environment variables.
- Build: on the Pi itself, into a second SD card in a USB reader, while
  production keeps running. Stock Lite image written with `dd`, partitions
  adjusted, then `provision/build-card.sh` run inside `systemd-nspawn -D
  /mnt/newroot` (apt repos, packages, units, sudoers allow-list,
  config.txt, watchdog, journal, hosts pin), then `provision/copy-state.sh`
  to pull state from the production tree, then `systemd-nspawn --boot` to
  prove the units start, then one read-write boot on real hardware, then
  flip to read-only, then the bench acceptance checklist with the ATEM.
- Later: A/B root slots via the Pi 5 bootloader's `tryboot` +
  `autoboot.txt`; fit the RTC battery.

Decisions already taken: build on the Pi, not on a Mac or in emulation;
production card untouched until after the tournament; single HDMI output.

Decisions deliberately left open: dedicated service user vs the existing
user; PipeWire vs ALSA; sudoers allow-list vs root helper units for the
network edits; cage vs labwc.

## 4. Constraints

- Must keep: Speedify (no alternative bonding product is in play), the
  two specific Wi-Fi dongles (one needs the out-of-tree driver),
  NetworkManager (the app drives it with `nmcli`), hostapd, nginx-rtmp,
  Companion as shipped, usbmuxd/libimobiledevice, Chromium or a browser
  that renders the same HTML/CSS/JS and plays H.264 mp4 with audio over
  HDMI. The overlay pages are plain HTML and are not going to be rewritten.
- Hardware is fixed: Pi 5, this HAT, these dongles, SD card boot. No NVMe
  today (could be added if it buys reliability; say so if it does).
- One HDMI output to an ATEM, which renegotiates the link occasionally.
  The display must recover without intervention.
- No one on site is a Linux expert during the event. Recovery is
  power-cycle or card swap. Anything that needs a keyboard on the Pi is a
  failure.
- The tournament is ~12 days away. The production card does not change.
  Anything proposed is for the second card and for after the event, so
  scope is not limited by the date, but the first deliverable should be
  reachable in a weekend of work.
- Maintainer skill: comfortable with Linux, systemd, Node, Python, Pi OS;
  not with Yocto/Buildroot, not with kernel work.
- Internet at the venue is bonded cellular; the appliance must not depend
  on reaching anything at boot except NTP eventually.

## 5. Things we suspect but have not verified

- That `cage` works on Pi 5 vc4 with an ATEM as the only output and
  survives HDMI hot-unplug/replug.
- That Chromium on native Wayland (`--ozone-platform=wayland`) is at
  least as stable here as under Xwayland.
- That the UDP 9910 relay and the stale routing script are dead code now
  that `br0` exists.
- That Speedify's state can be relocated to `/data` and that a second
  install activates cleanly under the same account.
- That `systemd-nspawn --boot` on the new root under the production
  kernel is a faithful enough test of unit startup.
- That the hard reset was the watchdog.

## 6. Specific questions for you

1. Is there a better display stack than cage+Chromium for "one web page,
   fullscreen, black otherwise, audio over HDMI, survives output
   renegotiation" on a Pi 5? Options we know of but have not weighed: WPE
   WebKit via `cog` on DRM/KMS with no compositor; Chromium's own
   `--ozone-platform=drm`-style backends if any are viable in Debian's
   build; Weston kiosk-shell; Firefox kiosk. Video playback with audio and
   the Supabase/Socket.IO websockets must work.
2. Is a read-only overlayfs root worth its complexity here versus, say, a
   normal rw root with `fsck` on boot, journald persistent, and
   `/data` for state? What actually breaks on SD after a hard reset in
   practice on Trixie?
3. Is Pi OS Lite + a provisioning script the right packaging, or would
   something like a `pi-gen` custom stage, `sdm`, Debian preseed, or an
   Ansible playbook against the Lite image give better reproducibility for
   a one-person project? Is there a way to make Companion and Speedify
   part of a reproducible build rather than copied state?
4. How should the app's privileged operations be handled: narrow sudoers,
   polkit rules for NetworkManager, root helper units activated over a
   socket, or restructuring so the app does not edit `/etc` at all?
5. Is A/B via `tryboot` the right update mechanism, or is "two labelled
   cards" genuinely good enough for this scale?
6. Anything in section 2 that is a bad idea on its own and should be fixed
   regardless of migration (the hard-coded PipeWire sink id, the IPv4 pin,
   the world-readable stream key, the stale routing script, `NOPASSWD:
   ALL`, the fixed 4 s cover timer, the clock step).
7. What would you do about diagnosing the hard reset beyond a persistent
   journal: pstore/ramoops on Pi 5, a watchdog pretimeout, serial console
   capture, PMIC reset-reason decoding?

## 7. How we will judge a proposal

- Fewer moving parts between power-on and overlay-on-screen than today.
- Time to first overlay frame from power-on, target under 60 s.
- Behaviour on: HDMI replug, server crash, browser crash, power loss
  mid-write, network absent at boot, clock step at boot. Each must recover
  unattended.
- Rebuild from a clean card to a working appliance in one scripted run.
- Everything stateful in one place that can be backed up and restored.
- Maintainable by one person with the skills in section 4.
- No dependency on a desktop session, a login, or a display manager.

## 8. Pointers

- `docs/embedded-migration-plan.md`: the plan, with inventory tables,
  component mapping, build steps and the 13-item acceptance checklist.
- `docs/kiosk-display.md`, `docs/network.md`, `docs/atem.md`, `docs/sync.md`,
  `docs/scorebug-editor.md`: per-feature docs for the app as it is.
- `launch-display.sh`, `black-cover.py`, `scorebored.service`,
  `~/.config/labwc/autostart`: the current display pipeline.
- `lib/network.js`, `lib/rtmp.js`, `lib/speedify.js`, `lib/atem.js`,
  `lib/sync.js`: every system interaction the app makes.
