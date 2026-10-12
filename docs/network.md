# Network Dashboard

`/network` is the on-site networking control panel for connectivity that
doesn't belong on the scoreboard itself: the Pi's own Wi-Fi access point,
Speedify bonding stats, the RTMP relay destination, and pairing iPhones used
as bonded cellular uplinks.

## Access point channel (`lib/network.js`)

- Reads/sets the 5GHz channel of the Pi's own `hostapd` access point.
- Can scan for a clear channel before an event.
- Valid channels are the standard 5GHz set (36–165); see
  `VALID_5GHZ_CHANNELS` in `lib/network.js`.
- Also surfaced standalone at `/apchannel` for a focused one-purpose view.

## Wi-Fi client scan/connect

NetworkManager-based scan and connect, for joining the Pi to venue Wi-Fi
(separate from the Pi's own AP, which is a different radio/mode) and
reconnecting to the last-used network.

## iPhone tethering pairing

iPhones bonded over USB auto-join Speedify once trusted; the dashboard only
covers the one manual step of trusting a brand-new phone the first time
it's plugged in on site. Device names shown in the UI come from
`iphone-names.json` (UDID → friendly name), which is edited by hand, not
through the UI.

## Speedify bonding stats (`lib/speedify.js`)

A persistent `speedify_cli -s stats` subprocess streams live per-adapter
bandwidth/quality as JSON lines, broadcast to every connected
display/dashboard over Socket.IO. The network dashboard also makes a
handful of one-shot `speedify_cli` queries on demand. Restarts automatically
if the subprocess exits or errors.

## RTMP destination editor (`lib/rtmp.js`)

The live relay is nginx-rtmp: the ATEM publishes to `rtmp://10.42.0.1/live`
and nginx pushes that stream to one fixed destination. The destination line
lives in `/etc/nginx/rtmp-push.conf` (root-only, mode 600, included from
the `application live` block in `nginx.conf`) so the YouTube stream key is
not in a world-readable file.

The network page reads and changes that line. Saving a new destination
writes the file, runs `nginx -t` (rolling back if nginx rejects it) and
**restarts** nginx, because a reload only applies to new sessions and the
point is to switch the session that is on air. The ATEM reconnects by
itself a few seconds later; expect a short gap on the stream. Presets
(saved base URL + key combos, e.g. one per channel) are client-side in
`network.html`'s `localStorage`.

Keep the base URL as `rtmp://a.rtmp.youtube.com/live2`: that host is
pinned to IPv4 in `/etc/hosts` because the Pi's IPv6 is broken and
nginx-rtmp does not fall back; another ingest host would need its own pin.

A wrong or stale key produces no error anywhere: nginx pushes happily and
YouTube shows nothing. Keys are per channel and can be per event, so when
a channel shows no stream, check the key first. A static program such as
the scoreboard overlay alone encodes at about 300 kbit/s, which is normal.

Historical note: until 2026-10-12 this editor changed `STREAM_URL` in
`/usr/local/bin/pi-send-buffer.sh`, a record-and-forward sender that has
been dormant since April (its service is disabled and nginx has no
`record` directive). That script still exists but is not used by the
relay.

## Uplink topology and bonding

The Pi is the router for the whole stream network. Everything the operators
and the ATEM use lives on `switcher_net`; every internet path is a separate
interface on the Pi that Speedify bonds. Settled 2026-10-12.

```
   uplinks:   LM1200 (Verizon)   T-Mobile hotspot   USB Ethernet (venue jack)   phones (USB)   venue Wi-Fi (wlan0)
                   |                   |                    |                      |                |
                   +------------- Pi 5: Speedify bonds all of these; tunnel is the default route ---+
                                          |  br0 = end0 + AP dongle, 10.42.0.1/24, NM "shared" (DHCP/DNS)
                                 ATEM 10.42.0.100, operator phones and laptops (switcher_net)
```

| Pi port | Device | NM profile | Speedify |
|---|---|---|---|
| `end0` (onboard jack) | ATEM, switcher_net | `bridge-slave-end0` into `switcher-bridge` | never (downstream) |
| `enP1p4s0` (PCIe HAT port 2) | Netgear LM1200, Verizon SIM, its LAN port | `netgear_hotspot` | always |
| `enP1p3s0` (PCIe HAT port 1) | T-Mobile hotspot (LAN 192.168.2.0/24) | `tmobile_hotspot` | always |
| `enx8cae4ccdd53b` (ASIX USB adapter, USB 3 port) | venue Ethernet wall jack | `venue_ethernet` | always |
| `wlan0` (onboard radio) | venue Wi-Fi, home Wi-Fi | per-SSID profiles | secondary |
| USB (powered hub) | tether phones | none needed; appears as Ethernet | set "always" on first use |
| `wlx00c0cab7e676` (USB dongle) | the switcher_net AP itself | hostapd, bridged | never |

Rules that keep this working:

- A switch cannot be used on the uplink side. Speedify bonds interfaces;
  a switch merges several routers onto one interface and only one DHCP
  offer wins. One uplink, one Pi port.
- The HAT ports get a random MAC every boot, so profiles bind by interface
  name, not hardware address.
- Hotspots are powered off unless testing or streaming. That is the only
  reliable guard against burning cellular data at home; no modem setting
  needs toggling.
- Each uplink's LAN subnet must differ from the others and from
  `10.42.0.0/24`. Venue Ethernet is the one to check on the day.

### LM1200 (Verizon) settings

Router mode (not Bridge: bridge mode passes the LTE address straight to
the Pi and bounces the Ethernet link on every LTE session change), LAN
`192.168.5.1/24`, Failover "Mobile Broadband only", WAN port empty. The
modem's admin UI is reachable only from the Pi (`http://192.168.5.1`); from
a Mac use a SOCKS tunnel: `ssh -N -D 1080 matthew@10.42.0.1` and a browser
started with `--proxy-server=socks5://127.0.0.1:1080`. The failover page is
under Settings, Router, Failover. The SIM was verified on Verizon LTE on
2026-10-11; throughput depends entirely on signal at the venue.

### switcher_net and the ATEM

The AP dongle and `end0` are two legs of the same bridge, so Wi-Fi clients
are on the ATEM's own subnet. ATEM Software Control on a laptop or phone on
`switcher_net` discovers the ATEM by itself (verified 2026-10-12); no
manual IP needed. The old `atem-discovery-relay.service`, which relayed
UDP 9910 between interfaces before the bridge existed, is disabled for that
reason; unit and script remain on disk.
