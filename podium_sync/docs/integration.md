# Dropping the client into your program

The client never assumes it owns the process. `start()` spawns two daemon threads (a socket reader and a handler dispatcher) and returns immediately; your program keeps whatever structure it already has. Pick one of three ways to consume, or mix them.

```python
from podium import PodiumClient

client = PodiumClient(key="pk_live_…", tournament="esq-2026", court="2")
client.start()      # returns at once
…
client.stop()       # closes the socket, joins the threads; start() again is fine
```

`client.connected` is `True` while subscribed and receiving. Key up a "no data" indicator when it's `False` — a frozen scorebug is worse than a blank one. Reconnects are automatic with backoff; each one re-subscribes and replaces `state()` with the server's current state.

## 1. Handlers — one decorator per trigger

The documented form. Each trigger on the wire has a decorator of the same name; the handler takes the state after the change and, for game triggers, the typed thing that changed.

```python
from podium import PodiumClient, State, Game, Goal, Clock, Penalty, Timeout

client = PodiumClient(key="pk_live_…", tournament="esq-2026", court="2")


@client.on_subscribed
def subscribed(state: State) -> None:
    draw_scorebug(state.game)


@client.on_goal
def goal(state: State, event: Goal) -> None:
    if event.player:
        flash_lower_third(event.player.name)
    draw_scorebug(state.game)


@client.on_clock_stopped
def clock_stopped(state: State, event: Clock) -> None:
    draw_scorebug(state.game)


@client.on_penalty
def penalty(state: State, event: Penalty) -> None:
    show_penalty_box(event.side, event.severity)


@client.on_game_finished
def game_finished(state: State, event: Game) -> None:
    log_chapter(event.started_at, event.ended_at, event.home.name, event.away.name)


@client.on_standings_changed
def standings_changed(state: State) -> None:
    rebuild_standings_card(state.tournament.stages)


client.start()
```

Naming is fully regular: trigger `goal` → decorator `@client.on_goal` → handler named `goal` → second argument `event: Goal`. No parentheses on the decorator. The full list is the trigger table in `wire.md`; `subscribed`, `standings_changed`, `queue_changed`, `structure_changed` and `tournament_changed` take `(state)` only. `@client.on_any` takes `(state, trigger, event)` for logging.

Handlers run on the dispatcher thread, **not** the socket thread, so a slow `show()` never stalls reading. A handler that raises is logged and the thread carries on. If your renderer is not thread-safe (pygame, tkinter, GTK…), don't render from a handler — use mode 3.

## 2. Read on demand — `client.state()`

You already have a loop. Ask for the latest snapshot each time round it, at whatever rate it already runs:

```python
client.start()
while True:
    state = client.state()          # None until the first subscribe reply
    if state and state.game:
        draw_scorebug(state.game)   # clock methods give the value for *now*
    time.sleep(1 / 30)
```

`state()` is lock-free: the reader builds a new frozen `State` and assigns one attribute, so you get the old object or the new one, never a torn read. Everything hanging off it is immutable.

## 3. Drain a queue — `client.events()`

For a renderer that must be touched from one thread only. Every event is also placed on a `queue.Queue` you pump yourself; the library never touches your rendering context.

```python
import queue

events = client.events()      # call before start() to get everything from `subscribed` on
client.start()

while True:                   # your main thread, e.g. inside a GUI toolkit's idle callback
    try:
        item = events.get(timeout=0.05)
    except queue.Empty:
        continue
    if item.trigger == "goal" and item.event.player:
        flash_lower_third(item.event.player.name)
    draw_scorebug(item.state.game)
```

Each item is an `Event(trigger, event, state)`. Handlers (mode 1) still fire if you registered any; the queue is independent.

## Repainting the clock

The library does clock **math**, never clock **scheduling** — it has no timer and no opinion about your render loop. Every clock value is derived on demand from the frame's anchors:

```python
clock = state.game.clock
clock.remaining_ms()          # what to display right now
clock.remaining_seconds()     # the same, as whole seconds for display
clock.next_change_in_ms()     # how long until that whole-second reading changes (None if stopped)
clock.formatted()             # "7:42", or "+0:32" in overtime
clock.in_stoppage_window()    # the last two minutes (or overtime) — whistles stop the clock now
clock.whistle_stops_clock()   # would a goal or penalty right now actually stop it?

penalty.remaining_ms()        # on the game-clock axis: frozen while the clock is stopped
penalty.remaining_seconds()
timeout.remaining_ms()        # on the wall clock: keeps counting during the stoppage, zero once play resumes
timeout.remaining_seconds()
```

Use `remaining_seconds()` rather than `remaining_ms() // 1000` for anything you display: a countdown **ceils** (0:01 holds until zero) and overtime **floors**, matching Podium's own scoreboard. Flooring a countdown yourself reads a second low.

The rules are applied for you, not just handed over. `game.rules` is the snapshot *that game* is being played under, and the derivations that depend on it are already methods:

```python
game.timeouts_left("home")     # allowance minus what they've taken
game.timeouts_used("away")
clock.whistle_stops_clock()    # the stop-clock rule, not something you reimplement
```

So a penalty at 8:00 leaving the clock running isn't a missed `clock_stopped` — `whistle_stops_clock()` says why. And if a tournament runs without a clock at all (`rules.time_tracking` false), `game.clock` is simply `None`; there's no special case to write.

`next_change_in_ms()` is there so you can align repaints to second boundaries instead of polling on a fixed interval — that misalignment is what makes hand-rolled clocks visibly stutter. The timer is yours; a few lines is all it takes:

```python
import threading

def repaint():
    state = client.state()
    if state and state.game:
        draw_scorebug(state.game)
        wait = state.game.clock.next_change_in_ms() if state.game.clock else None
        threading.Timer((wait or 1000) / 1000, repaint).start()
    else:
        threading.Timer(1.0, repaint).start()

client.start()
repaint()
```

Repaint on every event as well (a goal, a stop) and let the timer take care of the ticks in between. With an `asyncio` or GUI loop, replace `threading.Timer` with that loop's own one-shot (`loop.call_later`, `after`, `GLib.timeout_add`) — the value it needs is the same.

Interpolation uses `time.monotonic()` throughout, never `time.time()`; a Raspberry Pi has no RTC and its wall clock leaps when NTP syncs after boot.

## The bracket

```python
for set_id, bset in client.bracket().items():      # blocking, returns typed objects
    for bracket in bset.brackets:
        if bracket.current:
            key_up_html(bracket.html)               # style it with bracket.css or your own
```

Cache the result and re-request on `structure_changed`; it's big and changes a few times an hour. The raw bracket structure (rounds → padded match slots with resolved labels) is also in `state.tournament.brackets` if you'd rather draw it yourself.

## Putting it on the Pi

`scp -r api/python/podium pi@…:~/overlay/` and `import podium`. Nothing to install; Python 3.9+ standard library only. `python3 -m unittest discover -s tests -t .` from `api/python` runs the library's own tests without a server.

See `examples/scorebug.py` for a complete program that fills an SVG template and hands whole frames to a renderer.
