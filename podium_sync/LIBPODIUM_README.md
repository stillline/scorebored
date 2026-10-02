# libpodium

A Python client for the [Podium](https://podiumbikepolo.com) live stream API — live bike polo tournament data for broadcast graphics.

A scorekeeper taps a goal on their phone and the number changes on your overlay a second later, with nobody assigned to the graphics. Scores, the game clock, penalties and timeouts, each team's record, standings, what's on deck, and the bracket: everything Podium knows about the court you're pointed at, over one WebSocket, as complete state every time anything changes.

**Standard library only** — no dependencies, ever. That's deliberate: the target is a Raspberry Pi at a venue with bad wifi, and a box touched twice a year shouldn't need a working package index to boot.

## Install

This repository is **private**, so pip needs credentials. Over SSH, with a key GitHub knows about:

```bash
pip install git+ssh://git@github.com/binaryseed/libpodium.git@v0.0.2
```

Always install a tag. Releases are git tags (`v0.0.1`, `v0.0.2`, …), and a tagged install can't change under you. To upgrade, run the same command with the newer tag, and don't do that mid-tournament. `pip show libpodium` tells you which version a machine has. The tags are listed at https://github.com/binaryseed/libpodium/tags.

If SSH isn't set up on the machine, use a personal access token with `repo` scope:

```bash
pip install git+https://<token>@github.com/binaryseed/libpodium.git@v0.0.2
```

Or skip pip entirely — the library is one directory of standard-library Python, so copying it works and needs no network on the far end. Check out the tag first so you know what you copied:

```bash
git checkout v0.0.2
scp -r podium pi@raspberrypi.local:~/overlay/
```

Either way the import is `podium` (the distribution is named `libpodium`; the package it installs is `podium`).

### Releasing

Bump `version` in `pyproject.toml`, commit, and tag that commit with the same number:

```bash
git tag v0.0.3
git push origin main v0.0.3
```

Then update the tag in the install commands above.

## Quick start

You need a key (ask a Podium admin), the tournament's slug (it's in the URL), and the court name as it appears on the schedule.

```python
from podium import PodiumClient, State, Goal

client = PodiumClient(key="pk_live_…", tournament="esq-2026", court="2")

@client.on_subscribed
def subscribed(state: State) -> None:
    print(state.tournament.name, "court", state.tournament.court.name)
    if state.game:
        g = state.game
        print(g.home.name, g.home.score, "–", g.away.score, g.away.name, g.clock.formatted())

@client.on_goal
def goal(state: State, event: Goal) -> None:
    print("GOAL", event.side, event.player.name if event.player else "(unattributed)")

client.start()      # returns immediately — your program carries on
```

`client.start()` spawns two daemon threads and returns. It never assumes it owns the process, blocks your main thread, or schedules a repaint. There's a `client.run()` for the case where this client *is* the whole app.

Connect to the region hosting the tournament: `wss://podiumbikepolo.com/api/livestream` (the default) or `wss://eu.podiumbikepolo.com/api/livestream` (pass `url=`).

## What it does for you

The client applies the rules so your renderer doesn't have to. It is transport, types and clock math — nothing else.

```python
state = client.state()                  # an immutable snapshot; read it whenever you like
game  = state.game

game.clock.formatted()                  # "7:42", or "+0:32" in golden-goal overtime
game.clock.whistle_stops_clock()        # would a goal right now stop the clock?
game.timeouts_left("home")              # allowance minus what they've taken
game.active_penalties()[0].frozen()     # serving, but not counting — the clock is stopped
state.next_change_in_ms()               # when anything on screen next changes
```

Three countdowns run on three different axes — the game clock on wall time while running, a penalty on game-clock *elapsed* (so it freezes during a stoppage), a timeout on the wall clock regardless. Getting that wrong is the classic overlay bug; the types handle it.

## Docs

- **[docs/wire.md](docs/wire.md)** — the wire reference. Envelope, ops, the two push types and every trigger, every field, the three clock formulas, error codes, reconnect semantics. Language-agnostic: read this if you're writing a client in something other than Python.
- **[docs/integration.md](docs/integration.md)** — the three ways to consume this from a program that already exists (handlers, read-on-demand, drain a queue) and the repaint-timer pattern.
- **[docs/bracket.css](docs/bracket.css)** — a starter stylesheet for the server-rendered bracket HTML.

## Examples

- **[examples/broadcast.py](examples/broadcast.py)** — a live scoreboard in your terminal. The best way to see the feed working, and a worked example of display-only rendering: it reads state on its own schedule and asks the library every rules question.
- **[examples/scorebug.py](examples/scorebug.py)** — fills an SVG template and hands whole frames to a renderer (the shape a chroma-key overlay wants).
- **[examples/watch.py](examples/watch.py)** — prints every frame as it arrives. Run this first against a new key.

```
python3 examples/broadcast.py --key pk_live_… --tournament esq-2026 --court 2
```

## Tests

```
python3 -m unittest discover -s tests -t .
```

No server needed — the tests replay recorded frames and assert derived clock values at known instants. CI runs them on Python 3.9 through 3.13.

## Requirements

Python 3.9+. Nothing else.

## License

MIT — see [LICENSE](LICENSE).
