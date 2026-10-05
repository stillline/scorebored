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

Lets the operator repoint the stream relay at a different ingest URL
without SSHing into the Pi, by reading/writing the `STREAM_URL` inside an
external streaming script (`/usr/local/bin/pi-send-buffer.sh` — **not part
of this repo**, lives on the Pi itself). Saved base-URL + key presets are
client-side only (`network.html`'s `localStorage`) — nothing server-side to
manage there.

See the memory notes on the nginx RTMP relay layout for how this fits into
the broader streaming pipeline (not covered in this repo).
