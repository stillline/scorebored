import unittest
from datetime import date, datetime, timezone
from unittest import mock

from podium import parse
from podium.types import Anchor, Clock, Game, Goal, Penalty, State, Timeout

from . import fixtures


def anchor():
    return Anchor(server_now=parse.parse_datetime(fixtures.SERVER_NOW), received_at=0.0)


class DatetimeTest(unittest.TestCase):
    def test_z_suffix_and_milliseconds(self):
        parsed = parse.parse_datetime("2026-08-29T21:33:47.902Z")
        self.assertEqual(parsed, datetime(2026, 8, 29, 21, 33, 47, 902000, tzinfo=timezone.utc))
        self.assertIsNone(parse.parse_datetime(None))
        self.assertEqual(parse.parse_date("2026-08-29"), date(2026, 8, 29))


class StateTest(unittest.TestCase):
    def setUp(self):
        self.state = parse.parse_state(fixtures.subscribe_reply()["data"], anchor())

    def test_shape(self):
        self.assertIsInstance(self.state, State)
        self.assertEqual(self.state.tournament.slug, "esq-2026")
        self.assertEqual(self.state.tournament.timezone, "America/Los_Angeles")
        self.assertEqual(self.state.tournament.starts_on, date(2026, 8, 29))
        self.assertEqual(self.state.server_now, anchor().server_now)

    def test_game(self):
        game = self.state.game
        self.assertIsInstance(game, Game)
        self.assertEqual(game.home.name, "Beavers")
        self.assertEqual(game.home.score, 4)
        self.assertEqual(str(game.home.record), "4-1")
        self.assertEqual(game.started_at.minute, 31)
        self.assertIsInstance(game.clock, Clock)
        self.assertEqual(game.clock.anchor_remaining_ms, 240000)
        self.assertEqual(len(game.goals), 2)
        self.assertEqual(game.goals[0].player.name, "Priya S.")
        self.assertIsNone(game.goals[1].player)
        self.assertEqual([p.severity for p in game.penalties], ["minor", "turnover"])
        self.assertIs(game.penalties[0].clock, game.clock)
        self.assertEqual(game.timeouts[0].ends_at.minute, 36)

    def test_rules_ride_on_both_the_tournament_and_the_game(self):
        for rules in (self.state.tournament.rules, self.state.game.rules):
            self.assertEqual(rules.timeouts_per_team, 2)
            self.assertEqual(rules.timeout_seconds, 120)
            self.assertTrue(rules.stop_clock_final_two)
            self.assertEqual(rules.stoppage_window_ms, 120000)
            self.assertEqual(rules.minor_seconds, 45)
            self.assertEqual(rules.win_points, 2)
            self.assertEqual(rules.swiss_tiebreaker, "goals")

    def test_timeouts_left_needs_the_rules(self):
        game = self.state.game
        # The fixture has one home timeout out of an allowance of two.
        self.assertEqual(game.timeouts_used("home"), 1)
        self.assertEqual(game.timeouts_left("home"), 1)
        self.assertEqual(game.timeouts_used("away"), 0)
        self.assertEqual(game.timeouts_left("away"), 2)

    def test_state_reports_when_the_display_next_changes(self):
        # The game clock is running, a penalty is serving and a timeout is
        # draining: the soonest of the three wins, and the caller never has
        # to know which axes are live.
        with mock.patch("podium.types.time.monotonic", return_value=0.0):
            due = self.state.next_change_in_ms()
        self.assertIsNotNone(due)
        self.assertLessEqual(due, 1000)

    def test_nothing_ticking_reports_none(self):
        # Clock stopped, so the penalty rides a frozen axis, and no timeout.
        frozen = dict(fixtures.GAME, clock=fixtures.STOPPED_CLOCK, timeouts=[])
        state = parse.parse_state(fixtures.subscribe_reply(game=frozen)["data"], anchor())
        with mock.patch("podium.types.time.monotonic", return_value=0.0):
            self.assertTrue(state.game.penalties[0].frozen())
            self.assertIsNone(state.next_change_in_ms())

    def test_court_queue(self):
        court = self.state.tournament.court
        self.assertEqual(court.name, "2")
        self.assertEqual(court.game_id, "game-1")
        self.assertEqual(court.on_deck.home.name, "Sasquatch")
        self.assertIsNone(court.in_the_hole)

    def test_stages_and_completed_games(self):
        [stage] = self.state.tournament.stages
        self.assertEqual(stage.state, "live")
        self.assertEqual(stage.teams[0].position, 1)
        self.assertEqual(stage.teams[0].goal_differential, 12)
        [done] = self.state.tournament.completed_games
        self.assertEqual(done.ended_at.microsecond, 250000)
        self.assertEqual(done.home.score, 5)

    def test_brackets(self):
        [bset] = self.state.tournament.brackets
        self.assertEqual([b.role for b in bset.brackets], ["winners", "losers", "finals"])
        current = self.state.tournament.current_bracket()
        self.assertEqual(current.role, "losers")
        [round1] = current.rounds
        match, padding = round1.matches
        self.assertIsNone(padding)
        self.assertEqual(match.home.display(), "Loser of Game 1")
        self.assertEqual(match.winner_to.game_number, 13)
        self.assertEqual(match.home_from.result, "loser")


class EventTest(unittest.TestCase):
    def test_event_type_is_fixed_per_trigger(self):
        a = anchor()
        game = parse.parse_game(fixtures.GAME, a)

        self.assertIsInstance(parse.parse_event("goal", fixtures.GOAL_EVENT, a, game), Goal)
        self.assertIsInstance(parse.parse_event("goal_removed", fixtures.GOAL_EVENT, a, game), Goal)
        self.assertIsInstance(parse.parse_event("clock_stopped", fixtures.STOPPED_CLOCK, a, game), Clock)
        self.assertIsInstance(parse.parse_event("period_changed", fixtures.STOPPED_CLOCK, a, game), Clock)
        penalty = parse.parse_event("penalty", fixtures.GAME["penalties"][0], a, game)
        self.assertIsInstance(penalty, Penalty)
        self.assertIs(penalty.clock, game.clock)
        self.assertIsInstance(parse.parse_event("timeout", fixtures.GAME["timeouts"][0], a, game), Timeout)
        self.assertIsInstance(parse.parse_event("game_finished", fixtures.GAME, a, game), Game)
        self.assertIsNone(parse.parse_event("standings_changed", None, a, game))

    def test_bracket_html(self):
        rendered = parse.parse_bracket_html(fixtures.BRACKET_HTML)
        self.assertEqual(rendered["bset-1"].name, "Championship")
        self.assertTrue(rendered["bset-1"].brackets[1].current)
        self.assertIn("pdm-bracket", rendered["bset-1"].brackets[1].html)


if __name__ == "__main__":
    unittest.main()
