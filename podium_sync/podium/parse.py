"""Wire JSON → the types in ``podium.types``.

One function per payload. Every parser takes the decoded JSON and the
``Anchor`` of the frame it came from, so the clocks it builds know when
their values were true.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Dict, Optional

from .types import (
    Anchor,
    Bracket,
    BracketMatch,
    BracketRound,
    BracketSet,
    Clock,
    CompletedGame,
    Court,
    CourtRef,
    Game,
    Goal,
    MatchLink,
    MatchSide,
    MatchSource,
    Penalty,
    Player,
    QueueItem,
    Record,
    RenderedBracket,
    Rules,
    RenderedBracketSet,
    ScoreLine,
    SeriesGame,
    Stage,
    StageRef,
    StandingRow,
    State,
    Team,
    TeamEntry,
    TeamRef,
    Timeout,
    Tournament,
)

GAME_TRIGGERS = frozenset({"game_started", "game_finished", "game_changed"})
GOAL_TRIGGERS = frozenset({"goal", "goal_removed"})
CLOCK_TRIGGERS = frozenset({"clock_started", "clock_stopped", "clock_adjusted", "period_changed"})
PENALTY_TRIGGERS = frozenset({"penalty", "penalty_ended"})
TIMEOUT_TRIGGERS = frozenset({"timeout"})
TOURNAMENT_TRIGGERS = frozenset(
    {"standings_changed", "queue_changed", "structure_changed", "tournament_changed"}
)


def parse_datetime(value: Optional[str]) -> Optional[datetime]:
    """ISO 8601 with a ``Z`` suffix → aware UTC datetime (Python 3.9-safe)."""
    if value is None:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_date(value: Optional[str]) -> Optional[date]:
    return date.fromisoformat(value) if value else None


def parse_state(data: Dict[str, Any], anchor: Anchor) -> State:
    """The ``data`` of a subscribe reply."""
    return State(
        tournament=parse_tournament(data["tournament"]),
        game=parse_game(data.get("game"), anchor),
        anchor=anchor,
    )


# --- game ---


def parse_player(raw: Optional[Dict[str, Any]]) -> Optional[Player]:
    if raw is None:
        return None
    return Player(id=raw["id"], name=raw["name"], club=raw.get("club"))


def parse_record(raw: Dict[str, Any]) -> Record:
    return Record(
        wins=raw["wins"],
        losses=raw["losses"],
        ties=raw["ties"],
        byes=raw.get("byes", 0),
        points=raw["points"],
        goals_for=raw["goals_for"],
        goals_against=raw["goals_against"],
        games_played=raw.get("games_played", 0),
    )


def parse_team(raw: Dict[str, Any]) -> Team:
    return Team(
        team_id=raw.get("team_id"),
        name=raw["name"],
        score=raw.get("score"),
        seed=raw.get("seed"),
        record=parse_record(raw["record"]),
    )


def parse_stage_ref(raw: Optional[Dict[str, Any]]) -> Optional[StageRef]:
    if raw is None:
        return None
    return StageRef(kind=raw["kind"], id=raw["id"], name=raw["name"])


def parse_rules(raw: Dict[str, Any]) -> Rules:
    return Rules(
        game_seconds=raw["game_seconds"],
        time_tracking=raw["time_tracking"],
        stop_clock_final_two=raw["stop_clock_final_two"],
        stoppage_window_ms=raw["stoppage_window_ms"],
        timeouts_per_team=raw["timeouts_per_team"],
        timeout_seconds=raw["timeout_seconds"],
        penalties_enabled=raw["penalties_enabled"],
        minor_seconds=raw["minor_seconds"],
        major_seconds=raw["major_seconds"],
        win_points=raw["win_points"],
        swiss_tiebreaker=raw["swiss_tiebreaker"],
    )


def parse_clock(
    raw: Optional[Dict[str, Any]], anchor: Anchor, rules: Optional[Rules] = None
) -> Optional[Clock]:
    if raw is None:
        return None
    return Clock(
        rules=rules,
        anchor=anchor,
        anchor_remaining_ms=raw["remaining_ms"],
        anchor_elapsed_ms=raw["elapsed_ms"],
        running=raw["running"],
        running_since=parse_datetime(raw.get("running_since")),
        phase=raw["phase"],
        game_seconds=raw["game_seconds"],
        regulation_expired=raw.get("regulation_expired", False),
    )


def parse_goal(raw: Dict[str, Any]) -> Goal:
    return Goal(
        id=raw["id"],
        at=parse_datetime(raw.get("at")),  # type: ignore[arg-type]
        elapsed_ms=raw.get("elapsed_ms"),
        side=raw.get("side"),
        player=parse_player(raw.get("player")),
    )


def parse_penalty(raw: Dict[str, Any], clock: Optional[Clock]) -> Penalty:
    return Penalty(
        id=raw["id"],
        at=parse_datetime(raw["at"]),  # type: ignore[arg-type]
        side=raw.get("side"),
        severity=raw["severity"],
        player=parse_player(raw.get("player")),
        issued_elapsed_ms=raw.get("issued_elapsed_ms"),
        duration_ms=raw.get("duration_ms"),
        ended_elapsed_ms=raw.get("ended_elapsed_ms"),
        ended_reason=raw.get("ended_reason"),
        clock=clock,
    )


def parse_timeout(raw: Dict[str, Any], anchor: Anchor) -> Timeout:
    return Timeout(
        id=raw["id"],
        at=parse_datetime(raw["at"]),  # type: ignore[arg-type]
        side=raw.get("side"),
        duration_ms=raw["duration_ms"],
        ends_at=parse_datetime(raw["ends_at"]),  # type: ignore[arg-type]
        ended_reason=raw.get("ended_reason"),
        anchor=anchor,
    )


def parse_game(raw: Optional[Dict[str, Any]], anchor: Anchor) -> Optional[Game]:
    if raw is None:
        return None
    rules = parse_rules(raw["rules"])
    clock = parse_clock(raw.get("clock"), anchor, rules)
    return Game(
        id=raw["id"],
        court=raw.get("court"),
        status=raw["status"],
        round=raw.get("round"),
        stage=parse_stage_ref(raw.get("stage")),
        series_game=raw.get("series_game"),
        started_at=parse_datetime(raw.get("started_at")),
        ended_at=parse_datetime(raw.get("ended_at")),
        home=parse_team(raw["home"]),
        away=parse_team(raw["away"]),
        clock=clock,
        rules=rules,
        goals=tuple(parse_goal(g) for g in raw.get("goals", [])),
        penalties=tuple(parse_penalty(p, clock) for p in raw.get("penalties", [])),
        timeouts=tuple(parse_timeout(t, anchor) for t in raw.get("timeouts", [])),
    )


# --- tournament ---


def parse_team_ref(raw: Dict[str, Any]) -> TeamRef:
    return TeamRef(team_id=raw.get("team_id"), name=raw["name"])


def parse_queue_item(raw: Optional[Dict[str, Any]]) -> Optional[QueueItem]:
    if raw is None:
        return None
    return QueueItem(
        game_id=raw.get("game_id"),
        game_number=raw.get("game_number"),
        status=raw["status"],
        round=raw.get("round"),
        stage=parse_stage_ref(raw.get("stage")),
        home=parse_team_ref(raw["home"]),
        away=parse_team_ref(raw["away"]),
    )


def parse_court(raw: Dict[str, Any]) -> Court:
    return Court(
        id=raw["id"],
        name=raw["name"],
        game_id=raw.get("game_id"),
        on_deck=parse_queue_item(raw.get("on_deck")),
        in_the_hole=parse_queue_item(raw.get("in_the_hole")),
    )


def parse_score_line(raw: Dict[str, Any]) -> ScoreLine:
    return ScoreLine(team_id=raw.get("team_id"), name=raw["name"], score=raw.get("score"))


def parse_completed_game(raw: Dict[str, Any]) -> CompletedGame:
    return CompletedGame(
        id=raw["id"],
        started_at=parse_datetime(raw.get("started_at")),
        ended_at=parse_datetime(raw.get("ended_at")),
        round=raw.get("round"),
        stage=parse_stage_ref(raw.get("stage")),
        home=parse_score_line(raw["home"]),
        away=parse_score_line(raw["away"]),
    )


def parse_standing_row(raw: Dict[str, Any]) -> StandingRow:
    return StandingRow(
        team_id=raw["team_id"],
        name=raw["name"],
        seed=raw.get("seed"),
        position=raw["position"],
        wins=raw["wins"],
        losses=raw["losses"],
        ties=raw["ties"],
        byes=raw.get("byes", 0),
        points=raw["points"],
        goals_for=raw["goals_for"],
        goals_against=raw["goals_against"],
        goal_differential=raw["goal_differential"],
        games_played=raw.get("games_played", 0),
    )


def parse_stage(raw: Dict[str, Any]) -> Stage:
    return Stage(
        kind=raw["kind"],
        id=raw["id"],
        name=raw["name"],
        state=raw["state"],
        total_rounds=raw.get("total_rounds") or 0,
        current_round=raw.get("current_round"),
        teams=tuple(parse_standing_row(r) for r in raw.get("teams", [])),
    )


def parse_match_side(raw: Dict[str, Any]) -> MatchSide:
    team = raw.get("team")
    return MatchSide(
        team=parse_team_ref(team) if team else None,
        seed=raw.get("seed"),
        score=raw.get("score"),
        label=raw.get("label"),
    )


def parse_link(raw: Optional[Dict[str, Any]]) -> Optional[MatchLink]:
    if raw is None:
        return None
    return MatchLink(match_id=raw["match_id"], game_number=raw.get("game_number"), slot=raw["slot"])


def parse_source(raw: Optional[Dict[str, Any]]) -> Optional[MatchSource]:
    if raw is None:
        return None
    return MatchSource(match_id=raw["match_id"], game_number=raw.get("game_number"), result=raw["result"])


def parse_match(raw: Optional[Dict[str, Any]]) -> Optional[BracketMatch]:
    if raw is None:
        return None
    return BracketMatch(
        id=raw["id"],
        game_number=raw.get("game_number"),
        round=raw["round"],
        slot=raw["slot"],
        label=raw["label"],
        status=raw["status"],
        home=parse_match_side(raw["home"]),
        away=parse_match_side(raw["away"]),
        winner=raw.get("winner"),
        winner_to=parse_link(raw.get("winner_to")),
        loser_to=parse_link(raw.get("loser_to")),
        home_from=parse_source(raw.get("home_from")),
        away_from=parse_source(raw.get("away_from")),
        court=raw.get("court"),
        game_id=raw.get("game_id"),
        series=tuple(
            SeriesGame(
                game_id=s["game_id"],
                game=s.get("game"),
                home_score=s.get("home_score"),
                away_score=s.get("away_score"),
                status=s["status"],
            )
            for s in raw.get("series", [])
        ),
    )


def parse_bracket(raw: Dict[str, Any]) -> Bracket:
    return Bracket(
        id=raw["id"],
        role=raw["role"],
        state=raw["state"],
        current=raw.get("current", False),
        rounds=tuple(
            BracketRound(
                round=r["round"],
                name=r["name"],
                matches=tuple(parse_match(m) for m in r["matches"]),
            )
            for r in raw.get("rounds", [])
        ),
    )


def parse_bracket_set(raw: Dict[str, Any]) -> BracketSet:
    return BracketSet(
        id=raw["id"],
        name=raw["name"],
        format=raw["format"],
        team_count=raw.get("team_count") or 0,
        state=raw["state"],
        brackets=tuple(parse_bracket(b) for b in raw.get("brackets", [])),
    )


def parse_tournament(raw: Dict[str, Any]) -> Tournament:
    return Tournament(
        id=raw["id"],
        slug=raw["slug"],
        name=raw["name"],
        status=raw["status"],
        timezone=raw.get("timezone") or "Etc/UTC",
        starts_on=parse_date(raw.get("starts_on")),
        ends_on=parse_date(raw.get("ends_on")),
        game_seconds=raw["game_seconds"],
        rules=parse_rules(raw["rules"]),
        court=parse_court(raw["court"]),
        courts=tuple(CourtRef(id=c["id"], name=c["name"], active=c.get("active", True)) for c in raw.get("courts", [])),
        teams=tuple(TeamEntry(id=t["id"], name=t["name"], seed=t.get("seed")) for t in raw.get("teams", [])),
        completed_games=tuple(parse_completed_game(g) for g in raw.get("completed_games", [])),
        stages=tuple(parse_stage(s) for s in raw.get("stages", [])),
        brackets=tuple(parse_bracket_set(b) for b in raw.get("brackets", [])),
    )


# --- events and the bracket op ---


def parse_event(trigger: str, raw: Any, anchor: Anchor, game: Optional[Game]) -> Any:
    """The typed ``event`` of a push. Its type is fixed per trigger."""
    if raw is None:
        return None
    if trigger in GAME_TRIGGERS:
        return parse_game(raw, anchor)
    if trigger in GOAL_TRIGGERS:
        return parse_goal(raw)
    if trigger in CLOCK_TRIGGERS:
        # Carry the game's rules onto the event too, so a handler that only
        # looks at `event` can still ask whether a whistle would stop it.
        return parse_clock(raw, anchor, game.rules if game else None)
    if trigger in PENALTY_TRIGGERS:
        return parse_penalty(raw, game.clock if game else None)
    if trigger in TIMEOUT_TRIGGERS:
        return parse_timeout(raw, anchor)
    return raw


def parse_bracket_html(data: Dict[str, Any]) -> Dict[str, RenderedBracketSet]:
    return {
        set_id: RenderedBracketSet(
            name=raw["name"],
            format=raw["format"],
            state=raw["state"],
            brackets=tuple(
                RenderedBracket(
                    id=b["id"],
                    role=b["role"],
                    state=b["state"],
                    current=b.get("current", False),
                    html=b["html"],
                )
                for b in raw["brackets"]
            ),
        )
        for set_id, raw in data.items()
    }
