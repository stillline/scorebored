"""Recorded-shape frames, trimmed to what the tests assert on. Field names
and nesting match the wire reference exactly; values are small and stable."""

import copy

SERVER_NOW = "2026-08-29T21:35:00.000Z"

RECORD = {
    "wins": 4,
    "losses": 1,
    "ties": 0,
    "byes": 0,
    "points": 8,
    "goals_for": 21,
    "goals_against": 9,
    "games_played": 5,
}

RULES = {
    "game_seconds": 720,
    "time_tracking": True,
    "stop_clock_final_two": True,
    "stoppage_window_ms": 120000,
    "timeouts_per_team": 2,
    "timeout_seconds": 120,
    "penalties_enabled": True,
    "minor_seconds": 45,
    "major_seconds": 120,
    "win_points": 2,
    "swiss_tiebreaker": "goals",
}

GAME = {
    "id": "game-1",
    "court": "2",
    "status": "in_progress",
    "round": "Round 4",
    "stage": {"kind": "group", "id": "group-a", "name": "Group A"},
    "series_game": None,
    "started_at": "2026-08-29T21:31:02.000Z",
    "ended_at": None,
    "home": {"team_id": "t-beavers", "name": "Beavers", "score": 4, "seed": 2, "record": RECORD},
    "away": {"team_id": "t-chum", "name": "Chum Bucket", "score": 2, "seed": 5, "record": RECORD},
    "clock": {
        "remaining_ms": 240000,
        "elapsed_ms": 480000,
        "running": True,
        "running_since": "2026-08-29T21:34:00.000Z",
        "phase": "regulation",
        "game_seconds": 720,
        "regulation_expired": False,
    },
    "rules": RULES,
    "goals": [
        {
            "id": "goal-1",
            "at": "2026-08-29T21:33:47.902Z",
            "elapsed_ms": 165000,
            "side": "home",
            "player": {"id": "p-priya", "name": "Priya S.", "club": "SEA"},
        },
        {"id": "goal-2", "at": "2026-08-29T21:34:10.000Z", "elapsed_ms": 188000, "side": "away", "player": None},
    ],
    "penalties": [
        {
            "id": "pen-1",
            "at": "2026-08-29T21:34:30.000Z",
            "side": "away",
            "severity": "minor",
            "player": {"id": "p-pablo", "name": "Pablo R.", "club": None},
            "issued_elapsed_ms": 470000,
            "duration_ms": 45000,
            "ended_elapsed_ms": None,
            "ended_reason": None,
        },
        {
            "id": "pen-2",
            "at": "2026-08-29T21:32:00.000Z",
            "side": "home",
            "severity": "turnover",
            "player": None,
            "issued_elapsed_ms": 300000,
            "duration_ms": None,
            "ended_elapsed_ms": None,
            "ended_reason": None,
        },
    ],
    "timeouts": [
        {
            "id": "to-1",
            "at": "2026-08-29T21:34:50.000Z",
            "side": "home",
            "duration_ms": 120000,
            "ends_at": "2026-08-29T21:36:50.000Z",
            "ended_reason": None,
        }
    ],
}

MATCH = {
    "id": "m-9",
    "game_number": 9,
    "round": 1,
    "slot": 0,
    "label": "Losers Bracket Round 1",
    "status": "scheduled",
    "home": {"team": None, "seed": None, "score": None, "label": "Loser of Game 1"},
    "away": {"team": None, "seed": None, "score": None, "label": "Loser of Game 2"},
    "winner": None,
    "winner_to": {"match_id": "m-13", "game_number": 13, "slot": "home"},
    "loser_to": None,
    "home_from": {"match_id": "m-1", "game_number": 1, "result": "loser"},
    "away_from": {"match_id": "m-2", "game_number": 2, "result": "loser"},
    "court": None,
    "game_id": None,
    "series": [],
}

