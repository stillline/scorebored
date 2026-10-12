# Embedded Migration Plan: switcherpi on a swap-in SD card

Status: planning, 2026-10-11. Nothing of the second card has been built yet.

Already done on the production card since this was written (2026-10-12):
`provision/` snapshot + `provision/sync-from-system.sh` and etckeeper for
`/etc` (see [system-config.md](system-config.md)); ramoops crash capture;
persistent journal; panel and desktop removed from the labwc autostart;
the stale `@reboot` routing cron removed; `atem-discovery-relay.service`
disabled (bridge carries ATEM discovery; verified); uplinks completed with
a USB Ethernet adapter for venue Ethernet and a profile for the T-Mobile
hotspot (see [network.md](network.md#uplink-topology-and-bonding)). Items
below that describe those as open are now closed.

Goal: a second SD card that boots the same Pi 5 into a purpose-built,
desktop-free system running everything scorebored needs, so the migration
can be tested by swapping cards and reverted by swapping back. The current
card stays untouched and remains the production fallback through the
tournament (roughly 12 days out at time of writing).

## 1. What the system does today

Everything below was inventoried from the running Pi, not from docs.

### 1.1 Hardware

| Item | Detail |
|---|---|
| Board | Raspberry Pi 5 Model B rev 1.1, 8 GB, kernel 6.12 (rpt), Debian 13 Trixie 64-bit desktop image |
| Storage | 64 GB SD, 21 GB used (4.4 GB is the repo, 4.3 GB of that is `public/videos`; Companion is 0.7 GB) |
| Display | One HDMI only, ever: HDMI-A-2 to the ATEM Mini Pro ISO (EDID "BMD HDMI"). HDMI-A-1 is never used |
| Audio | HDMI audio to the ATEM via PipeWire (sink id is hard-coded as `56` in server.js) |
| PCIe | Dual RTL8125 2.5 GbE HAT (`enP1p3s0` unused, `enP1p4s0` = Netgear hotspot uplink) |
| Onboard | `end0` Ethernet (bridged, ATEM side), `wlan0` (client to venue Wi-Fi) |
| USB Wi-Fi | Two Realtek 8812AU/8821AU dongles. One runs the access point (`wlx00c0cab7e676`), one is dormant. One uses the out-of-tree `8821au` DKMS module, one the in-tree `rtw88_8821cu` |
| USB HID | Apple wireless receiver and a "LiQi" composite device, read by the Companion keyboard controller via evdev |
| USB | iPhones for Speedify cellular bonding (usbmuxd / libimobiledevice) |
| RTC | Present but no battery: every boot starts at 1970, then jumps to the last saved timestamp, then steps about five minutes forward when NTP answers |
| Watchdog | BCM2835 hardware watchdog armed by systemd, 1 minute |

### 1.2 Network topology

- `br0` = `end0` + the hostapd dongle. NetworkManager "shared" mode, `10.42.0.1/24`, NM's dnsmasq does DHCP/DNS. The ATEM lives at `10.42.0.100`. hostapd SSID `switcher_net`, 5 GHz channel 36, 80 MHz.
- Uplinks: `wlan0` to venue Wi-Fi, `enP1p4s0` to a Netgear hotspot, iPhones over USB. Speedify bonds them into `connectify0`.
- `/etc/hosts` pins `a.rtmp.youtube.com` to an IPv4 address because the Pi's IPv6 is broken and nginx-rtmp does not fall back.
- `setup-network-routing.sh` runs from cron `@reboot` and adds iptables FORWARD rules for a USB NIC `enx8cae4ccdd68d` that no longer exists. Stale.
- `atem-discovery-relay.service` relays UDP 9910 broadcasts between `wlan0` and `end0` so Wi-Fi clients can find the ATEM. It predates `br0` and may be redundant now; verify before carrying it over.

### 1.3 Services and ports

| Service | What it is | Runs as | Listens | Verdict |
|---|---|---|---|---|
| `scorebored.service` | Node 22 server: Express + Socket.IO, port 3000 | matthew | tcp 3000 | keep |
| sync subprocesses | Challonge (python3, polled https), Podium (python3 stdlib, wss push), Shufflepolo (node, Supabase realtime wss) | child of scorebored | outbound 443 | keep |
| `companion.service` | Bitfocus Companion, headless, ships its own node runtime in `/opt/companion` | matthew | tcp 8000 | keep (copy `/opt/companion` + its config dir) |
| `companion-keyboard-controller.service` | python3 + evdev + requests: USB keypad to Companion HTTP API | root | none | keep |
| `atem-discovery-relay.service` | python3 UDP 9910 relay | root | udp 9910 | verify, probably drop |
| `nginx.service` + `libnginx-mod-rtmp` | RTMP relay: ATEM publishes to `rtmp://pi/live`, nginx pushes to YouTube. `/stat` on port 80 | www-data | tcp 1935, 80 | keep |
| `speedify.service`, `speedify-sharing.service` | Speedify bonding daemon (proprietary, apt repo). scorebored shells out to `speedify_cli` | root | tun | keep |
| `hostapd.service` | Access point | root | wifi | keep |
| `NetworkManager.service` | All interfaces, bridge, shared mode, Wi-Fi client. `lib/network.js` drives it with `nmcli` | root | dhcp/dns 67/53 on br0 | keep |
| `usbmuxd` + `libimobiledevice-utils` | iPhone pairing (`idevicepair`, `ideviceinfo`) | root | usb | keep |
| `iperf3.service` | Bandwidth testing | iperf3 | tcp 5201 | keep (cheap) |
| `vncserver-x11-serviced` | RealVNC server (proprietary, desktop only) | root | tcp 5900 | drop; no desktop to view |
| `lightdm` + labwc + Xwayland + wf-panel + pcmanfm | Desktop session hosting the Chromium kiosk | matthew | - | replace with cage |
| `ssh` | Admin | root | tcp 22 | keep |
| cron `@reboot` routing script, `iw wlan0 set power_save off` | Boot fixups | root | - | fold into systemd units |
| `cloud-init` | Installed on this image | - | - | use for first-boot provisioning of the new card |

External endpoints: Challonge API (https), Podium (https/wss), Supabase (wss 443), YouTube RTMP ingest (1935 out), Speedify servers, NTP, GitHub (deploy).

### 1.4 scorebored runtime dependencies

- Node 22 (`/usr/bin/node`, Debian package or NodeSource). npm deps: express, socket.io, multer, sharp (native, bundles prebuilt libvips for linux-arm64 glibc), atem-connection (UDP 9910 to the ATEM), @supabase/supabase-js.
- Python 3.13: stdlib only for Podium and Challonge; `python3-evdev` and `python3-requests` for the keyboard controller.
- Shell-outs from the server (all must exist on the new image): `speedify_cli`, `nmcli`, `iwlist` (wireless-tools), `idevicepair`, `idevice_id`, `ideviceinfo`, `wpctl`, `systemctl restart hostapd`, `sed` on `/etc/hostapd/hostapd.conf`, `tee` of a send-buffer script, `hostapd.conf` reads.
- Privileged operations via passwordless `sudo`: nmcli connect/modify, hostapd config edit and restart, writing a script with `tee`. These need an explicit allow-list on the new card (sudoers or polkit for NM).
- Browser: Chromium with the flag set in `launch-display.sh` (kiosk, no sandbox, mock keychain, autoplay). Plays H.264 mp4 from `public/videos`; Pi 5 decodes in software and copes at 1080p.

### 1.5 Persistent state (must survive a read-only root and reboots)

Repo working tree: `gamestate.json`, `bracket.json`, `overlays/`, `presets/`, `public/logos`, `public/videos`, `*-config.json` (API keys), `challonge/state`, `podium_sync/state`, `shufflepolo_sync/state`, `iphone-names.json`.

System: NetworkManager connection profiles (Wi-Fi passwords), `/etc/hostapd/hostapd.conf` (edited live by the app), `/etc/hosts` pin, nginx config (contains the YouTube stream key; treat as a secret, never bake into a shared image), Speedify state and license (`/var/lib/speedify` or wherever 16.x keeps it, confirm), usbmuxd pairing records (`/var/lib/lockdown`), Companion config (`~/.config/companion` or `/opt/companion` data dir, confirm), journald, Chromium profile (`/tmp/chromium-atem-display`, deliberately disposable).

## 2. Target architecture

### 2.1 Base OS decision

Options:

1. Raspberry Pi OS Lite, Trixie, 64-bit (recommended for the swap-in card). Same kernel, firmware, DKMS, NetworkManager, hostapd and Speedify apt packaging as today. Everything proprietary or out-of-tree (Speedify, the 8821au driver, Companion's bundled runtime) is known to work on it. No desktop packages at all.
2. Buildroot or Yocto image. True embedded, but Speedify has no source and no non-Debian packaging, the Wi-Fi DKMS driver would need a recipe, and the result is a multi-week project with no one on hand to maintain it. Not for this tournament. Revisit only if option 1 proves insufficient.

Decision for this plan: option 1, built so it behaves like an appliance: no login session, every component a systemd unit, read-only root, persistent data partition, hardware watchdog, persistent journal.

### 2.2 Display stack

Replace lightdm + labwc + Xwayland + panel + desktop + cover window with:

- `cage` (Wayland kiosk compositor, Debian package) running Chromium natively on Wayland (`--ozone-platform=wayland`). cage shows exactly one app fullscreen and nothing else, so the black cover, `unclutter`, `xset`, `xsetroot` and the panel-killing autostart all disappear.
- Run as a user systemd service `scoreboard-display.service` on `seat0` with `TTYPath`, `PAMName=login`, started once `scorebored.service` reports healthy. `Restart=always`. Chromium exit = service restart, which replaces the `exec "$0"` loop in `launch-display.sh`.
- Fallback if cage misbehaves on the Pi 5 vc4 stack: labwc started by the same unit with an `rc.xml` that has no panel and a single fullscreen rule. Decide during card build, not before.
- Audio: keep PipeWire as user services (`pipewire`, `wireplumber`, `pipewire-pulse`) under the same user session; Chromium talks to them without a desktop. Replace the hard-coded `wpctl set-volume 56` with a lookup by sink name. Alternative with fewer moving parts: Chromium straight to ALSA with `--alsa-output-device=hw:0,0` and no PipeWire at all; test both, keep the one that survives HDMI renegotiation with the ATEM.

### 2.3 Service layout

All units in a `provision/systemd/` directory in the repo, installed by the build script.

| Unit | Notes |
|---|---|
| `scorebored.service` | As today plus `Restart=always`, `WatchdogSec=30` with `sd_notify` pings from server.js (small `systemd-notify` shell-out or the `sd-notify` npm package), `ExecStartPre` that waits for `br0` and PipeWire. Runs as `scoreboard` (or keep `matthew`; decide). |
| `scoreboard-display.service` | cage + Chromium, `After=scorebored.service`, `BindsTo` so it restarts if the server restarts. |
| `companion.service` | Unchanged, path fixed. |
| `companion-keyboard-controller.service` | Unchanged. |
| `rtmp-relay` | nginx as today. |
| `switcher-net-fixups.service` | Replaces cron and rc.local: `iw wlan0 set power_save off`, any iptables rules still needed after confirming the interface list. |
| `atem-discovery-relay.service` | Only if testing shows Wi-Fi clients cannot discover the ATEM through `br0`. |
| `systemd-timesyncd`, `systemd-journald` persistent, hardware watchdog | As on the current card after today's changes. |

### 2.4 Storage layout and read-only root

- Partition 1 `boot` (FAT), partition 2 `root` (ext4, mounted read-only, overlayfs on tmpfs on top via `raspi-config nonint do_overlayfs` or an explicit `initramfs` overlay), partition 3 `data` (ext4, read-write, `/data`).
- Bind-mount or symlink everything from section 1.5 into `/data`: `/data/scorebored-state` for the app's JSON and overlays, `/data/videos` for the mp4s, `/data/etc/NetworkManager/system-connections`, `/data/etc/hostapd`, `/data/var/lib/speedify`, `/data/var/lib/lockdown`, `/data/var/log/journal`, `/data/companion`.
- The app must not write anywhere outside `/data` and `/tmp`. Audit: `server.js` writes JSON next to itself, and `lib/rtmp.js` and `lib/network.js` write to `/etc`. Point them at `/data` paths via environment variables in the unit rather than editing call sites one by one.
- Secrets (stream key, API keys, Wi-Fi passwords, Speedify login) live only on `/data`, never in the image or the repo.

### 2.5 Updates and recovery

- Phase 1: `provision/build-card.sh`, run on the Pi against a second card in a USB reader (section 4). Re-running it on a fresh card is the "update".
- Phase 3 (after the tournament): A/B root partitions using the Pi 5 bootloader's `tryboot` with `autoboot.txt` (`tryboot_a_b=1`, `boot_partition` switch). New image goes to the inactive slot, one `reboot "0 tryboot"`, confirm on health check, else it falls back by itself.
- Fit the RTC battery so the clock is right from power-on. Keep `fake-hwclock` off.

## 3. Component mapping

| Today | New card |
|---|---|
| Desktop image, lightdm autologin, labwc, panel, pcmanfm | Pi OS Lite, no DM, `cage` user service |
| `launch-display.sh` + `black-cover.py` + `delayed-kiosk-start.desktop` | `scoreboard-display.service` |
| `~/.config/labwc/autostart` panel killing | gone |
| `scorebored.service` in repo, `Restart=on-failure` | same unit, `Restart=always`, watchdog, env for data paths |
| cron `@reboot` routing script, rc.local | `switcher-net-fixups.service` |
| RealVNC | removed; use ssh, and `wayvnc` only if a remote eye on the feed is wanted |
| Guake, Speedify UI, terminator, desktop autostarts | removed |
| `/tmp/chromium-atem-display` profile | same, tmpfs |
| volatile journal | persistent, capped, on `/data` |
| NM profiles, hostapd.conf in `/etc` | on `/data`, bind-mounted |
| Speedify via apt | same apt repo, licence re-activated on the new install |
| `8821au` DKMS | same package; rebuild on first boot needs `linux-headers-rpi-2712` baked in |

## 4. Build procedure for the test card

Decision: the card is built here on the Pi 5, into a second SD card in a
USB reader, while the production card keeps running. No Mac, no VM, no
emulation. Same architecture, same kernel headers, same apt repos
(including Speedify's), and the DKMS Wi-Fi driver builds for the target
kernel inside the chroot. The new root is exercised as a container with
`systemd-nspawn --boot` before any card swap, so the first physical swap is
a hardware test, not a packaging test.

Tooling: `systemd-container` (provides `systemd-nspawn`), `xz-utils`, a
USB SD reader. All of it already on Pi OS or one apt install away.

1. On the Pi: download the stock Pi OS Lite Trixie 64-bit image, verify its
   checksum, and write it to the second card in the USB reader with `dd`.
   Do not use the imager's cloud-init customisation; everything is applied
   in the next steps so it is reproducible from the repo.
2. Grow the root partition on the new card, add partition 3 as `/data`
   (ext4). Mount root at `/mnt/newroot`, boot at `/mnt/newroot/boot/firmware`,
   data at `/mnt/newroot/data`.
3. Run `provision/build-card.sh /mnt/newroot` (to be written) which, inside
   `systemd-nspawn -D /mnt/newroot`, in order: enables the apt repos
   (Speedify), installs packages (`nodejs` 22, `python3-evdev`,
   `python3-requests`, `cage`, `chromium`, `pipewire`, `wireplumber`,
   `nginx` + `libnginx-mod-rtmp`, `hostapd`, `network-manager`, `usbmuxd`,
   `libimobiledevice-utils`, `wireless-tools`, `iperf3`, `dkms`,
   `linux-headers-rpi-2712`, the Realtek DKMS package, `speedify`), creates
   the service user, installs the units from `provision/systemd/`, installs
   the sudoers allow-list, writes `config.txt`, enables the hardware watchdog
   and persistent journal, installs the `/etc/hosts` pin, sets hostname
   `switcherpi-embedded` and the ssh key. Idempotent: re-running on the same
   card must be safe.
4. Copy data from the production card over the local filesystem, not by
   hand, as a second script `provision/copy-state.sh`: repo checkout at the
   same commit, `node_modules` via `npm ci` inside the container, videos and
   logos, state JSON, NM connection files, hostapd.conf, nginx config with
   the stream key moved to a root-only include, Companion `/opt/companion`
   and its config, lockdown pairing records, Speedify login.
5. Container test: `systemd-nspawn --boot -D /mnt/newroot`. Confirm every
   unit reaches `active`, scorebored answers on its port inside the
   container, nginx loads the rtmp module, DKMS reports the module built for
   the target kernel. Display, audio, Wi-Fi and Speedify cannot be tested
   here; everything else can. Fix and re-run step 3 until clean.
6. Switch root to read-only overlay last, after step 5 passes and after one
   real boot in read-write mode (step 7).
7. Unmount, shut the Pi down, swap cards, run the acceptance checklist in
   section 5 with the ATEM connected.
8. Swap the production card back, label the new card, keep both in the kit.

Cautions: `dd` and partition edits target the USB reader's device, never
`/dev/mmcblk0`. The build script refuses to run unless the target is a
removable device and is not the running root. `systemd-nspawn` shares the
host kernel, so `uname -r` inside the container reports the production
kernel; DKMS and anything that keys on the running kernel version must be
pointed at the target kernel's version from `/mnt/newroot/lib/modules`.

## 5. Acceptance checklist

Run with the ATEM, the Netgear hotspot, one iPhone and one phone client on `switcher_net`.

- Boot to overlay in under 60 s from power-on with nothing on screen but black then the overlay. No desktop, no panel, no cursor, at any point.
- Pull HDMI from the ATEM and reconnect: overlay returns, audio returns.
- `/control`, `/bracket`, `/network`, `/overlay-editor` reachable from a phone on `switcher_net` and from venue Wi-Fi.
- ATEM connect, cut to graphics, DSK fade, commercial break with video and audio heard on the ATEM.
- Each sync provider: enable, see bracket update, disable.
- RTMP: ATEM publishes, nginx pushes to a test YouTube event, `/stat` shows both legs.
- Speedify: bonded over Wi-Fi + hotspot + iPhone, stats visible on `/network`. Pair a new iPhone from `/network`.
- Change AP channel from `/apchannel`: hostapd restarts and clients rejoin.
- Companion web UI on 8000, keypad presses reach it.
- Kill `node` by hand: server restarts within 5 s, display reconnects without a reboot. Kill Chromium: display service restarts it.
- Pull power mid-run, power back: boots clean, state JSON intact, `journalctl -b -1` shows the previous boot.
- Swap the old card back in: production unchanged.

## 6. Risks and open questions

- The hard reset of 2026-10-11 is still unexplained. The persistent journal now on the production card is the only instrument; the new card inherits it. If it is the 1 minute watchdog, the new card's lighter load helps but does not prove anything.
- `cage` on Pi 5 vc4 with the ATEM as the only output is untested here. The labwc fallback in 2.2 is the hedge.
- Speedify licence activation on a second install, and whether its state directory can be relocated to `/data`.
- Companion's data directory and version pinning: export its config from the current install before building.
- Chromium under Wayland, `--no-sandbox` and `--disable-gpu-sandbox`: re-test the flag list; some X11-era flags do nothing on Wayland.
- `lib/network.js` and `lib/rtmp.js` assume root-writable `/etc` and passwordless sudo. Either keep a tight sudoers allow-list or move these edits behind small root helper units. Decide during the build.
- Two Realtek dongles with two different drivers. Pin by MAC in the NM and hostapd config so the AP does not land on the wrong dongle after a re-enumeration.
- The `enx8cae4ccdd68d` routing rules and the UDP 9910 relay are probably dead code from before `br0`. Confirm with a phone on `switcher_net` that the ATEM is discoverable without them.
- Pi 5 RTC battery is not fitted. Cheap, fixes the clock jump at boot, do it regardless of migration.
- The YouTube stream key is in a world-readable nginx config on the current card. Move it to a root-only include on both cards.

## 7. Phasing

1. Before the tournament: nothing on the production card beyond today's journald and autostart changes. Write `provision/build-card.sh` and the units in the repo; build the card; run the checklist on a bench with the ATEM. Only if every item passes does the new card go in the kit as the spare, not as primary.
2. After the tournament: make the new card primary, keep the old one as the fallback for one event.
3. Later: A/B `tryboot` updates, RTC battery, drop labwc fallback once cage is proven, consider Buildroot only if there is a concrete reason.
