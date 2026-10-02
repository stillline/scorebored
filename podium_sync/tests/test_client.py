"""The client against a scripted transport: no server, no network."""

import json
import queue
import threading
import time
import unittest

from podium import Clock, Goal, PodiumClient, PodiumError, State
from podium.transport import ConnectionClosed, Message

from . import fixtures

CLOSE = object()


class FakeWebSocket:
    """Answers subscribe/bracket/ping like the server, and lets a test push
    frames or drop the connection."""

    instances = []
    refuse_subscribe = False
    fail_connect = 0  # refuse this many connect() attempts, then behave

    def __init__(self, url):
        self.url = url
        self.sent = []
        self.inbox = queue.Queue()
        self.closed = False
        FakeWebSocket.instances.append(self)

    def connect(self):
        if FakeWebSocket.fail_connect > 0:
            FakeWebSocket.fail_connect -= 1
            raise ConnectionClosed(None, "refused")

    def send_text(self, text):
        frame = json.loads(text)
        self.sent.append(frame)
        if frame["op"] == "subscribe":
            if self.refuse_subscribe:
                self.inbox.put({"id": frame["id"], "ok": False, "error": {"code": "not_found", "message": "no"}})
            else:
                self.inbox.put(fixtures.subscribe_reply(frame["id"]))
        elif frame["op"] == "bracket":
            self.inbox.put({"id": frame["id"], "ok": True, "server_now": fixtures.SERVER_NOW, "data": fixtures.BRACKET_HTML})
        elif frame["op"] == "ping":
            self.inbox.put({"id": frame["id"], "ok": True, "server_now": fixtures.SERVER_NOW, "data": {"pong": True}})

    def recv(self):
        try:
            item = self.inbox.get(timeout=0.02)
        except queue.Empty:
            return None
        if item is CLOSE:
            raise ConnectionClosed(1001, "gone")
        return Message(1, json.dumps(item).encode("utf-8"))

    def close(self):
        self.closed = True

    def push(self, frame):
        self.inbox.put(frame)

    def drop(self):
        self.inbox.put(CLOSE)


def wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


