# Bad-uplink A/B test: SRT relay vs direct RTMP push

Run 2026-10-13 22:43 to 2026-10-14 00:40 PDT on switcherpi, with the owner watching the
relay's Live page and the YouTube players. Method and results; no test code
lives in the repo (see "Method"). Outcome feeds the fallback rule in
`network.md`.

## Question

Does the SRT path (Pi → cloud relay → YouTube) survive a bad uplink better
than the direct nginx-rtmp push (Pi → YouTube over TCP), and does either path
ever push back on the publisher (the ATEM lockup risk)?

## Method

- **Source:** a synthetic publisher on the Pi, `ffmpeg testsrc2` 1280x720 at
  30 fps with the wall clock burned in, libx264 at 5 Mbit/s (measured
  5.6 Mbit/s into nginx), AAC, published to `rtmp://127.0.0.1/live/abtest`.
  Same content for every run; the ATEM was off.
- **Impairment:** `tc` on the Speedify tunnel `connectify0`, egress only, with a
  `prio` root qdisc whose `u32` filters sent **only** `udp dport 8890` (SRT)
  and `tcp dport 1935` (RTMP) to a band carrying `netem`. Nothing else on the
  Pi was impaired (verified with a concurrent ping: 0 % loss). Inside the
  tunnel means Speedify's redundancy could not repair the damage, so both paths
  met identical conditions.
- **Run shape:** 30 s clean, the impairment, 60 s recovery. Pi-side metrics
  logged once a second: the publisher's socket send queue (would grow if nginx
  stopped draining it, the stand-in for "the ATEM would notice"), the YouTube
  push socket's existence and send queue, the SRT ffmpeg's liveness and
  respawn count, ingest bitrate, netem packet and drop counters.
- **Tooling:** a throwaway script in the session scratchpad, with a mandatory
  duration on every impairment and three independent clear paths. It was not
  installed anywhere and is gone with the session. The tunnel's qdisc was
  verified back at the default `fq_codel` after every run.
- **Modes** were switched with the Stream Output box on `/network`; the
  publisher was restarted after the nginx restart.

### Profiles

| profile | netem on the stream band | simulates |
|---|---|---|
| baseline | none (pass-through) | control |
| loss2 | `loss 2%` | the loss the relay had already shown on the bond |
| loss5 | `loss 5%` | bad cell |
| jitter | `delay 150ms 60ms` | congested tower, latency spikes |
| squeeze | `rate 4mbit` | uplink slower than the 5.6 Mbit stream |
| out 10 | `loss 100%` for 10 s | brief dead uplink |
| out 30 | `loss 100%` for 30 s | handover, modem reset |
| cellular | `loss 2% delay 80ms 30ms rate 8mbit` | realistic bad venue |

Each impairment ran 120 s except the outages.

## Results, Pi side

Publisher send queue stayed at 0 (transient 20 KB blips at most) in **every run
on both paths**: nginx never pushed back on the publisher, whatever the uplink
did. Ingest bitrate stayed 5.63 to 5.67 Mbit/s throughout.

| profile | SRT: netem dropped | SRT: respawns | SRT: push gone | Direct: netem dropped | Direct: push socket dropped | Direct: max TCP backlog |
|---|---|---|---|---|---|---|
| baseline | 0 / 69118 | 0 | 0 s | 0 / 7600 | 0 | 57 KB |
| loss2 | 1380 / 68834 (2.0 %) | 0 | 0 s | 142 / 7496 | 0 | 62 KB |
| loss5 | 3682 / 69289 (5.3 %) | 0 | 0 s | 351 / 7291 | 0 | 237 KB |
| jitter | 0 / **123049** | 0 | 0 s | 0 / 5577 | 0 | 305 KB |
| squeeze | 18309 / 71356 (**26 %**) | 0 | 0 s | 0 / 4074 | 0 | **5.1 MB** |
| out 10 | all | 1 | 5 s | all | 0 | 4.1 MB |
| out 30 | all | 2 | 9 s | all | 1 | 4.1 MB |
| cellular | 1418 / 68771 (2.1 %) | 0 | 0 s | 85 / 5396 | 0 | 428 KB |
| loss5, direct, MSS clamp (ineffective, see caveat) | | | | 331 / 6415 | 0 | 240 KB |
| loss5, direct, 1288-byte segments via host route | | | | 821 / 26589 | 0 | 516 KB |

Timings worth keeping:

- **SRT outages.** SRT declares the peer dead after about 5 s of silence, so
  any cut longer than that ends the connection: ffmpeg exited 5 s into each
  cut, nginx respawned it 5 s later, and the push was back about 5 s after the
  uplink returned (10 s cut: broke 23:08:05, back 23:08:10; 30 s cut: broke
  23:09:47, back 23:10:02 while the cut was still on, connected when it
  lifted). The 2 s latency window covers loss and jitter, not a dead link.
- **Direct outages.** TCP rode out the 10 s cut without dropping the socket:
  4.1 MB queued, drained 10 s after the cut lifted, so YouTube got the whole
  stream late and caught up. On the 30 s cut nginx dropped the push 2 s after
  the cut ended and reconnected 5 s later. Net: 10 s cut costs about 10 s,
  30 s cut about 37 s, versus about 15 s and 39 s on SRT.
