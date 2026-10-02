"""The wire, as Python types.

Every payload the stream sends is one of these frozen dataclasses. They are
the client-side schema: a field here is a field on the wire, with the same
name, and nothing here exists that the wire doesn't carry. Immutability is
the point — a ``State`` is a snapshot, and the reader thread never mutates
one after handing it out.

The three clocks (game clock, penalty, timeout) each derive their current
value from anchors on demand; nothing in this module owns a timer. See
``Clock``, ``Penalty`` and ``Timeout`` for the three formulas, and
``integration.md`` for the repaint-timer pattern that uses
``next_change_in_ms()``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class Anchor:
    """When a frame was produced and when we got it.

    ``server_now`` is the server's UTC clock at serialization. ``received_at``
    is ``time.monotonic()`` at receipt — monotonic on purpose: a Raspberry Pi
    has no RTC and its wall clock jumps when NTP syncs, so interpolation must
    never lean on ``time.time()``.
    """

    server_now: datetime
    received_at: float

    def drift_ms(self) -> int:
        """Milliseconds elapsed since this anchor was received."""
        return round((time.monotonic() - self.received_at) * 1000)


# --- people and teams ---


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    club: Optional[str]


@dataclass(frozen=True)
class Record:
    """A team's tournament record across every completed game so far."""

    wins: int
    losses: int
    ties: int
    byes: int
    points: int
    goals_for: int
    goals_against: int
    games_played: int

    def __str__(self) -> str:
        return f"{self.wins}-{self.losses}" + (f"-{self.ties}" if self.ties else "")


@dataclass(frozen=True)
class TeamRef:
    team_id: Optional[str]
    name: str


@dataclass(frozen=True)
class Team:
    """One side of a game."""

    team_id: Optional[str]
    name: str
    score: Optional[int]
    seed: Optional[int]
    record: Record


@dataclass(frozen=True)
class StageRef:
    kind: str  # "group" | "swiss" | "bracket"
    id: str
    name: str


@dataclass(frozen=True)
class Rules:
    """The rules in force. On the tournament these are its current defaults;
    on a game they are the snapshot that game is being played under, which
    doesn't move if an organizer changes a setting mid-tournament.

    ``stop_clock_final_two`` with ``stoppage_window_ms`` is what explains a
    clock that keeps running through a whistle: a goal or a penalty only
    stops it inside that window (overtime always stops it). A timeout stops
    it whatever the time — the team paid for the stoppage.
    """

    game_seconds: int
    time_tracking: bool
    stop_clock_final_two: bool
    stoppage_window_ms: int
    timeouts_per_team: int
    timeout_seconds: int
    penalties_enabled: bool
    minor_seconds: int
    major_seconds: int
    win_points: int
    swiss_tiebreaker: str  # "goals" | "strength"


# --- the three clocks ---


