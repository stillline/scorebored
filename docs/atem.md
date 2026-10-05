# ATEM Switcher Integration

Connects to a Blackmagic ATEM switcher on startup for automated commercial-break
production: cutting to a graphics input, managing the downstream key, and
muting/restoring audio around the break.

## Configuration

Set via environment variables (e.g. in `scorebored.service` or the shell
before `node server.js`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ATEM_IP` | `10.42.0.100` | ATEM IP address |
| `GRAPHICS_INPUT` | `1` | HDMI input number showing the scoreboard computer |
| `DOWNSTREAM_KEY` | `1` | DSK number used for the scoreboard overlay |

The server retries the connection automatically if it fails on startup; use
the **Connect** button on `/control` to retry manually.

## Commercial break sequence

**Start of break:**

1. Turns off the upstream key (USK)
2. Fades out the downstream key (DSK)
3. Auto-transitions to the graphics input
4. Mutes all Fairlight audio inputs except the graphics HDMI
5. Plays the selected video on `/display`

**End of break:**

1. Cuts back to the previous camera input
2. Turns the DSK back on
3. Turns the USK back on
4. Restores camera audio (mics remain muted for manual restore)

## Manual control

`/control` has an ATEM panel showing connection state, current input, and
DSK/USK state, with buttons to switch inputs and toggle keys directly.

A REST route also exists for external controllers (e.g. a keyboard macro
pad): `POST /api/atem/input/:num` cuts directly to that input.

## Implementation

Lives in `lib/atem.js`. Keeps `atemStatus` (connected, currentInput,
downstreamKeyEnabled, upstreamKeyEnabled) in sync with the physical switcher
via its own `stateChanged` listener, so the UI reflects changes made from the
physical ATEM panel too, not just ones this app made itself.

## Troubleshooting

- **Not connecting:** verify `ATEM_IP`, confirm the switcher is powered and
  on the same network/subnet as the Pi, and check nothing is blocking port
  9910.
- **Wrong input used for graphics:** set `GRAPHICS_INPUT` to match whatever
  input the scoreboard/graphics computer is actually plugged into, then
  restart the service.
- Tested with ATEM Mini Pro ISO; should work with any ATEM model exposing
  Ethernet control, downstream keyers, and program input switching.