- **Squeeze.** The opposite behaviours. SRT kept latency and sacrificed data:
  26 % of packets never made it (retransmissions add to an already full link),
  so the picture dropped out and came back garbled for the whole two minutes,
  and recovered within seconds of the cap lifting with no respawn. The direct
  push kept the data and sacrificed latency: TCP queued up to 5.1 MB (about
  10 s at 4 Mbit) and delivered everything late; the backlog drained 13 s
  after the cap lifted. Neither is good; a cap below the stream rate needs a
  lower encoder bitrate, not a better transport.
- **Jitter.** 150 ms ± 60 ms reordered packets badly enough that SRT treated
  late arrivals as lost and retransmitted: 1.8x the packets went out for the
  same stream, with nothing actually dropped. At 80 ms ± 30 ms (cellular) the
  effect vanished. TCP's backlog just grew with the round trip. Heavy jitter
  therefore costs SRT uplink bandwidth, which matters on a thin link.

## Results, viewer side

The owner watched the relay Live page and a YouTube player but did not keep a
per-run log. Remarks given live, with the run they fell in:

| run | remark |
|---|---|
| SRT loss2, loss5 | "stream was clean" |
| SRT squeeze | "dropped", "coming back garbled", "dropped", "back", "spinning wheel" |
| SRT out 10, out 30 | "stream down", then "stream back" / "down", "back" |
| direct runs | not recorded |

The outage recovery times in the Pi-side table are therefore the only timings
for the direct path; its viewer-side behaviour under squeeze (expected: stall,
then catch-up with growing delay) was not observed. A rerun with notes, or a
recording of the player, would complete the comparison.

## Caveat: segment size, and why the loss rows favour the direct push

netem counted about 7000 packets per two minutes on the TCP push against about
69000 SRT datagrams. The TCP segments on the wire are 14748 bytes (tcpdump on
`connectify0`), because the TCP connection to YouTube does not actually leave
the Pi as TCP: the route points into the Speedify tunnel and the handshake is
answered by Speedify's local endpoint, which advertises a 14748-byte MSS
(the tunnel MTU of 14800). Speedify then carries the bytes to its server with
its own transport. Consequences for this test:

- A per-packet loss rate hit TCP with about one loss event per second and SRT
  with about twelve, for the same bytes. The loss rows are therefore gentler on
  the direct path than per-frame loss on a radio link would be.
- Two attempts to make it fair failed and are recorded here so they are not
  repeated: an iptables TCPMSS clamp on our outgoing SYN only changes what we
  *receive* (the send MSS comes from the peer's SYN-ACK); turning off generic
  segmentation offload on `connectify0` changed nothing because the stack was
  genuinely emitting 14748-byte segments, not offload aggregates. The lever
  that works is a host route for the ingest IP with `mtu lock 1340`, which
  caps the send MSS at 1300 (verified on the wire: 1288-byte segments). Run
  once at 00:36 to 00:40: netem then saw 26589 packets (still aggregates of
  two or three segments, since offload re-bundles them before the qdisc) and
  dropped 821. **The TCP push still did not collapse**: backlog 350 to 516 KB,
  no socket drop, ingest untouched.
- Why TCP shrugs it off here: its control loop runs to Speedify's local
  endpoint, a round trip of about a millisecond, not to YouTube. Loss recovery
  at that round trip is almost free, so the textbook collapse of TCP under
  loss (which assumes an internet-scale round trip) does not apply to this
  rig. Whatever Speedify does with its own uplinks is invisible to the push.
- More importantly, this is how the rig really works: loss on the physical
  uplinks is seen and repaired (or not) by Speedify's transport, not by the
  TCP push. The difference between the two paths under real uplink trouble is
  therefore less about TCP congestion control collapsing and more about what
  each does when Speedify delivers late: TCP queues and the delay grows, SRT
  drops what misses its 2 s window and the delay stays fixed.

The squeeze and outage profiles are rate- and time-based and compare fairly.

## Conclusion

On this rig, with a 5.6 Mbit stream and a 2 s SRT window:

1. **Neither path ever pushes back on the publisher.** The ATEM lockup risk is
   not a transport question; nginx isolates the ATEM on both paths.
2. **Random loss up to 5 % and moderate jitter are handled by both paths**
   with no visible damage, including the direct push with 1288-byte segments.
   SRT's loss-recovery advantage does not show on this rig because the TCP
   push terminates locally at Speedify (see the caveat).
3. **Outages cost about the same on both paths**, 10 to 40 s depending on
   length, and both recover without a manual step.
4. **A bandwidth squeeze is the only profile where they differ in kind:** SRT
   garbles and stays live-ish, TCP buffers and falls behind. Both are bad; the
   fix is bitrate.
5. **Heavy jitter is SRT's weak spot**, nearly doubling uplink use.

So the fallback rule in `network.md` stands, and gets sharper: the relay's
value on this rig is operational (fan-out to several channels for one uplink
stream, switching targets without touching the Pi, no YouTube IPv4 pin), not
a dramatically tougher transport. Fall back to the direct push when the relay
itself is the problem. For uplink trouble, lower the ATEM's bitrate; neither
transport rescues a link slower than the stream.

Possible follow-ups, not done: raise `latency` above 2 s to see whether the
jitter retransmissions subside (costs delay); repeat the squeeze run in direct
mode with the player watched or recorded, to see the stall-and-catch-up that
the 5 MB backlog implies; test with Speedify off, where the TCP push would
face a real internet round trip.
