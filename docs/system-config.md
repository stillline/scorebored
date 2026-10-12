# System configuration in git

The scoreboard rig is a Raspberry Pi 5 ("switcherpi") whose behaviour
depends on far more than this repo: boot config, systemd units,
NetworkManager profiles, crontabs, the kiosk autostart, Speedify
priorities. Two git repos track that, with different jobs.

## 1. `provision/` in this repo: the allowlisted snapshot

`provision/sync-from-system.sh` copies a fixed list of system files into
`provision/system/` so that `git diff` shows what changed on the Pi and a
revert is a copy back. It covers what is *outside* `/etc` or easy to
forget:

| Copied into `provision/system/` | From |
|---|---|
| `boot/config.txt`, `boot/cmdline.txt` | `/boot/firmware/` (ramoops crash capture, HDMI, audio) |
| `systemd/*.service`, `journald.conf.d/` | units we own, journald persistence drop-in |
| `NetworkManager/*.nmconnection` | uplink and bridge profiles only (no Wi-Fi client PSKs) |
| `cron/root.crontab`, `cron/matthew.crontab`, `rc.local`, `hosts` | boot-time scripts, the YouTube IPv4 pin |
| `labwc/autostart`, `autostart/scoreboard-kiosk.desktop` | the kiosk launch path |
| `speedify-adapters.txt` | adapter priorities as Speedify reports them |
| `systemd/enabled-units.txt` | which units are enabled |

Workflow after changing anything on the system:

```bash
./provision/sync-from-system.sh
git diff provision/          # review what changed on the Pi
git add provision && git commit -m "describe the system change"
```

To put a file back, copy it from `provision/system/` to its real path
(with `sudo` where needed), then `nmcli con reload`, `systemctl
daemon-reload`, or a reboot as appropriate.

Secrets are excluded by construction: Wi-Fi client profiles,
`/etc/hostapd/hostapd.conf` (AP passphrase) and `/etc/nginx/rtmp-push.conf`
(YouTube stream key, root-only) are never copied. This repo is public; keep it that
way.

## 2. etckeeper: all of `/etc`, automatically

`etckeeper` keeps `/etc` itself in a git repo at `/etc/.git` (root only,
mode 700). It commits on its own before and after every `apt` run, so a
package upgrade that rewrites a config file is attributed to that upgrade,
and once a day via cron if anything is uncommitted. It also records file
modes and ownership, which plain git does not.

```bash
sudo etckeeper commit "what you changed and why"   # after a manual edit
sudo git -C /etc log --oneline | head               # history
sudo git -C /etc diff                                # uncommitted changes
sudo git -C /etc show HEAD~1:nginx/nginx.conf        # a file as it was
```

`/etc` contains every secret the rig has. **Never push `/etc/.git`
anywhere.** It is a local undo history, not a shared repo.

## What is tracked where

| Thing | Tracked by |
|---|---|
| Application code, pages, docs | this repo |
| Operator data (`gamestate.json`, overlays, presets, logos, provider configs) | not tracked; runtime files, gitignored |
| `/etc` (units, NM, hostapd, nginx, sudoers, journald, ...) | etckeeper, locally |
| `/boot/firmware`, crontabs, home-dir autostart, Speedify priorities | `provision/` snapshot |
| Companion config (`~/.config/companion-nodejs`), Speedify state, iPhone pairings | not tracked; back up by copying |

The `provision/` directory is also the input for the second-card build
described in [embedded-migration-plan.md](embedded-migration-plan.md).
