"""``PodiumClient``: a Podium live stream subscription that lives inside
someone else's program.

``start()`` spawns two daemon threads — a reader that owns the socket and a
dispatcher that runs your handlers — and returns immediately. Nothing here
blocks, schedules a repaint, or touches your rendering context. Three ways
to consume, all non-blocking; pick whichever fits your app:

1. Handlers — one decorator per trigger (``@client.on_goal``).
2. Read on demand — ``client.state()`` from your own loop.
3. Drain a queue — ``client.events()`` hands you a ``queue.Queue`` you pump
   on your own thread. Use this if your renderer is not thread-safe.

See ``integration.md`` for the three modes side by side.
"""

from __future__ import annotations

import json
import logging
import queue
import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from . import parse
from .transport import ConnectionClosed, WebSocket, WebSocketError
from .types import (
    Anchor,
    BracketHTML,
    Clock,
    Game,
    Goal,
    Penalty,
    State,
    Timeout,
)

DEFAULT_URL = "wss://podiumbikepolo.com/api/livestream"

log = logging.getLogger("podium")

TRIGGERS = (
    "subscribed",
    "game_started",
    "goal",
    "goal_removed",
    "clock_started",
    "clock_stopped",
    "clock_adjusted",
    "period_changed",
    "penalty",
    "penalty_ended",
    "timeout",
    "game_finished",
    "game_changed",
    "standings_changed",
    "queue_changed",
    "structure_changed",
    "tournament_changed",
)

TOURNAMENT_TRIGGERS = frozenset(
    {"standings_changed", "queue_changed", "structure_changed", "tournament_changed"}
)

GAME_TRIGGERS = frozenset(t for t in TRIGGERS if t not in TOURNAMENT_TRIGGERS and t != "subscribed")

STATE_ONLY_TRIGGERS = TOURNAMENT_TRIGGERS | {"subscribed"}


