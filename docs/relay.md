# Pi relay: MediaMTX, the court relays and stream profiles

`/relay` and `/profiles` (`lib/relay.js`), the Pi-side half of the chain

    ATEM ──RTMP over switcher_net──▶ Pi (MediaMTX) ──SRT──▶ Court A or Court B relay ──▶ YouTube …
                                                  └──RTMPS──▶ a profile (YouTube, Twitch, …) directly

Built 2026-10-17 against the owner's Pi-side contract v2 (two court relays,
`courta.onlygoals.tv` and `courtb.onlygoals.tv`). The pages copy the cloud
relay dashboard's design (relay.onlygoals.tv): server-rendered HTML, forms
that POST and redirect back, a refresh every 5 s that never fires while an
input or select has focus or a request is in flight.

## Why the Pi is in the path at all

The ATEM Mini has a quirk: when its streaming output buffer fills, streaming
sticks ON and only a power cycle clears it. So the ATEM must only ever see a
perfect link. It publishes RTMP to the Pi over the LAN and never to anything
remote. The Pi absorbs every uplink or relay problem; the ATEM must never be
back-pressured or refused. That is the one hard rule every change here keeps.

## MediaMTX on the Pi

- `/usr/local/bin/mediamtx` (v1.21.2, linux_arm64, checksum verified),
  `mediamtx.service`, running as the system user `mediamtx` with a hardened
  unit (`ProtectSystem=strict`, `/etc/srt-relay` read-only).
- `/etc/mediamtx/mediamtx.yml` is **generated** by `/usr/local/bin/relay-target`
  from `/etc/mediamtx/mediamtx.yml.tmpl`. It holds the forward URL with its
  secrets, so it is root:mediamtx 640. Edit the template, never the file.
- RTMP ingest for the ATEM; RTSP, HLS, WebRTC, SRT server and MoQ are off;
  Control API on `127.0.0.1:9997`. Publish is allowed from `10.42.0.0/24`
  (switcher_net) and localhost; reads and the API from localhost only.
- The path is the regex `~^live(/.*)?$`, so the ATEM's custom URL stays
  `rtmp://10.42.0.1/live` with any key, on port 1935 since the cutover on
  2026-10-17 (nginx-rtmp is stopped and disabled, kept installed for
  rollback). The port comes from the template and the pages show it.
- `logLevel: warn`. At `info`, MediaMTX logs the full forward URL, passphrase
  and publish password included, on every (re)connect. Its error lines
  ("EOF", "connection timeout. server didn't respond") carry no secrets;
  verified 2026-10-17. Operational state comes from the API, not the log.

## The forward (no ffmpeg)

MediaMTX forwards the stream itself with a per-path `forward` entry:

- **Court A / Court B:** `srt://<court>.onlygoals.tv:8890?streamid=publish:<court>:<court>:<pass>&passphrase=<pp>&latency=4000`
  (gosrt; `latency` is in milliseconds, unlike ffmpeg's microseconds). Payload
  comes out at 1316 bytes from the default UDP payload size. Secrets come from
  `/etc/srt-relay/relays.env` (owner mediamtx, mode 600), copied from the
  owner's Mac; they change only if the owner rotates them on the relay.
- **A profile:** `rtmps://host:443/app#streamKey`. MediaMTX puts the URL
  fragment into the RTMP stream key and keeps any query in the app, so
  YouTube's backup ingest (`live2?backup=1`) works too. Built-in ingest URLs
  for YouTube, YouTube (backup), Twitch and Facebook; Custom takes an
  `rtmp(s)://` URL, with `{key}` to place the key elsewhere than the end.
- **Retry forever:** on any error MediaMTX logs it, waits 5 s and reconnects.
- **Switching is a hot reload.** `forward` is one of the path fields MediaMTX
  can change without recreating the path, so the ATEM's publish connection
  is untouched; the new destination is up within the same second. Verified
  with the publisher's connection ID unchanged across Court A → B → A → Off.
- One destination at a time. A court relay replaces whoever is publishing to
  it (a phone, say), so the page says so next to the picker.
- Slow or dead destinations discard frames (`outboundFramesDiscarded`) rather
  than slowing the publisher. Verified: 20 s outbound UDP block, the publisher
  kept flowing at full rate, the forward errored and was back 4 s after the
  block lifted.

Direct profiles bypass the cloud relay, so no be-right-back card, no overlay,
no goal clips. Useful as a fallback when the relay itself is the problem.

## `relay-target` (root, via sudo)

    relay-target courta | courtb | off | status
    relay-target profile <id> <label>     # destination URL on stdin

Regenerates `mediamtx.yml` (validated with `mediamtx --validate-conf` before
it replaces the old file atomically), records the choice in
`/etc/srt-relay/target` (`courta`, `courtb`, `off` or `profile:<id>`; not
secret, mode 644) and lets MediaMTX's file watcher apply it. A profile's URL
arrives on stdin so the key is never on a command line; `ps` shows nothing.

## Pages

- **/relay.** PI RELAY (service up, MediaMTX version, the ATEM's URL; badge
  RELAYING / ARMED / RETRYING / OFF / DOWN), INCOMING FEED (ATEM) (tracks,
  connected time, bitrate from byte deltas between refreshes, source address),
  SENDING TO (the current destination with `pushing` / `retrying` / `armed`,
  Reset Connection, Remove; SRT stats from the API: bitrate, link capacity,
  RTT, negotiated latency, lost, resent, dropped, discarded frames; for a
  court, whether the cloud relay answers; the picker of every other
  destination and **Send to it**). The cards are green for Court A, blue for
  Court B, grey otherwise, like the cloud page.
- **/profiles.** List (name, destination, key as `••••last4`, in use or
  not), delete (blocked while in use), edit (blank key keeps the old one;
  editing the profile in use re-applies it live), new profile.
- Every form, input and select carries the anti-autofill attributes so
  password managers stay out of the key fields. Keys are never sent back to
  the browser. The pages contain no URL with a secret in it.

Profiles are stored in `relay-profiles.json` in the repo root (gitignored,
mode 600, next to `gamestate.json`). The server process holds a key in memory
only while handing the URL to `relay-target`.

## Reachability of a court relay

`HEAD https://<court>.onlygoals.tv/` → 401 (its login page) means up; a
timeout or connection error means stopped (the owner starts it from the
cloud dashboard; relays are off between tournaments) or no venue internet.
Checked at most every 15 s. "Stopped" next to a court in the picker is a
hint, not a block: MediaMTX keeps retrying and connects when it appears.

## Checks

- `curl -s 127.0.0.1:9997/v3/paths/list` — is the ATEM's path `ready`?
- `curl -s '127.0.0.1:9997/v3/paths/forward-dests/list?path=live/<key>'` —
  `state` idle/forwarding/error, `lastError`, full SRT statistics.
- `journalctl -u mediamtx -f` — only warnings and errors.
- `sudo relay-target status` — the chosen destination.
- Test pattern into the Pi:
  `ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=f=440 -c:v libx264 -preset veryfast -b:v 4M -g 60 -pix_fmt yuv420p -c:a aac -f flv rtmp://127.0.0.1:<port>/live/test`
- Dropout: `sudo iptables -I OUTPUT -p udp --dport 8890 -j DROP`, ~20 s,
  then `-D`. The publisher keeps flowing; the forward recovers alone.

## Acceptance (owner watching the cloud dashboard), 2026-10-17

Passed with the test pattern: Court A ONLINE and YouTube "Excellent"; switch
to Court B and back (same second, publisher untouched); Off; 20 s UDP block.
Direct-to-YouTube: TLS and DNS fine (the resolver returns no IPv6 for
YouTube, so the broken-IPv6 pin nginx needed does not arise), a made-up key
is refused with "EOF" as expected; a real key still to be tried. Still to
run: relay stopped and restarted by the owner, Pi reboot, the real ATEM,
then the cutover to port 1935 and retiring nginx-rtmp.

## Dead ends worth remembering

- MediaMTX's documented hook pattern (`runOnOnline` running
  `ffmpeg -i rtsp://localhost:8554/$MTX_PATH -c copy -f mpegts srt://…`)
  did not work here: over RTSP ffmpeg received audio packets but muxed
  none and held the video for its 10 s interleave window, the SRT link sat
  idle, and the relay closed it after ~17 s, every time. Pulling over RTMP
  instead worked, but native forwarding made the whole hook unnecessary.
- nginx-rtmp's `exec_push` version (`docs/network.md`, "SRT relay to the
  cloud") needed `worker_processes 1` because each worker keeps its own
  streams; MediaMTX has no such issue.

## Rollback

`sudo relay-target off` stops everything outbound and leaves the ATEM's
ingest alone. Full rollback to the nginx chain:
`sudo systemctl disable --now mediamtx && sudo systemctl enable --now nginx`
(its push still targets the old, dead relay endpoint, so only the direct
YouTube push in `/etc/nginx/rtmp-push.conf` is of any use there).