TOURNAMENT = {
    "id": "tourn-1",
    "slug": "esq-2026",
    "name": "Emerald City Open 2026",
    "status": "active",
    "timezone": "America/Los_Angeles",
    "starts_on": "2026-08-29",
    "ends_on": "2026-08-30",
    "game_seconds": 720,
    "rules": RULES,
    "court": {
        "id": "court-2",
        "name": "2",
        "game_id": "game-1",
        "on_deck": {
            "game_id": "game-2",
            "game_number": None,
            "status": "scheduled",
            "round": "Round 4",
            "stage": {"kind": "group", "id": "group-a", "name": "Group A"},
            "home": {"team_id": "t-sas", "name": "Sasquatch"},
            "away": {"team_id": "t-karls", "name": "Hot Karls"},
        },
        "in_the_hole": None,
    },
    "courts": [{"id": "court-1", "name": "1", "active": True}, {"id": "court-2", "name": "2", "active": True}],
    "teams": [{"id": "t-beavers", "name": "Beavers", "seed": 1}, {"id": "t-chum", "name": "Chum Bucket", "seed": 2}],
    "completed_games": [
        {
            "id": "game-0",
            "started_at": "2026-08-29T20:00:00.000Z",
            "ended_at": "2026-08-29T20:14:30.250Z",
            "round": "Round 3",
            "stage": {"kind": "group", "id": "group-a", "name": "Group A"},
            "home": {"team_id": "t-beavers", "name": "Beavers", "score": 5},
            "away": {"team_id": "t-karls", "name": "Hot Karls", "score": 2},
        }
    ],
    "stages": [
        {
            "kind": "group",
            "id": "group-a",
            "name": "Group A",
            "state": "live",
            "total_rounds": 5,
            "current_round": 4,
            "teams": [
                {
                    "team_id": "t-beavers",
                    "name": "Beavers",
                    "seed": 1,
                    "position": 1,
                    "wins": 4,
                    "losses": 1,
                    "ties": 0,
                    "byes": 0,
                    "points": 8,
                    "goals_for": 21,
                    "goals_against": 9,
                    "goal_differential": 12,
                    "games_played": 5,
                }
            ],
        }
    ],
    "brackets": [
        {
            "id": "bset-1",
            "name": "Championship",
            "format": "double",
            "team_count": 8,
            "state": "live",
            "brackets": [
                {"id": "b-w", "role": "winners", "state": "complete", "current": False, "rounds": []},
                {
                    "id": "b-l",
                    "role": "losers",
                    "state": "live",
                    "current": True,
                    "rounds": [{"round": 1, "name": "Losers Bracket Round 1", "matches": [MATCH, None]}],
                },
                {"id": "b-f", "role": "finals", "state": "pending", "current": False, "rounds": []},
            ],
        }
    ],
}

BRACKET_HTML = {
    "bset-1": {
        "name": "Championship",
        "format": "double",
        "state": "live",
        "brackets": [
            {"id": "b-w", "role": "winners", "state": "complete", "current": False, "html": '<div class="pdm-bracket"></div>'},
            {"id": "b-l", "role": "losers", "state": "live", "current": True, "html": '<div class="pdm-bracket"></div>'},
        ],
    }
}


def subscribe_reply(frame_id="1", game=GAME):
    return {
        "id": frame_id,
        "ok": True,
        "server_now": SERVER_NOW,
        "data": {"tournament": copy.deepcopy(TOURNAMENT), "game": copy.deepcopy(game)},
    }


def game_push(trigger, event, server_now=SERVER_NOW, **changes):
    game = copy.deepcopy(GAME)
    game.update(changes)
    return {
        "push": "game",
        "trigger": trigger,
        "event": event,
        "data": game,
        "server_now": server_now,
        "tournament": "esq-2026",
        "court": "2",
    }


def tournament_push(trigger, server_now=SERVER_NOW):
    return {
        "push": "tournament",
        "trigger": trigger,
        "event": None,
        "data": copy.deepcopy(TOURNAMENT),
        "server_now": server_now,
        "tournament": "esq-2026",
        "court": "2",
    }


GOAL_EVENT = {
    "id": "goal-3",
    "at": "2026-08-29T21:35:00.500Z",
    "elapsed_ms": 240500,
    "side": "home",
    "player": {"id": "p-priya", "name": "Priya S.", "club": "SEA"},
}

STOPPED_CLOCK = {
    "remaining_ms": 239000,
    "elapsed_ms": 481000,
    "running": False,
    "running_since": None,
    "phase": "regulation",
    "game_seconds": 720,
    "regulation_expired": False,
}
