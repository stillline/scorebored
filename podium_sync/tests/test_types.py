"""Clock math at known instants. ``time.monotonic`` is patched so every
derivation is checked against an exact drift, never a sleep."""

import unittest
from datetime import datetime, timezone
from unittest import mock

from podium import parse
from podium.types import Anchor, Clock, Penalty, Timeout

from . import fixtures

T0 = 1000.0
SERVER_NOW = datetime(2026, 8, 29, 21, 35, 0, tzinfo=timezone.utc)


def anchor():
    return Anchor(server_now=SERVER_NOW, received_at=T0)


def at(seconds_later):
    return mock.patch("podium.types.time.monotonic", return_value=T0 + seconds_later)


def clock(rules=None, **changes):
    raw = dict(fixtures.GAME["clock"])
    raw.update(changes)
    return parse.parse_clock(raw, anchor(), parse.parse_rules(rules or fixtures.RULES))


class RegulationClockTest(unittest.TestCase):
    def test_counts_down_from_the_anchor_while_running(self):
        c = clock()
        with at(1.5):
            self.assertEqual(c.remaining_ms(), 238500)
            self.assertEqual(c.elapsed_ms(), 481500)
            self.assertEqual(c.next_change_in_ms(), 500)
            self.assertEqual(c.formatted(), "3:59")

    def test_holds_still_when_stopped(self):
        c = clock(running=False, running_since=None)
        with at(90):
            self.assertEqual(c.remaining_ms(), 240000)
            self.assertEqual(c.elapsed_ms(), 480000)
            self.assertIsNone(c.next_change_in_ms())

    def test_clamps_at_zero_and_caps_elapsed(self):
        c = clock(remaining_ms=1200, elapsed_ms=718800)
        with at(5):
            self.assertEqual(c.remaining_ms(), 0)
            self.assertEqual(c.elapsed_ms(), 720000)
            self.assertIsNone(c.next_change_in_ms())
            self.assertEqual(c.formatted(), "0:00")

    def test_exact_second_boundary_reports_a_full_second(self):
        c = clock()
        with at(0):
            self.assertEqual(c.next_change_in_ms(), 1000)

    def test_a_countdown_ceils_so_it_agrees_with_the_scoreboard(self):
        # The app's own hook ceils a countdown: 0:01 stays up until zero.
        # Flooring here would read a second low for all but the boundary.
        c = clock(remaining_ms=5000, elapsed_ms=715_000)
        for drift, expected in ((0, "0:05"), (0.001, "0:05"), (0.999, "0:05"), (1.0, "0:04")):
            with at(drift):
                self.assertEqual(c.formatted(), expected, f"at +{drift}s")

    def test_the_last_second_shows_0_01_until_zero(self):
        c = clock(remaining_ms=1000, elapsed_ms=719_000)
        with at(0.5):
            self.assertEqual(c.remaining_ms(), 500)
            self.assertEqual(c.formatted(), "0:01")
        with at(1.0):
            self.assertEqual(c.remaining_ms(), 0)
            self.assertEqual(c.formatted(), "0:00")

    def test_overtime_floors_because_it_counts_up(self):
        c = clock(phase="overtime", remaining_ms=5000, elapsed_ms=725_000)
        for drift, expected in ((0, "+0:05"), (0.999, "+0:05"), (1.0, "+0:06")):
            with at(drift):
                self.assertEqual(c.formatted(), expected, f"at +{drift}s")


class StoppageWindowTest(unittest.TestCase):
    """The client answers "would a whistle stop the clock" so an overlay
    never reimplements the rule."""

    def test_outside_the_window_a_whistle_leaves_the_clock_running(self):
        c = clock()  # 4:00 left, running
        with at(0):
            self.assertFalse(c.in_stoppage_window())
            self.assertFalse(c.whistle_stops_clock())

    def test_inside_the_last_two_minutes_a_whistle_stops_it(self):
        c = clock(remaining_ms=120_000, elapsed_ms=600_000)
        with at(0):
            self.assertTrue(c.in_stoppage_window())
            self.assertTrue(c.whistle_stops_clock())

    def test_a_stopped_clock_is_in_the_window_but_no_whistle_stops_it(self):
        c = clock(remaining_ms=60_000, elapsed_ms=660_000, running=False, running_since=None)
        with at(0):
            self.assertTrue(c.in_stoppage_window())
            self.assertFalse(c.whistle_stops_clock())

    def test_the_window_opens_as_the_clock_runs_down_to_it(self):
        c = clock(remaining_ms=121_000, elapsed_ms=599_000)
        with at(0.5):
            self.assertFalse(c.in_stoppage_window())
        with at(1.0):
            self.assertTrue(c.in_stoppage_window())

    def test_stop_clock_off_means_no_window_at_all(self):
        rules = dict(fixtures.RULES, stop_clock_final_two=False)
        c = clock(rules=rules, remaining_ms=30_000, elapsed_ms=690_000)
        with at(0):
            self.assertFalse(c.in_stoppage_window())
            self.assertFalse(c.whistle_stops_clock())

    def test_overtime_is_always_in_the_window(self):
        rules = dict(fixtures.RULES, stop_clock_final_two=False)
        c = clock(rules=rules, phase="overtime", remaining_ms=5_000, elapsed_ms=725_000)
        with at(0):
            self.assertTrue(c.in_stoppage_window())
            self.assertTrue(c.whistle_stops_clock())