class ClientTest(unittest.TestCase):
    def setUp(self):
        FakeWebSocket.instances = []
        FakeWebSocket.refuse_subscribe = False
        FakeWebSocket.fail_connect = 0
        self.client = PodiumClient(
            key="pk_live_test",
            tournament="esq-2026",
            court="2",
            url="wss://example.test/api/v1/stream",
            websocket_factory=FakeWebSocket,
            reconnect_min=0.01,
            reconnect_max=0.02,
            ping_interval=0.05,
        )

    def tearDown(self):
        self.client.stop()

    def ws(self):
        self.assertTrue(wait_for(lambda: FakeWebSocket.instances))
        return FakeWebSocket.instances[-1]

    def test_start_returns_immediately_and_subscribes(self):
        started = time.monotonic()
        self.client.start()
        self.assertLess(time.monotonic() - started, 0.5)

        self.assertTrue(wait_for(lambda: self.client.connected))
        ws = self.ws()
        self.assertIn("key=pk_live_test", ws.url)
        self.assertEqual(ws.sent[0]["op"], "subscribe")
        self.assertEqual(ws.sent[0]["tournament"], "esq-2026")
        self.assertEqual(ws.sent[0]["court"], "2")
        self.assertIsInstance(self.client.state(), State)
        self.assertEqual(self.client.state().game.home.score, 4)

    def test_handlers_get_typed_events_and_the_state_after(self):
        seen = []

        @self.client.on_subscribed
        def subscribed(state):
            seen.append(("subscribed", state))

        @self.client.on_goal
        def goal(state, event):
            seen.append(("goal", state, event))

        @self.client.on_clock_stopped
        def clock_stopped(state, event):
            seen.append(("clock_stopped", state, event))

        @self.client.on_standings_changed
        def standings_changed(state):
            seen.append(("standings_changed", state))

        self.assertIs(goal, goal)  # the decorator hands the function back unchanged
        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: len(seen) == 1))

        ws.push(fixtures.game_push("goal", fixtures.GOAL_EVENT, home={**fixtures.GAME["home"], "score": 5}))
        ws.push(fixtures.game_push("clock_stopped", fixtures.STOPPED_CLOCK, clock=fixtures.STOPPED_CLOCK))
        ws.push(fixtures.tournament_push("standings_changed"))
        self.assertTrue(wait_for(lambda: len(seen) == 4))

        trigger, state, event = seen[1]
        self.assertEqual(trigger, "goal")
        self.assertIsInstance(event, Goal)
        self.assertEqual(event.player.name, "Priya S.")
        self.assertEqual(state.game.home.score, 5)

        trigger, state, event = seen[2]
        self.assertIsInstance(event, Clock)
        self.assertFalse(event.running)
        self.assertFalse(state.game.clock.running)

        self.assertEqual(seen[3][0], "standings_changed")
        self.assertIs(self.client.state(), seen[3][1])

    def test_events_queue_receives_everything(self):
        events = self.client.events()
        self.client.start()
        ws = self.ws()
        first = events.get(timeout=2)
        self.assertEqual(first.trigger, "subscribed")
        self.assertIsNone(first.event)

        ws.push(fixtures.game_push("goal", fixtures.GOAL_EVENT))
        second = events.get(timeout=2)
        self.assertEqual((second.trigger, second.push), ("goal", "game"))
        self.assertIsInstance(second.event, Goal)
        self.assertIs(second.state, self.client.state())

        ws.push(fixtures.tournament_push("standings_changed"))
        third = events.get(timeout=2)
        self.assertEqual((third.trigger, third.push), ("standings_changed", "tournament"))
        self.assertIsNone(third.event)

    def test_a_raising_handler_does_not_stop_dispatch(self):
        seen = []

        @self.client.on_goal
        def bad(state, event):
            raise RuntimeError("boom")

        @self.client.on_goal
        def good(state, event):
            seen.append(event.id)

        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: self.client.connected))
        with self.assertLogs("podium", level="ERROR"):
            ws.push(fixtures.game_push("goal", fixtures.GOAL_EVENT))
            self.assertTrue(wait_for(lambda: seen == ["goal-3"]))

    def test_reconnects_with_a_fresh_subscribe_and_replaces_state(self):
        subscribed = []
        self.client.on_subscribed(lambda state: subscribed.append(state))
        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: len(subscribed) == 1))

        ws.push(fixtures.game_push("goal", fixtures.GOAL_EVENT, home={**fixtures.GAME["home"], "score": 9}))
        self.assertTrue(wait_for(lambda: self.client.state().game.home.score == 9))

        with self.assertLogs("podium", level="WARNING"):
            ws.drop()
            self.assertTrue(wait_for(lambda: len(FakeWebSocket.instances) == 2))
            self.assertTrue(wait_for(lambda: len(subscribed) == 2))

        self.assertTrue(self.client.connected)
        self.assertEqual(self.client.state().game.home.score, 4)
        self.assertEqual(FakeWebSocket.instances[1].sent[0]["op"], "subscribe")

    def test_connected_goes_false_while_down(self):
        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: self.client.connected))
        # every reconnect from here on is refused, so the client stays down
        FakeWebSocket.refuse_subscribe = True
        with self.assertLogs("podium", level="WARNING"):
            ws.drop()
            self.assertTrue(wait_for(lambda: not self.client.connected))
            self.assertTrue(wait_for(lambda: len(FakeWebSocket.instances) >= 3))
        self.assertFalse(self.client.connected)

    def test_survives_a_connect_that_fails_outright(self):
        # The venue's wifi is down when the process starts: the reader must
        # keep retrying rather than giving up on the first refusal.
        FakeWebSocket.fail_connect = 3
        with self.assertLogs("podium", level="WARNING"):
            self.client.start()
            self.assertTrue(wait_for(lambda: self.client.connected, timeout=5))
        self.assertGreaterEqual(len(FakeWebSocket.instances), 4)
        self.assertEqual(self.client.state().game.home.name, "Beavers")

    def test_reconnect_carries_the_same_subscription_and_handlers(self):
        goals = []
        self.client.on_goal(lambda state, event: goals.append(event.id))
        self.client.start()
        first = self.ws()
        self.assertTrue(wait_for(lambda: self.client.connected))

        with self.assertLogs("podium", level="WARNING"):
            first.drop()
            self.assertTrue(wait_for(lambda: len(FakeWebSocket.instances) == 2))
            self.assertTrue(wait_for(lambda: self.client.connected))

        second = FakeWebSocket.instances[1]
        subscribe = second.sent[0]
        self.assertEqual(subscribe["op"], "subscribe")
        self.assertEqual(subscribe["tournament"], "esq-2026")
        self.assertEqual(subscribe["court"], "2")
        self.assertIn("key=pk_live_test", second.url)
        self.assertTrue(first.closed, "the dead socket should be closed, not leaked")

        # Handlers registered before the drop still fire on the new connection.
        second.push(fixtures.game_push("goal", fixtures.GOAL_EVENT))
        self.assertTrue(wait_for(lambda: goals == ["goal-3"]))

    def test_reconnect_replaces_state_rather_than_merging_it(self):
        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: self.client.connected))

        ws.push(fixtures.game_push("goal", fixtures.GOAL_EVENT, home={**fixtures.GAME["home"], "score": 9}))
        self.assertTrue(wait_for(lambda: self.client.state().game.home.score == 9))

        with self.assertLogs("podium", level="WARNING"):
            ws.drop()
            self.assertTrue(wait_for(lambda: self.client.state().game.home.score == 4, timeout=5))

    def test_the_events_queue_keeps_delivering_across_a_reconnect(self):
        events = self.client.events()
        self.client.start()
        ws = self.ws()
        self.assertEqual(events.get(timeout=2).trigger, "subscribed")

        with self.assertLogs("podium", level="WARNING"):
            ws.drop()
            # The re-subscribe raises a fresh `subscribed` on the same queue.
            self.assertEqual(events.get(timeout=5).trigger, "subscribed")

        FakeWebSocket.instances[1].push(fixtures.game_push("goal", fixtures.GOAL_EVENT))
        self.assertEqual(events.get(timeout=2).trigger, "goal")

    def test_clock_anchors_are_re_anchored_after_a_reconnect(self):
        # A reconnect must re-anchor the clock to the new frame, or the
        # scorebug drifts by however long the outage lasted.
        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: self.client.connected))
        before = self.client.state().game.clock.anchor.received_at

        with self.assertLogs("podium", level="WARNING"):
            ws.drop()
            self.assertTrue(wait_for(lambda: len(FakeWebSocket.instances) == 2))
            self.assertTrue(wait_for(lambda: self.client.connected))
            self.assertTrue(
                wait_for(lambda: self.client.state().game.clock.anchor.received_at > before)
            )

    def test_stop_during_a_reconnect_backoff_returns_promptly(self):
        FakeWebSocket.fail_connect = 100  # never comes back
        with self.assertLogs("podium", level="WARNING"):
            self.client.start()
            self.assertTrue(wait_for(lambda: len(FakeWebSocket.instances) >= 2, timeout=5))

        started = time.monotonic()
        self.client.stop()
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertFalse(self.client.connected)
        self.assertFalse(
            any(t.name.startswith("podium-") and t.is_alive() for t in threading.enumerate())
        )

    def test_a_request_while_disconnected_raises(self):
        FakeWebSocket.fail_connect = 100
        with self.assertLogs("podium", level="WARNING"):
            self.client.start()
            self.assertTrue(wait_for(lambda: len(FakeWebSocket.instances) >= 2, timeout=5))
        with self.assertRaises(ConnectionClosed):
            self.client.bracket(timeout=1)

    def test_bracket_is_a_blocking_request(self):
        self.client.start()
        self.assertTrue(wait_for(lambda: self.client.connected))
        rendered = self.client.bracket(timeout=2)
        self.assertEqual(rendered["bset-1"].brackets[1].role, "losers")
        self.assertTrue(rendered["bset-1"].brackets[1].current)

    def test_bracket_error_raises(self):
        self.client.start()
        self.assertTrue(wait_for(lambda: self.client.connected))
        ws = self.ws()
        original = ws.send_text

        def refuse(text):
            frame = json.loads(text)
            if frame["op"] == "bracket":
                ws.inbox.put({"id": frame["id"], "ok": False, "error": {"code": "not_found", "message": "no tournament"}})
            else:
                original(text)

        ws.send_text = refuse
        with self.assertRaises(PodiumError) as raised:
            self.client.bracket(timeout=2)
        self.assertEqual(raised.exception.code, "not_found")

    def test_pings_when_idle(self):
        self.client.start()
        ws = self.ws()
        self.assertTrue(wait_for(lambda: any(f["op"] == "ping" for f in ws.sent), timeout=3))

    def test_context_manager_and_restart(self):
        with self.client as client:
            self.assertTrue(wait_for(lambda: client.connected))
        self.assertFalse(self.client.connected)
        self.assertTrue(self.ws().closed)
        self.assertFalse(any(t.name.startswith("podium-") and t.is_alive() for t in threading.enumerate()))

        self.client.start()
        self.assertTrue(wait_for(lambda: self.client.connected))


if __name__ == "__main__":
    unittest.main()
