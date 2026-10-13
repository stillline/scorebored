# TODO: SRT relay through AWS (not started, to be discussed first)

Status: the cloud relay was built separately by the owner (MediaMTX on AWS,
`srt://54.190.49.121:8890`, UI at https://relay.onlygoals.tv). The Pi side
was built 2026-10-13 **differently from the plan below**: nginx-rtmp stays,
and an `exec_push` runs `/usr/local/bin/srt-push` (ffmpeg, codecs copied) to
the relay. See `network.md`, section "SRT relay to the cloud". The plan text
below is the owner's original, kept for the cloud-side details and the
acceptance tests; notes from the rig follow it.

Pi-side contract the build was done against (summary): never stall the
ATEM → Pi push; keep nginx and port 1935; retry forever; no re-encoding;
passphrase never printed, logged, committed or world-readable; caller is
the Pi, UDP 8890 outbound; stream id `publish:live`; MPEG-TS payload;
latency 2000000 µs to start; pkt_size 1316; one publisher at a time.

Notes against the rig as of 2026-10-12:

- The live relay today is nginx-rtmp with its push line in
  `/etc/nginx/rtmp-push.conf` (root-only); the `/network` page edits that
  file via `lib/rtmp.js` and restarts nginx. If MediaMTX replaces nginx,
  that editor has to target MediaMTX's config instead, or the page loses
  the ability to switch channels.
- The ATEM publishes to `rtmp://10.42.0.1/live` (application `live`, the
  ATEM's key is ignored by the relay). MediaMTX must answer at the same
  address and path so the ATEM needs no change.
- The Pi is arm64 (`6.12 rpt-rpi-2712`), so MediaMTX's linux_arm64 build.
- The Pi's internet is a Speedify bond; SRT over the bonded tunnel is
  untested. Speedify already handles per-link loss, so the SRT latency
  buffer may be able to be smaller than 2 s.
- YouTube ingest from the Pi is pinned to IPv4 in `/etc/hosts`; the AWS
  relay would not need that pin.
- The AWS account id and budget details live in the owner's AWS CLI
  config on the Mac mini; they are deliberately not in this public repo.

---

# Stream relay: ATEM → Pi → SRT → AWS → YouTube

A self-contained plan, meant to live in its own project on the Pi (not in onlygoals / polo_clipper).
Written 2026-10-12.

## Goal
The livestream chain:

ATEM Mini (RTMP) → **atem-pi** at the venue → **SRT** over the venue internet → **cloud relay** in AWS → **RTMP** to YouTube.

SRT carries the long, unreliable hop because it retransmits lost packets and rides out short dropouts. The relay in AWS has a solid connection to YouTube.

## Decisions made
- **MediaMTX at both ends**, not NGINX.
  - NGINX can't speak SRT at all, so it would always need an extra ffmpeg listener in front. That listener exits on every dropout and has to be restarted.
  - MediaMTX takes RTMP and SRT in natively, and its SRT listener stays open across reconnects.
  - Pushing out (Pi → SRT, relay → YouTube RTMP) is an `ffmpeg -c copy` that MediaMTX starts only while a stream is live (`runOnReady`). Nothing is re-encoded, so the CPU load is tiny.
  - The Pi currently runs NGINX. MediaMTX replaces it, and NGINX is kept installed (disabled) so it can be rolled back.
- **The relay gets its own small EC2**, separate from the onlygoals.tv server.
- **The relay is started and stopped per event.** An Elastic IP keeps its address fixed, so the Pi's config never changes.
- **The owner runs it like a contract.** Claude carries out this plan on both the Pi and AWS, with SSH access given at execution time.

## Facts about the existing setup
- **AWS:** region us-west-2, CLI configured on the Mac mini (`aws` in ~/.local/bin); account id in that CLI config.
  - The account has **no default VPC**. Reuse the onlygoals.tv VPC and its public subnet (look them up with `aws ec2 describe-subnets`), or create a small VPC in the stack.
  - An existing budget alert ("onlygoals monthly budget $150") emails the owner.
- **Mac mini:** its ffmpeg (~/.local/bin/ffmpeg) is built **without** SRT, so testing SRT from the Mac needs another build. Testing is done from the Pi instead.
- **Pi:** runs NGINX-RTMP today. The ATEM streams to it.
  - At execution, read its nginx config for the RTMP application name the ATEM uses, so MediaMTX answers at the same address and the ATEM needs no change.
  - Check `uname -m` (arm64 or armv7) to pick the MediaMTX build.

## Files (in the new project)
- **`cloud/cloudformation.yaml`**
  - **Instance:** a t4g.micro on Ubuntu 24.04 arm64 (its apt ffmpeg includes SRT; Amazon Linux has no ffmpeg) with an 8 GB disk.
  - **Elastic IP.**
  - **Security group:**
    - UDP 8890 (SRT) open to all, because venue IPs vary. A passphrase guards it.
    - TCP 22 open only to the admin's IP.
    - Nothing else; the MediaMTX API listens on localhost only.
  - **User-data:** installs ffmpeg and a pinned MediaMTX release (checksum verified), writes the config, and enables `mediamtx.service`.
- **`cloud/mediamtx.yml`**
  - SRT listener on :8890; RTMP, HLS and WebRTC off; API on 127.0.0.1:9997.
  - Path `live` takes a publish passphrase (`srtPublishPassphrase`, 10 to 79 characters).
  - `runOnReady: ffmpeg -i rtsp://127.0.0.1:8554/live -c copy -f flv rtmp://a.rtmp.youtube.com/live2/${YT_KEY}` with `runOnReadyRestart: yes`, so the YouTube push restarts if it fails.
  - `YT_KEY` comes from `/etc/relay/youtube.env` (mode 600), loaded by the systemd unit.
- **`pi/mediamtx.yml`**
  - RTMP on :1935, at the same path the ATEM uses today.
  - `runOnReady: ffmpeg -i rtsp://127.0.0.1:8554/$MTX_PATH -c copy -f mpegts "srt://<ELASTIC_IP>:8890?streamid=publish:live&passphrase=…&latency=2000000"` with `runOnReadyRestart: yes`.
  - The 2 s SRT buffer (ffmpeg takes latency in microseconds) can be tuned after the test.
  - Optional (off by default): `record: yes` to a USB drive, as a backup copy if the uplink is bad.
- **`pi/install.sh`**
  1. Back up `/etc/nginx` and disable `nginx.service` (stopped, not removed).
  2. Install ffmpeg (apt) and MediaMTX for the Pi's architecture.
  3. Install and enable `mediamtx.service`.
- **`relay.sh`** (run from wherever the AWS CLI is):
  - `up`: start the instance, wait until MediaMTX answers, print the SRT address.
  - `down`: stop the instance.
  - `status`: the instance state, plus each end's stream through the MediaMTX API over SSH: live or not, bitrate, SRT packet loss and retransmits.
  - `key`: copy the YouTube stream key from a local mode-600 file to `/etc/relay/youtube.env` on the relay.
- **`README.md`**: the game-day checklist (`relay.sh up` → ATEM on → check YouTube Studio → after the game, `relay.sh down`) and rollback.

## Secrets
- **The SRT passphrase:** generated once and kept in a mode-600 file. It is copied to both ends and never printed or pasted in chat.
- **The YouTube stream key:** the owner puts it in a mode-600 file. `relay.sh key` copies it to the relay. Never shown in chat.

## Cost (us-west-2)
| Item | Cost |
|---|---|
| t4g.micro, while running | about $0.008 an hour |
| Elastic IP | about $3.60 a month, always |
| Disk | about $0.65 a month |
| Traffic out to YouTube (the main cost) | $0.09/GB: an 8 Mbps stream is about 3.6 GB, so **about $0.32 an hour of streaming** |
| Traffic in from the Pi | free |

## Execution order (⚑ = needs the owner's OK)
1. Write the files.
2. ⚑ Create the stack (`aws cloudformation deploy`), then check MediaMTX is listening on UDP 8890.
3. ⚑ Pi SSH access: read the current NGINX config and the Pi's architecture, then run `pi/install.sh`.
4. **Dry run without YouTube:**
   - On the Pi, push an ffmpeg test pattern (with a tone) to its own RTMP.
   - Check that `relay.sh status` shows it live on the relay, with the YouTube push not configured yet.
5. ⚑ Owner fills in the YouTube key, then `relay.sh key`. Test into an unlisted/test YouTube event and watch YouTube Studio's preview.
6. **Dropout test:** cut the Pi's push for about 20 s, then check that it reconnects and the YouTube broadcast resumes with no one touching anything.
7. Owner streams from the real ATEM to the Pi (same address as before) for a full test.

## Verification
- `relay.sh status` shows the stream live at both ends, with steady bitrate and low SRT loss.
- YouTube Studio's stream health is Good or Excellent.
- The dropout test recovers on its own.
- After `relay.sh down` then `up`, the address is unchanged.
- **Rollback on the Pi:** `sudo systemctl disable --now mediamtx && sudo systemctl enable --now nginx`.