class OvertimeClockTest(unittest.TestCase):
    def test_counts_up_without_bound(self):
        c = clock(phase="overtime", remaining_ms=30000, elapsed_ms=750000)
        with at(2.25):
            self.assertEqual(c.remaining_ms(), 32250)
            self.assertEqual(c.elapsed_ms(), 752250)
            self.assertEqual(c.next_change_in_ms(), 750)
            self.assertEqual(c.formatted(), "+0:32")


class PenaltyTest(unittest.TestCase):
    def penalty(self, c, **changes):
        raw = dict(fixtures.GAME["penalties"][0])
        raw.update(changes)
        return parse.parse_penalty(raw, c)

    def test_counts_down_on_the_game_clock_axis(self):
        # issued at 470_000, 45_000 long: ends at 515_000 elapsed.
        p = self.penalty(clock())
        with at(0):
            self.assertEqual(p.remaining_ms(), 35000)
            self.assertTrue(p.active())
            self.assertEqual(p.next_change_in_ms(), 1000)
        with at(10.4):
            self.assertEqual(p.remaining_ms(), 24600)
            self.assertEqual(p.next_change_in_ms(), 600)
        with at(40):
            self.assertEqual(p.remaining_ms(), 0)
            self.assertFalse(p.active())

    def test_seconds_left_ceil_like_the_game_clock(self):
        p = self.penalty(clock())
        with at(10.4):
            self.assertEqual(p.remaining_ms(), 24600)
            self.assertEqual(p.remaining_seconds(), 25)

    def test_freezes_while_the_clock_is_stopped(self):
        p = self.penalty(clock(running=False, running_since=None))
        with at(60):
            self.assertEqual(p.remaining_ms(), 35000)
            self.assertTrue(p.active())
            self.assertTrue(p.frozen())
            self.assertIsNone(p.next_change_in_ms())

    def test_not_frozen_while_the_clock_runs(self):
        p = self.penalty(clock())
        with at(0):
            self.assertTrue(p.active())
            self.assertFalse(p.frozen())

    def test_ended_and_untimed_penalties_have_nothing_left(self):
        with at(0):
            self.assertEqual(self.penalty(clock(), ended_elapsed_ms=480000, ended_reason="goal").remaining_ms(), 0)
            turnover = parse.parse_penalty(fixtures.GAME["penalties"][1], clock())
            self.assertFalse(turnover.timed)
            self.assertEqual(turnover.remaining_ms(), 0)
            self.assertEqual(self.penalty(None).remaining_ms(), 0)


class TimeoutTest(unittest.TestCase):
    def test_runs_on_the_wall_clock(self):
        t = parse.parse_timeout(fixtures.GAME["timeouts"][0], anchor())
        # ends 110s after server_now
        with at(0):
            self.assertEqual(t.remaining_ms(), 110000)
        with at(30.3):
            self.assertEqual(t.remaining_ms(), 79700)
            self.assertEqual(t.remaining_seconds(), 80)
            self.assertEqual(t.next_change_in_ms(), 700)
        with at(200):
            self.assertEqual(t.remaining_ms(), 0)
            self.assertFalse(t.active())
            self.assertIsNone(t.next_change_in_ms())

    def test_keeps_counting_while_the_game_clock_is_stopped(self):
        game = parse.parse_game(dict(fixtures.GAME, clock=fixtures.STOPPED_CLOCK), anchor())
        with at(5):
            self.assertEqual(game.running_timeout().remaining_ms(), 105000)
            self.assertEqual(game.clock.remaining_ms(), 239000)

    def test_ends_when_play_resumes_before_its_time(self):
        resumed = dict(fixtures.GAME["timeouts"][0], ended_reason="resumed")
        game = parse.parse_game(dict(fixtures.GAME, timeouts=[resumed]), anchor())
        with at(5):
            t = game.timeouts[0]
            self.assertEqual(t.remaining_ms(), 0)
            self.assertFalse(t.active())
            self.assertIsNone(t.next_change_in_ms())
            self.assertIsNone(game.running_timeout())
            # Ended early still spends the allowance.
            self.assertEqual(game.timeouts_used("home"), 1)


class AnchorTest(unittest.TestCase):
    def test_types_are_frozen(self):
        c = clock()
        with self.assertRaises(Exception):
            c.running = False  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
