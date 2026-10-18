# Full stream test on cellular, ATEM → Pi → Court A → YouTube

For 2026-10-18. The first end-to-end run of the new chain on the real
uplinks: ATEM on switcher_net, Pi running MediaMTX (port 1935), native SRT
forward to Court A, Court A relaying to YouTube. Everything below was
verified on 2026-10-17 at home on wired internet except the items marked
**NEW**. See `docs/relay.md` for how it all works.

Rule that never changes: the ATEM only ever talks to the Pi. If anything
goes wrong, change the Pi, the relay or the uplinks. Never let the ATEM's
push stall (it locks up and needs a power cycle).

## 1. Before leaving / the night before

- [ ] Pi boots clean: `systemctl is-active mediamtx scorebored` both `active`,
      `nginx` `inactive` (retired at the cutover).
- [ ] `/relay` opens on a phone on switcher_net (`http://10.42.0.1:3000/relay`):
      PI RELAY shows MediaMTX v1.21.2 and `rtmp://10.42.0.1:1935/live`.
- [ ] Court A is the target (`sudo relay-target status` → `courta`), or set it
      from the page.
- [ ] Secrets present: `/etc/srt-relay/relays.env` (owner mediamtx, mode 600)
      unchanged since yesterday. If the relay passphrases were rotated, copy
      the new file first.
- [ ] YouTube: the Court A relay's profile has the key for the channel and
      event you'll use. A wrong or stale key gives NO error anywhere; YouTube
      just shows nothing. Check this on the cloud dashboard, not on the Pi.
- [ ] Charge / pack: LM1200 (Verizon), T-Mobile hotspot, phones + USB cables
      for tethering, powered hub, HDMI to the ATEM, ATEM power.
- [ ] Optional: add a direct YouTube profile on `/profiles` (**NEW**, untested
      with a real key) so there is a fallback that skips the cloud relay.

## 2. At the venue, uplinks first

Hotspots stay powered off until this step (no cell data burns at home).

- [ ] Power the LM1200 (Router mode, "Mobile Broadband only") into HAT port 2,
      the T-Mobile hotspot into HAT port 1, phones on the hub if tethering.
- [ ] `/network`: each uplink shows up in Speedify with a real throughput
      number. Note the per-link numbers (this is the first venue reading for
      the Verizon SIM; at home it was unusable).
- [ ] Speedify is bonded and the tunnel is the default route:
      `ip route get 184.32.89.56` → `dev connectify0`.
- [ ] Outbound UDP 8890 works through the bond (it did at home). If a court
      stays RETRYING with "connection timeout" while the cloud dashboard
      says it's up, this is the first suspect.

## 3. Start the relay before the ATEM

- [ ] Cloud dashboard: start Court A (about 1 min). The Pi's picker shows it
      `up` once its login page answers.
- [ ] Court A's "Sending to" is the right YouTube profile; overlay as you
      want it (Off for the ATEM, which draws its own scorebug).
- [ ] Start YouTube Studio's event / go live view on a second screen.

Order matters because the relay switches itself off 30 min after its feed
disappears and sends the be-right-back card after 10 s without one.

## 4. ATEM on

- [ ] ATEM custom URL `rtmp://10.42.0.1/live`, any key. Start streaming.
- [ ] `/relay`: INCOMING FEED (ATEM) goes ONLINE with `H264 + MPEG-4 Audio`,
      bitrate near the ATEM's setting, From `10.42.0.100`.
- [ ] SENDING TO: Court A `pushing`, RELAYING, latency `4000 / 4000 ms`,
      lost/resent low. Resent climbing is normal on cellular; lost climbing
      with the bitrate falling means the bond cannot carry the ATEM's rate.
- [ ] Cloud dashboard: Court A INCOMING FEED ONLINE, From = the venue's
      public IP, Buffer ≈ 4000 ms. Note **Link capacity** and **Loss rate**.
- [ ] YouTube Studio: stream health Good or Excellent, no "bitrate 0" (that
      message can be stale for a minute after a gap).
- [ ] Watch for 5 min untouched. Record: ATEM bitrate, per-uplink throughput,
      RTT, resent, YouTube health.

## 5. Failure tests, with the dashboard and YouTube in view

Each one: the ATEM must stay streaming and INCOMING FEED must stay ONLINE
throughout. If it ever goes OFFLINE while the ATEM is on, stop and look.

- [ ] **Lose one uplink.** Unplug the T-Mobile hotspot for 30 s, plug it
      back. Expect: Speedify carries on over the others, the forward stays
      `pushing`, YouTube keeps going. Then the same with the LM1200.
- [ ] **Lose all uplinks for ~20 s.** Expect: forward goes RETRYING (EOF, then
      "connection timeout"), relay shows the be-right-back card, YouTube
      pauses; then everything recovers alone within ~10 s of the uplinks
      returning. Verified at home with a UDP block; **NEW** on real links.
- [ ] **Relay stopped.** Stop Court A from the cloud dashboard. Expect:
      RETRYING on the Pi, ATEM unaffected. Start it again: online within
      ~1 min with no action on the Pi. **NEW**
- [ ] **Switch court.** On `/relay` pick Court B, Switch to it. Expect: Court
      A offline, Court B online within ~20 s, the ATEM's connection
      untouched (INCOMING FEED's connected time keeps counting). Court B
      relays to whatever profile it's armed with, so check that first.
      Switch back.
- [ ] **Direct to YouTube** (**NEW**, needs a real profile): pick the profile,
      Switch to it. Expect: grey card, RELAYING, YouTube sees the feed
      within ~20 s via RTMPS. No be-right-back card on this path. Back to
      Court A.
- [ ] **Pi reboot with the ATEM streaming.** Expect: ATEM reconnects to
      MediaMTX by itself, forward comes back, Court A online, no hands.
      **NEW**. Time it.

## 6. Pack-down

- [ ] ATEM stop streaming first, then `/relay` Remove (target `off`) so
      nothing retries over cellular, then stop Court A on the dashboard.
- [ ] Hotspots off.
- [ ] Note anything that needed a hand, with the time, for the docs.

## If something is wrong

| Symptom | Look at |
|---|---|
| INCOMING FEED OFFLINE, ATEM says streaming | `ss -tn \| grep 1935` on the Pi; the ATEM's URL; MediaMTX active? |
| RETRYING, cloud dashboard says Court A up | UDP 8890 outbound through the bond; `ip route get 184.32.89.56` |
| RETRYING, dashboard says stopped | start it there; the Pi connects alone |
| Court A ONLINE, YouTube shows nothing | the YouTube key on the relay's profile (wrong key = silent) |
| Bitrate falling, lost climbing | the bond is short of bandwidth: lower the ATEM's rate, or add a phone |
| Page says DOWN | `sudo systemctl restart mediamtx`; `journalctl -u mediamtx -n 20` |
| Everything on the Pi looks broken | `sudo relay-target off`; worst case `sudo systemctl disable --now mediamtx && sudo systemctl enable --now nginx` (direct YouTube push only) |

Useful on the Pi:

    sudo relay-target status
    curl -s 127.0.0.1:9997/v3/paths/list
    curl -s '127.0.0.1:9997/v3/paths/forward-dests/list?path=live/<key>'
    journalctl -u mediamtx -f