@dataclass(frozen=True)
class Clock:
    """The game clock, as anchors.

    ``remaining_ms``/``elapsed_ms`` below are the values *at the anchor*; call
    the methods for what to display right now. In ``phase == "regulation"``
    the clock counts down and clamps at zero. In ``phase == "overtime"``
    (golden goal) it counts **up** without bound — ``remaining_ms()`` is then
    the overtime elapsed, exactly as the server sends it, so don't render it
    as a countdown.
    """

    anchor: Anchor
    anchor_remaining_ms: int
    anchor_elapsed_ms: int
    running: bool
    running_since: Optional[datetime]
    phase: str  # "regulation" | "overtime"
    game_seconds: int
    regulation_expired: bool
    rules: Optional["Rules"] = field(default=None, compare=False, repr=False)

    def _moved_ms(self) -> int:
        return self.anchor.drift_ms() if self.running else 0

    def remaining_ms(self) -> int:
        """What the scoreboard shows now: regulation ms remaining (clamped at
        zero) or overtime ms elapsed."""
        if self.phase == "overtime":
            return self.anchor_remaining_ms + self._moved_ms()
        return max(self.anchor_remaining_ms - self._moved_ms(), 0)

    def elapsed_ms(self) -> int:
        """Total game time played now, on the axis penalties are stamped on.
        Regulation caps at the game length; overtime keeps going."""
        game_ms = self.game_seconds * 1000
        if self.phase == "overtime":
            return self.anchor_elapsed_ms + self._moved_ms()
        return min(self.anchor_elapsed_ms + self._moved_ms(), game_ms)

    def next_change_in_ms(self) -> Optional[int]:
        """How long until the whole-second reading changes, or ``None`` when
        the clock isn't moving. Drive a repaint timer off this so seconds
        flip on the boundary instead of stuttering."""
        if not self.running:
            return None
        if self.phase == "overtime":
            return 1000 - (self.remaining_ms() % 1000)
        remaining = self.remaining_ms()
        if remaining == 0:
            return None
        return remaining % 1000 or 1000

    def remaining_seconds(self) -> int:
        """The whole seconds to put on screen.

        A countdown **ceils**: 0:01 stays up until the clock truly reaches
        zero, so a flooring display reads a second low for all but the exact
        boundary. Overtime counts up and so **floors**. This is what Podium's
        own scoreboard does; match it or your overlay disagrees with the
        scorekeeper's phone.
        """
        ms = self.remaining_ms()
        if self.phase == "overtime":
            return ms // 1000
        return -(-ms // 1000)

    def formatted(self) -> str:
        """``M:SS`` of ``remaining_seconds()``; overtime is prefixed ``+``."""
        secs = self.remaining_seconds()
        text = f"{secs // 60}:{secs % 60:02d}"
        return f"+{text}" if self.phase == "overtime" else text

    def in_stoppage_window(self) -> bool:
        """Whether the game has reached the point where whistles stop the
        clock — the last `stoppage_window_ms` of regulation, when the
        tournament runs stop-clock. Overtime is always in the window.

        Worth putting on screen: it tells the room the clock is about to
        start stopping.
        """
        if self.rules is None:
            return False
        if self.phase == "overtime":
            return True
        if not self.rules.stop_clock_final_two:
            return False
        return self.remaining_ms() <= self.rules.stoppage_window_ms

    def whistle_stops_clock(self) -> bool:
        """Whether a goal or a penalty *right now* would stop the clock.

        Mirrors the server's own rule, so an overlay never has to reimplement
        it: the clock must be running and the game in the stoppage window. A
        whistle outside that window leaves the clock running — which is
        correct, not a dropped `clock_stopped`. Timeouts are the exception;
        they always stop it.
        """
        return self.running and self.in_stoppage_window()


@dataclass(frozen=True)
class Goal:
    id: str
    at: datetime
    elapsed_ms: Optional[int]
    side: Optional[str]  # "home" | "away"
    player: Optional[Player]  # None for an unattributed goal


@dataclass(frozen=True)
class Penalty:
    """A penalty. Timed severities (minor, major, ejection) serve a window on
    the game-clock *elapsed* axis, from ``issued_elapsed_ms`` for
    ``duration_ms`` — so the countdown freezes whenever the game clock is
    stopped. ``ended_elapsed_ms`` is set once the window is over, early
    (``ended_reason == "goal"``: a Minor cleared by a goal against) or on
    time (``"expired"``). A ``turnover`` has no window at all.
    """

    id: str
    at: datetime
    side: Optional[str]
    severity: str  # "turnover" | "minor" | "major" | "ejection"
    player: Optional[Player]  # None for a team-level penalty
    issued_elapsed_ms: Optional[int]
    duration_ms: Optional[int]
    ended_elapsed_ms: Optional[int]
    ended_reason: Optional[str]  # "goal" | "expired" | None
    clock: Optional[Clock] = field(default=None, compare=False, repr=False)

    @property
    def timed(self) -> bool:
        return bool(self.duration_ms) and self.issued_elapsed_ms is not None

    def remaining_ms(self) -> int:
        """Milliseconds left in the advantage window right now; zero when
        untimed, ended, or the game has no clock."""
        if not self.timed or self.ended_elapsed_ms is not None or self.clock is None:
            return 0
        end = self.issued_elapsed_ms + self.duration_ms  # type: ignore[operator]
        return max(end - self.clock.elapsed_ms(), 0)

    def remaining_seconds(self) -> int:
        """Whole seconds left, ceiled — the countdown convention (see `Clock`)."""
        return -(-self.remaining_ms() // 1000)

    def active(self) -> bool:
        return self.remaining_ms() > 0

    def frozen(self) -> bool:
        """Still being served, but not counting down: the game clock is
        stopped and a penalty rides the game-clock axis. A timeout never
        freezes — it runs on the wall clock."""
        return self.active() and not (self.clock and self.clock.running)

    def next_change_in_ms(self) -> Optional[int]:
        """Until the whole-second reading changes; ``None`` while frozen."""
        if not self.active() or self.frozen():
            return None
        return self.remaining_ms() % 1000 or 1000


@dataclass(frozen=True)
class Timeout:
    """A timeout runs on the **wall clock**, independent of the game clock:
    from ``at`` for ``duration_ms``, ending at ``ends_at``. It keeps counting
    while the game clock is stopped (it always is, during a timeout), and it
    ends early the moment play resumes (``ended_reason == "resumed"``) — a
    team can go back on court before its time is up."""

    id: str
    at: datetime
    side: Optional[str]
    duration_ms: int
    ends_at: datetime
    ended_reason: Optional[str]  # "resumed" | "expired" | None
    anchor: Anchor = field(compare=False, repr=False)

    def remaining_ms(self) -> int:
        """Milliseconds left right now; zero once it has ended, early or on time."""
        if self.ended_reason is not None:
            return 0
        at_anchor = int((self.ends_at - self.anchor.server_now).total_seconds() * 1000)
        return max(at_anchor - self.anchor.drift_ms(), 0)

    def remaining_seconds(self) -> int:
        """Whole seconds left, ceiled — the countdown convention (see `Clock`)."""
        return -(-self.remaining_ms() // 1000)

    def active(self) -> bool:
        return self.remaining_ms() > 0

    def next_change_in_ms(self) -> Optional[int]:
        if not self.active():
            return None
        return self.remaining_ms() % 1000 or 1000


# --- the game ---


@dataclass(frozen=True)
class Game:
    id: str
    court: Optional[str]
    status: str  # "scheduled" | "in_progress" | "completed"
    round: Optional[str]
    stage: Optional[StageRef]
    series_game: Optional[int]
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    home: Team
    away: Team
    clock: Optional[Clock]  # None when the game has no armed clock
    rules: Rules  # this game's snapshot, not the tournament's current settings
    goals: Tuple[Goal, ...]
    penalties: Tuple[Penalty, ...]
    timeouts: Tuple[Timeout, ...]

    def active_penalties(self) -> Tuple[Penalty, ...]:
        return tuple(p for p in self.penalties if p.active())

    def running_timeout(self) -> Optional[Timeout]:
        for timeout in reversed(self.timeouts):
            if timeout.active():
                return timeout
        return None

    def timeouts_used(self, side: str) -> int:
        return sum(1 for t in self.timeouts if t.side == side)

    def timeouts_left(self, side: str) -> int:
        """How many timeouts ``"home"``/``"away"`` still has — the allowance
        from the game's rules minus what it has taken."""
        return max(self.rules.timeouts_per_team - self.timeouts_used(side), 0)


# --- the tournament ---


@dataclass(frozen=True)
class QueueItem:
    """What's on deck / in the hole for the court. ``home``/``away`` carry a
    team, or ``team_id=None`` and a label ("Winner of Game 3", "TBD")."""

    game_id: Optional[str]
    game_number: Optional[int]
    status: str
    round: Optional[str]
    stage: Optional[StageRef]
    home: TeamRef
    away: TeamRef


@dataclass(frozen=True)
class Court:
    id: str
    name: str
    game_id: Optional[str]
    on_deck: Optional[QueueItem]
    in_the_hole: Optional[QueueItem]


@dataclass(frozen=True)
class CourtRef:
    id: str
    name: str
    active: bool


@dataclass(frozen=True)
class TeamEntry:
    id: str
    name: str
    seed: Optional[int]


@dataclass(frozen=True)
class ScoreLine:
    team_id: Optional[str]
    name: str
    score: Optional[int]


@dataclass(frozen=True)
class CompletedGame:
    id: str
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    round: Optional[str]
    stage: Optional[StageRef]
    home: ScoreLine
    away: ScoreLine


@dataclass(frozen=True)
class StandingRow:
    """One row of a stage's table. ``position`` is provisional while the
    stage is live; tied teams share a position."""

    team_id: str
    name: str
    seed: Optional[int]
    position: int
    wins: int
    losses: int
    ties: int
    byes: int
    points: int
    goals_for: int
    goals_against: int
    goal_differential: int
    games_played: int


@dataclass(frozen=True)
class Stage:
    kind: str  # "group" | "swiss"
    id: str
    name: str
    state: str  # "pending" | "live" | "complete"
    total_rounds: int
    current_round: Optional[int]
    teams: Tuple[StandingRow, ...]


@dataclass(frozen=True)
class MatchSide:
    team: Optional[TeamRef]
    seed: Optional[int]
    score: Optional[int]
    label: Optional[str]  # "Winner of Game 3" / "Loser of Game 7" / "Bye" / "TBD" when team is None

    def display(self) -> str:
        return self.team.name if self.team else (self.label or "TBD")


@dataclass(frozen=True)
class MatchLink:
    match_id: str
    game_number: Optional[int]
    slot: str  # "home" | "away"


@dataclass(frozen=True)
class MatchSource:
    match_id: str
    game_number: Optional[int]
    result: str  # "winner" | "loser"


@dataclass(frozen=True)
class SeriesGame:
    game_id: str
    game: Optional[int]
    home_score: Optional[int]
    away_score: Optional[int]
    status: str


@dataclass(frozen=True)
class BracketMatch:
    id: str
    game_number: Optional[int]
    round: int
    slot: int
    label: str
    status: str  # "scheduled" | "in_progress" | "completed"
    home: MatchSide
    away: MatchSide
    winner: Optional[str]  # "home" | "away"
    winner_to: Optional[MatchLink]
    loser_to: Optional[MatchLink]
    home_from: Optional[MatchSource]
    away_from: Optional[MatchSource]
    court: Optional[str]
    game_id: Optional[str]
    series: Tuple[SeriesGame, ...]


@dataclass(frozen=True)
class BracketRound:
    round: int
    name: str
    matches: Tuple[Optional[BracketMatch], ...]  # padded with None to the bracket's widest round


@dataclass(frozen=True)
class Bracket:
    """One role of a bracket set: the whole thing for single-elim, one of
    winners / losers / finals for double-elim. Exactly one bracket across the
    tournament is ``current``."""

    id: str
    role: str  # "main" | "winners" | "losers" | "finals"
    state: str  # "pending" | "live" | "complete"
    current: bool
    rounds: Tuple[BracketRound, ...]


@dataclass(frozen=True)
class BracketSet:
    id: str
    name: str
    format: str  # "single" | "double" | "series"
    team_count: int
    state: str
    brackets: Tuple[Bracket, ...]


@dataclass(frozen=True)
class Tournament:
    id: str
    slug: str
    name: str
    status: str
    timezone: str  # IANA, for rendering local time
    starts_on: Optional[date]
    ends_on: Optional[date]
    game_seconds: int
    rules: Rules
    court: Court  # the subscribed court
    courts: Tuple[CourtRef, ...]
    teams: Tuple[TeamEntry, ...]
    completed_games: Tuple[CompletedGame, ...]  # on the subscribed court, oldest first
    stages: Tuple[Stage, ...]
    brackets: Tuple[BracketSet, ...]

    def current_bracket(self) -> Optional[Bracket]:
        for bset in self.brackets:
            for bracket in bset.brackets:
                if bracket.current:
                    return bracket
        return None


@dataclass(frozen=True)
class State:
    """What the client knows right now. ``game`` is the last game seen on the
    court (it keeps the final score after ``game_finished`` until the next
    one starts) or ``None`` if nothing has been played there yet."""

    tournament: Tournament
    game: Optional[Game]
    anchor: Anchor

    @property
    def server_now(self) -> datetime:
        return self.anchor.server_now

    def next_change_in_ms(self) -> Optional[int]:
        """How long until *anything* on this state changes its whole-second
        reading — the game clock, any penalty still counting, a running
        timeout — or ``None`` when nothing is ticking.

        Knowing which of the three axes are live is the library's job, not
        yours. Drive your repaint off this; the timer stays yours.
        """
        if self.game is None:
            return None

        candidates = [self.game.clock.next_change_in_ms() if self.game.clock else None]
        candidates += [p.next_change_in_ms() for p in self.game.active_penalties()]
        timeout = self.game.running_timeout()
        if timeout:
            candidates.append(timeout.next_change_in_ms())

        live = [c for c in candidates if c]
        return min(live) if live else None


# --- the bracket op ---


@dataclass(frozen=True)
class RenderedBracket:
    id: str
    role: str
    state: str
    current: bool
    html: str


@dataclass(frozen=True)
class RenderedBracketSet:
    name: str
    format: str
    state: str
    brackets: Tuple[RenderedBracket, ...]


BracketHTML = Dict[str, RenderedBracketSet]
