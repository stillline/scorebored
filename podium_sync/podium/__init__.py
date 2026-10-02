"""Podium live stream client — standard library only.

    from podium import PodiumClient, State, Goal

    client = PodiumClient(key="pk_live_…", tournament="esq-2026", court="2")

    @client.on_goal
    def goal(state: State, event: Goal) -> None:
        draw_scorebug(state.game)

    client.start()   # returns immediately

Wire reference: ``../wire.md``. Integration modes: ``../integration.md``.
"""

from .client import (
    DEFAULT_URL,
    GAME_TRIGGERS,
    TOURNAMENT_TRIGGERS,
    TRIGGERS,
    Event,
    PodiumClient,
    PodiumError,
)
from .transport import ConnectionClosed, WebSocketError
from .types import (
    Anchor,
    Bracket,
    BracketHTML,
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
    RenderedBracketSet,
    Rules,
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

__all__ = [
    "DEFAULT_URL",
    "GAME_TRIGGERS",
    "TOURNAMENT_TRIGGERS",
    "TRIGGERS",
    "Anchor",
    "Bracket",
    "BracketHTML",
    "BracketMatch",
    "BracketRound",
    "BracketSet",
    "Clock",
    "CompletedGame",
    "ConnectionClosed",
    "Court",
    "CourtRef",
    "Event",
    "Game",
    "Goal",
    "MatchLink",
    "MatchSide",
    "MatchSource",
    "Penalty",
    "Player",
    "PodiumClient",
    "PodiumError",
    "QueueItem",
    "Record",
    "RenderedBracket",
    "RenderedBracketSet",
    "Rules",
    "ScoreLine",
    "SeriesGame",
    "Stage",
    "StageRef",
    "StandingRow",
    "State",
    "Team",
    "TeamEntry",
    "TeamRef",
    "Timeout",
    "Tournament",
    "WebSocketError",
]