class PodiumError(Exception):
    """The server answered an op with ``ok: false``."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Event:
    """One item on the ``events()`` queue: which push carried it, the trigger,
    its typed event (``None`` for the state-only triggers), and the state
    after it. ``push`` is ``"game"``, ``"tournament"``, or ``None`` for
    ``subscribed``, which has no frame of its own."""

    trigger: str
    event: Any
    state: State
    push: Optional[str] = None


class PodiumClient:
    def __init__(
        self,
        key: str,
        tournament: str,
        court: str,
        url: str = DEFAULT_URL,
        *,
        ping_interval: float = 25.0,
        reconnect_min: float = 1.0,
        reconnect_max: float = 30.0,
        websocket_factory: Optional[Callable[[str], WebSocket]] = None,
    ):
        self.key = key
        self.tournament = tournament
        self.court = court
        self.url = url
        self.ping_interval = ping_interval
        self.reconnect_min = reconnect_min
        self.reconnect_max = reconnect_max
        self._websocket_factory = websocket_factory or WebSocket

        self._state: Optional[State] = None
        self._connected = False
        self._stop = threading.Event()
        self._reader: Optional[threading.Thread] = None
        self._dispatcher: Optional[threading.Thread] = None
        self._ws: Optional[WebSocket] = None
        self._send_lock = threading.Lock()
        self._dispatch_q: "queue.Queue[Optional[Event]]" = queue.Queue()
        self._events_q: Optional["queue.Queue[Event]"] = None
        self._handlers: Dict[str, List[Callable[..., None]]] = {t: [] for t in TRIGGERS}
        self._any_handlers: List[Callable[[State, str, Any], None]] = []
        self._pending: Dict[str, "queue.Queue[dict]"] = {}
        self._next_id = 0

    # --- lifecycle ---

    def start(self) -> None:
        """Connect in the background and return immediately."""
        if self._reader is not None:
            return
        self._stop.clear()
        self._dispatcher = threading.Thread(target=self._dispatch_loop, name="podium-dispatch", daemon=True)
        self._reader = threading.Thread(target=self._read_loop, name="podium-reader", daemon=True)
        self._dispatcher.start()
        self._reader.start()

    def run(self) -> None:
        """``start()`` and then block until ``stop()`` or Ctrl-C. Only for a
        program where this client *is* the whole app; everything else should
        call ``start()`` and carry on."""
        self.start()
        try:
            while not self._stop.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self) -> None:
        """Close the socket and stop both threads. The client can be started again."""
        self._stop.set()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001 - shutting down, nothing to do about it
                pass
        self._dispatch_q.put(None)
        for thread in (self._reader, self._dispatcher):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=5.0)
        self._reader = None
        self._dispatcher = None
        self._connected = False

    def __enter__(self) -> "PodiumClient":
        self.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()

    # --- reading ---

    @property
    def connected(self) -> bool:
        """True while subscribed and receiving. Key up a "no data" indicator
        on False — a frozen scorebug is worse than a blank one."""
        return self._connected

    def state(self) -> Optional[State]:
        """The latest snapshot, or ``None`` before the first subscribe reply.
        Lock-free: a reference to an immutable object."""
        return self._state

    def events(self) -> "queue.Queue[Event]":
        """A queue every event is also placed on, for pumping from your own
        thread. Created on first call; events before that are not replayed."""
        if self._events_q is None:
            self._events_q = queue.Queue()
        return self._events_q

    # --- ops ---

    def bracket(self, timeout: float = 10.0) -> BracketHTML:
        """The ``bracket`` op: every bracket set, each bracket rendered to HTML.
        Blocks for the reply; raises ``PodiumError`` on a refused request."""
        reply = self._request({"op": "bracket", "tournament": self.tournament}, timeout)
        return parse.parse_bracket_html(reply["data"])

    def _request(self, frame: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        ws = self._ws
        if ws is None or not self._connected:
            raise ConnectionClosed(None, "not connected")
        with self._send_lock:
            self._next_id += 1
            frame_id = str(self._next_id)
            waiter: "queue.Queue[dict]" = queue.Queue(maxsize=1)
            self._pending[frame_id] = waiter
            ws.send_text(json.dumps({"id": frame_id, **frame}))
        try:
            reply = waiter.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"no reply to {frame['op']} within {timeout}s") from None
        finally:
            self._pending.pop(frame_id, None)
        if not reply.get("ok"):
            error = reply.get("error") or {}
            raise PodiumError(error.get("code", "error"), error.get("message", ""))
        return reply

    # --- handlers ---

    def _register(self, trigger: str, fn: Callable[..., None]) -> Callable[..., None]:
        self._handlers[trigger].append(fn)
        return fn

    def on_subscribed(self, fn: Callable[[State], None]) -> Callable[[State], None]:
        return self._register("subscribed", fn)

    def on_game_started(self, fn: Callable[[State, Game], None]) -> Callable[[State, Game], None]:
        return self._register("game_started", fn)

    def on_goal(self, fn: Callable[[State, Goal], None]) -> Callable[[State, Goal], None]:
        return self._register("goal", fn)

    def on_goal_removed(self, fn: Callable[[State, Goal], None]) -> Callable[[State, Goal], None]:
        return self._register("goal_removed", fn)

    def on_clock_started(self, fn: Callable[[State, Clock], None]) -> Callable[[State, Clock], None]:
        return self._register("clock_started", fn)

    def on_clock_stopped(self, fn: Callable[[State, Clock], None]) -> Callable[[State, Clock], None]:
        return self._register("clock_stopped", fn)

    def on_clock_adjusted(self, fn: Callable[[State, Clock], None]) -> Callable[[State, Clock], None]:
        return self._register("clock_adjusted", fn)

    def on_period_changed(self, fn: Callable[[State, Clock], None]) -> Callable[[State, Clock], None]:
        return self._register("period_changed", fn)

    def on_penalty(self, fn: Callable[[State, Penalty], None]) -> Callable[[State, Penalty], None]:
        return self._register("penalty", fn)

    def on_penalty_ended(self, fn: Callable[[State, Penalty], None]) -> Callable[[State, Penalty], None]:
        return self._register("penalty_ended", fn)

    def on_timeout(self, fn: Callable[[State, Timeout], None]) -> Callable[[State, Timeout], None]:
        return self._register("timeout", fn)

    def on_game_finished(self, fn: Callable[[State, Game], None]) -> Callable[[State, Game], None]:
        return self._register("game_finished", fn)

    def on_game_changed(self, fn: Callable[[State, Game], None]) -> Callable[[State, Game], None]:
        return self._register("game_changed", fn)

    def on_standings_changed(self, fn: Callable[[State], None]) -> Callable[[State], None]:
        return self._register("standings_changed", fn)

    def on_queue_changed(self, fn: Callable[[State], None]) -> Callable[[State], None]:
        return self._register("queue_changed", fn)

    def on_structure_changed(self, fn: Callable[[State], None]) -> Callable[[State], None]:
        return self._register("structure_changed", fn)

    def on_tournament_changed(self, fn: Callable[[State], None]) -> Callable[[State], None]:
        return self._register("tournament_changed", fn)

    def on_any(self, fn: Callable[[State, str, Any], None]) -> Callable[[State, str, Any], None]:
        """Every trigger, as ``(state, trigger, event)``. For logging and debugging."""
        self._any_handlers.append(fn)
        return fn

    # --- the reader thread ---

    def _read_loop(self) -> None:
        backoff = self.reconnect_min
        while not self._stop.is_set():
            try:
                self._session()
                backoff = self.reconnect_min
            except (ConnectionClosed, WebSocketError, OSError, ValueError) as exc:
                self._connected = False
                self._ws = None
                if self._stop.is_set():
                    break
                log.warning("podium: connection lost (%s); reconnecting in %.1fs", exc, backoff)
            except Exception:  # noqa: BLE001 - the reader must survive anything
                self._connected = False
                self._ws = None
                log.exception("podium: reader failed; reconnecting in %.1fs", backoff)
            if self._stop.wait(backoff * (0.8 + 0.4 * random.random())):
                break
            backoff = min(backoff * 2, self.reconnect_max)

    def _session(self) -> None:
        separator = "&" if "?" in self.url else "?"
        ws = self._websocket_factory(f"{self.url}{separator}key={self.key}")
        ws.connect()
        self._ws = ws
        try:
            with self._send_lock:
                self._next_id += 1
                sub_id = str(self._next_id)
                ws.send_text(
                    json.dumps(
                        {"id": sub_id, "op": "subscribe", "tournament": self.tournament, "court": self.court}
                    )
                )
            last_send = time.monotonic()
            while not self._stop.is_set():
                message = ws.recv()
                now = time.monotonic()
                if message is None:
                    if now - last_send >= self.ping_interval:
                        with self._send_lock:
                            ws.send_text(json.dumps({"id": "ping", "op": "ping"}))
                        last_send = now
                    continue
                frame = json.loads(message.text)
                if "push" in frame:
                    self._on_push(frame)
                elif frame.get("id") == sub_id:
                    self._on_subscribed(frame)
                elif frame.get("id") in self._pending:
                    self._pending[frame["id"]].put(frame)
        finally:
            self._connected = False
            self._ws = None
            ws.close()

    def _anchor(self, frame: Dict[str, Any]) -> Anchor:
        server_now = parse.parse_datetime(frame["server_now"])
        return Anchor(server_now=server_now, received_at=time.monotonic())  # type: ignore[arg-type]

    def _on_subscribed(self, frame: Dict[str, Any]) -> None:
        if not frame.get("ok"):
            error = frame.get("error") or {}
            raise PodiumError(error.get("code", "error"), error.get("message", ""))
        state = parse.parse_state(frame["data"], self._anchor(frame))
        self._state = state
        self._connected = True
        self._dispatch_q.put(Event("subscribed", None, state))

    def _on_push(self, frame: Dict[str, Any]) -> None:
        previous = self._state
        if previous is None:
            return
        anchor = self._anchor(frame)
        trigger = frame["trigger"]
        if frame["push"] == "game":
            game = parse.parse_game(frame["data"], anchor)
            state = State(tournament=previous.tournament, game=game, anchor=anchor)
        else:
            state = State(tournament=parse.parse_tournament(frame["data"]), game=previous.game, anchor=anchor)
        event = parse.parse_event(trigger, frame.get("event"), anchor, state.game)
        self._state = state
        self._dispatch_q.put(Event(trigger, event, state, frame["push"]))

    # --- the dispatcher thread ---

    def _dispatch_loop(self) -> None:
        while True:
            item = self._dispatch_q.get()
            if item is None:
                return
            if self._events_q is not None:
                self._events_q.put(item)
            for fn in self._any_handlers:
                self._call(fn, item.state, item.trigger, item.event)
            for fn in self._handlers.get(item.trigger, ()):
                if item.trigger in STATE_ONLY_TRIGGERS:
                    self._call(fn, item.state)
                else:
                    self._call(fn, item.state, item.event)

    @staticmethod
    def _call(fn: Callable[..., None], *args: Any) -> None:
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - a raising handler must not kill the dispatcher
            log.exception("podium: handler %s raised", getattr(fn, "__name__", fn))
