#!/usr/bin/env python3
"""A pretend broadcast screen, live in your terminal.

    python3 broadcast.py --key pk_live_… --tournament esq-2026 --court 2

This is the shape a real overlay has, and the reason the API sends anchors
instead of clock readings: **the screen repaints on its own schedule, not on
events**. The render loop reads `client.state()` whenever it likes and asks
the clocks what they say *now*; handlers only append to the event ticker.
Nothing about the repaint rate is coupled to how often the server pushes.

Repaints are aligned to the next whole-second boundary via
`next_change_in_ms()`, so the clock ticks cleanly instead of stuttering.

`q` quits. Stdlib only — `curses` ships with Python.
"""

import argparse
import curses
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from podium import (  # noqa: E402
    TOURNAMENT_TRIGGERS,
    Clock,
    Game,
    Goal,
    Penalty,
    PodiumClient,
    State,
    Timeout,
)

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python 3.8
    ZoneInfo = None

# 3x5 block digits, so the score reads like a scorebug rather than a log line.
BIG = {
    "0": ["███", "█ █", "█ █", "█ █", "███"],
    "1": [" █ ", "██ ", " █ ", " █ ", "███"],
    "2": ["███", "  █", "███", "█  ", "███"],
    "3": ["███", "  █", "███", "  █", "███"],
    "4": ["█ █", "█ █", "███", "  █", "  █"],
    "5": ["███", "█  ", "███", "  █", "███"],
    "6": ["███", "█  ", "███", "█ █", "███"],
    "7": ["███", "  █", "  █", "  █", "  █"],
    "8": ["███", "█ █", "███", "█ █", "███"],
    "9": ["███", "█ █", "███", "  █", "███"],
    "-": ["   ", "   ", "███", "   ", "   "],
    ":": ["   ", " █ ", "   ", " █ ", "   "],
    "+": ["   ", " █ ", "███", " █ ", "   "],
    " ": ["   ", "   ", "   ", "   ", "   "],
}

C_DIM, C_HOME, C_AWAY, C_LIVE, C_STOP, C_HEAD, C_WARN = range(1, 8)


def big_rows(text: str, gap: int = 2) -> List[str]:
    joiner = " " * gap
    return [joiner.join(BIG.get(ch, BIG[" "])[row] for ch in text) for row in range(5)]


def short(label: str, width: int = 14) -> str:
    """Squeeze a bracket slot into a narrow column: the server's resolved
    "Winner of Game 4" becomes the scoreboard shorthand "W4"."""
    label = label.replace("Winner of Game ", "W").replace("Loser of Game ", "L")
    return label[:width]


def clock_text(game: Optional[Game]) -> str:
    if game is None or game.clock is None:
        return "--:--"
    return game.clock.formatted()


def describe(trigger: str, event: Any) -> str:
    """One short line for the ticker."""
    if isinstance(event, Goal):
        who = event.player.name if event.player else "unattributed"
        verb = "goal removed" if trigger == "goal_removed" else "GOAL"
        return f"{verb} · {event.side} · {who}"
    if isinstance(event, Penalty):
        who = event.player.name if event.player else "team"
        if trigger == "penalty_ended":
            return f"penalty ended · {event.side} {event.severity} · {event.ended_reason}"
        return f"penalty · {event.side} {event.severity} · {who}"
    if isinstance(event, Timeout):
        return f"timeout · {event.side} · {event.duration_ms // 1000}s"
    if isinstance(event, Clock):
        if event.phase == "overtime":
            return f"overtime · {event.formatted()}"
        return f"clock {'running' if event.running else 'stopped'} · {event.formatted()}"
    if isinstance(event, Game):
        if trigger == "game_finished":
            return f"FINAL · {event.home.name} {event.home.score}-{event.away.score} {event.away.name}"
        return f"{trigger} · {event.round or ''}"
    return trigger


class Board:
    """Draws one frame. Owns no state beyond the ticker."""

    def __init__(self, client: PodiumClient, tz: Optional[str]):
        self.client = client
        self.tz = tz
        self.ticker: deque = deque(maxlen=6)
        self.frames = 0

    # --- drawing helpers ---

    def put(self, win, y: int, x: int, text: str, attr: int = 0) -> None:
        """addstr that clips instead of raising at the screen edge."""
        height, width = win.getmaxyx()
        if y < 0 or y >= height or x >= width:
            return
        try:
            win.addnstr(y, x, text, max(width - x - 1, 0), attr)
        except curses.error:
            pass

    def rule(self, win, y: int, label: str = "") -> None:
        _, width = win.getmaxyx()
        line = ("─" * (width - 1)) if not label else f"─── {label} " + "─" * max(width - len(label) - 7, 0)
        self.put(win, y, 0, line[: width - 1], curses.color_pair(C_DIM))

    def timeout_dots(self, game: Game, side: str) -> str:
        """Timeouts left as ●●/●○ — needs the allowance from the game's rules,
        which is why `rules` rides on the payload."""
        left = game.timeouts_left(side)
        return "●" * left + "○" * game.timeouts_used(side)

    def bar(self, remaining_ms: int, total_ms: int, cells: int = 18) -> str:
        if not total_ms:
            return ""
        filled = max(0, min(cells, round(cells * remaining_ms / total_ms)))
        return "█" * filled + "░" * (cells - filled)

    def local(self, when: datetime) -> str:
        if self.tz and ZoneInfo is not None:
            try:
                return f"{when.astimezone(ZoneInfo(self.tz)):%H:%M:%S}"
            except Exception:  # noqa: BLE001 - bad tz name shouldn't kill the render
                pass
        return f"{when:%H:%M:%S} UTC"

    # --- the frame ---

    def draw(self, win) -> None:
        self.frames += 1
        win.erase()
        height, width = win.getmaxyx()
        state = self.client.state()

        self.header(win, state, width)
        if state is None:
            self.put(win, height // 2, 2, "connecting…", curses.color_pair(C_DIM))
            win.refresh()
            return

        row = self.scorebug(win, state, 2, width)
        row = self.boxes(win, state, row, width)
        self.rule(win, row)
        self.panels(win, state, row + 1, width, height - row - 5)
        self.queue(win, state, height - 4, width)
        self.footer(win, height - 2, width)
        win.refresh()

    def header(self, win, state: Optional[State], width: int) -> None:
        connected = self.client.connected
        dot = "● LIVE " if connected else "○ NO DATA"
        attr = curses.color_pair(C_LIVE if connected else C_WARN) | curses.A_BOLD
        title = "PODIUM LIVE"
        if state:
            title += f"  ·  {state.tournament.name}  ·  court {state.tournament.court.name}"
        self.put(win, 0, 1, title, curses.color_pair(C_HEAD) | curses.A_BOLD)
        self.put(win, 0, max(width - 24, 0), dot, attr)
        if state:
            self.put(win, 0, max(width - 14, 0), self.local(state.server_now), curses.color_pair(C_DIM))
        self.rule(win, 1)

    def scorebug(self, win, state: State, top: int, width: int) -> int:
        game = state.game
        mid = width // 2

        if game is None:
            self.put(win, top + 2, mid - 8, "STANDBY", curses.color_pair(C_DIM) | curses.A_BOLD)
            self.put(win, top + 4, mid - 12, "no game on this court", curses.color_pair(C_DIM))
            return top + 7

        home_attr = curses.color_pair(C_HOME) | curses.A_BOLD
        away_attr = curses.color_pair(C_AWAY) | curses.A_BOLD

        self.put(win, top, 2, game.home.name.upper(), home_attr)
        seed = f"#{game.home.seed}  " if game.home.seed else ""
        home_meta = f"{seed}{game.home.record}   {self.timeout_dots(game, 'home')}"
        self.put(win, top + 1, 2, home_meta, curses.color_pair(C_DIM))

        away_label = game.away.name.upper()
        self.put(win, top, max(width - len(away_label) - 2, 0), away_label, away_attr)
        seed = f"#{game.away.seed}  " if game.away.seed else ""
        away_meta = f"{self.timeout_dots(game, 'away')}   {seed}{game.away.record}"
        self.put(win, top + 1, max(width - len(away_meta) - 2, 0), away_meta, curses.color_pair(C_DIM))

        score = f"{game.home.score or 0}-{game.away.score or 0}"
        rows = big_rows(score)
        start = mid - len(rows[0]) // 2
        for i, line in enumerate(rows):
            self.put(win, top + i, start, line, curses.A_BOLD)

        running = game.clock.running if game.clock else False
        clock_attr = curses.color_pair(C_LIVE if running else C_STOP) | curses.A_BOLD
        mark = "▶" if running else "⏸"
        if game.status == "completed":
            mark, clock_attr = "■", curses.color_pair(C_WARN) | curses.A_BOLD

        # The clock is the thing you stare at, so it gets the big treatment too
        # whenever the terminal is tall enough for it.
        height, _ = win.getmaxyx()
        text = clock_text(game)
        if height >= 30:
            rows = big_rows(text, gap=1)
            start = mid - len(rows[0]) // 2
            for i, line in enumerate(rows):
                self.put(win, top + 6 + i, start, line, clock_attr)
            self.put(win, top + 8, max(start - 4, 0), mark, clock_attr)
            bottom = top + 11
        else:
            self.put(win, top + 6, mid - (len(text) + 2) // 2, f"{mark} {text}", clock_attr)
            bottom = top + 7

        # The client knows the rule, so the overlay just asks.
        if game.clock and game.status != "completed" and game.clock.in_stoppage_window():
            note = "STOP CLOCK" if game.clock.whistle_stops_clock() else "STOP CLOCK (paused)"
            self.put(win, top + 6, mid - len(note) // 2 + 22, note, curses.color_pair(C_WARN))

        label = " · ".join(x for x in [game.round, game.stage.name if game.stage else None] if x)
        if game.status == "completed":
            label = "FINAL · " + label
        self.put(win, bottom, mid - len(label) // 2, label, curses.color_pair(C_DIM))
        return bottom + 2

    def boxes(self, win, state: State, top: int, width: int) -> int:
        """Penalty box and timeout — the two countdowns on their own axes."""
        game = state.game
        if game is None:
            return top

        row = top
        for penalty in game.active_penalties():
            total = penalty.duration_ms or 1
            bar = self.bar(penalty.remaining_ms(), total)
            who = penalty.player.name if penalty.player else "team"
            frozen = "  (frozen)" if penalty.frozen() else ""
            text = (
                f"PENALTY   {penalty.side:<5} {penalty.severity:<9} {who:<18} "
                f"{bar} {penalty.remaining_seconds():>3}s{frozen}"
            )
            self.put(win, row, 2, text, curses.color_pair(C_WARN))
            row += 1

        timeout = game.running_timeout()
        if timeout:
            bar = self.bar(timeout.remaining_ms(), timeout.duration_ms or 1)
            text = f"TIMEOUT   {timeout.side:<5} {'':<28} {bar} {timeout.remaining_seconds():>3}s"
            self.put(win, row, 2, text, curses.color_pair(C_HEAD))
            row += 1

        return row + 1 if row > top else top

    def panels(self, win, state: State, top: int, width: int, rows: int) -> None:
        if rows < 3:
            return
        split = max(width // 2, 30)
        self.goals_panel(win, state, top, 2, split - 4, rows)
        self.right_panel(win, state, top, split + 2, width - split - 4, rows)
        for y in range(top, top + rows):
            self.put(win, y, split, "│", curses.color_pair(C_DIM))

    def goals_panel(self, win, state: State, top: int, left: int, w: int, rows: int) -> None:
        self.put(win, top, left, "GOALS", curses.color_pair(C_HEAD) | curses.A_BOLD)
        game = state.game
        if game is None or not game.goals:
            self.put(win, top + 1, left, "—", curses.color_pair(C_DIM))
            return
        home = away = 0
        lines = []
        for goal in game.goals:
            if goal.side == "home":
                home += 1
            else:
                away += 1
            when = f"{(goal.elapsed_ms or 0) // 60000}:{((goal.elapsed_ms or 0) // 1000) % 60:02d}"
            who = goal.player.name if goal.player else "(unattributed)"
            lines.append((goal.side, f"{when:>5}  {who[:18]:<18} {home}-{away}"))
        for i, (side, line) in enumerate(lines[-(rows - 1) :]):
            attr = curses.color_pair(C_HOME if side == "home" else C_AWAY)
            self.put(win, top + 1 + i, left, line, attr)

    def right_panel(self, win, state: State, top: int, left: int, w: int, rows: int) -> None:
        game = state.game
        kind = game.stage.kind if (game and game.stage) else None

        if kind == "bracket":
            self.bracket_panel(win, state, top, left, w, rows)
        else:
            self.standings_panel(win, state, top, left, w, rows)

    def standings_panel(self, win, state: State, top: int, left: int, w: int, rows: int) -> None:
        stages = state.tournament.stages
        game = state.game
        stage = None
        if game and game.stage:
            stage = next((s for s in stages if s.id == game.stage.id), None)
        stage = stage or next((s for s in stages if s.state == "live"), None) or (stages[0] if stages else None)

        if stage is None:
            self.put(win, top, left, "STANDINGS", curses.color_pair(C_HEAD) | curses.A_BOLD)
            self.put(win, top + 1, left, "no group or swiss stage", curses.color_pair(C_DIM))
            return

        round_at = f" r{stage.current_round}/{stage.total_rounds}" if stage.current_round else ""
        head = f"{stage.name.upper()}  [{stage.kind} {stage.state}{round_at}]"
        self.put(win, top, left, head, curses.color_pair(C_HEAD) | curses.A_BOLD)
        self.put(win, top + 1, left, f"{'#':>2} {'TEAM':<18}{'PTS':>4}{'W-L-T':>8}{'GD':>5}", curses.color_pair(C_DIM))
        for i, row in enumerate(stage.teams[: rows - 2]):
            record = f"{row.wins}-{row.losses}-{row.ties}"
            line = f"{row.position:>2} {row.name[:18]:<18}{row.points:>4}{record:>8}{row.goal_differential:>+5}"
            attr = curses.A_BOLD if i == 0 else 0
            if game and row.team_id in (game.home.team_id, game.away.team_id):
                attr |= curses.color_pair(C_LIVE)
            self.put(win, top + 2 + i, left, line, attr)

    def bracket_panel(self, win, state: State, top: int, left: int, w: int, rows: int) -> None:
        bracket = state.tournament.current_bracket()
        if bracket is None:
            self.put(win, top, left, "BRACKET", curses.color_pair(C_HEAD) | curses.A_BOLD)
            return
        bset = next(b for b in state.tournament.brackets if any(x.id == bracket.id for x in b.brackets))
        head = f"{bset.name.upper()}  [{bracket.role} {bracket.state}]"
        self.put(win, top, left, head, curses.color_pair(C_HEAD) | curses.A_BOLD)

        line = top + 1
        for rnd in bracket.rounds:
            live = [m for m in rnd.matches if m]
            if not live or line >= top + rows:
                continue
            self.put(win, line, left, rnd.name[: w - 1], curses.color_pair(C_DIM))
            line += 1
            for match in live:
                if line >= top + rows:
                    break
                mark = {"completed": "✓", "in_progress": "▶", "scheduled": "·"}.get(match.status, "·")
                home, away = short(match.home.display()), short(match.away.display())
                score = ""
                if match.home.score is not None:
                    score = f"  {match.home.score}-{match.away.score}"
                text = f" {mark} G{match.game_number or '?':<3}{home:<15}v {away:<15}{score}"
                attr = curses.A_BOLD if match.status == "in_progress" else 0
                if match.winner:
                    attr = curses.color_pair(C_DIM)
                self.put(win, line, left, text[: w - 1], attr)
                line += 1

    def queue(self, win, state: State, top: int, width: int) -> None:
        self.rule(win, top - 1)
        court = state.tournament.court
        for i, (label, item) in enumerate((("ON DECK", court.on_deck), ("IN THE HOLE", court.in_the_hole))):
            if item:
                text = f"{item.home.name} v {item.away.name}   ({item.round})"
            else:
                text = "—"
            self.put(win, top + i, 2, f"{label:<12}", curses.color_pair(C_HEAD))
            self.put(win, top + i, 15, text, 0)

    def footer(self, win, top: int, width: int) -> None:
        self.rule(win, top)
        latest = "  ·  ".join(self.ticker) if self.ticker else "waiting…"
        self.put(win, top + 1, 2, latest[: width - 20], curses.color_pair(C_DIM))
        meta = f"{self.frames} frames  ·  q to quit"
        self.put(win, top + 1, max(width - len(meta) - 2, 0), meta, curses.color_pair(C_DIM))


def next_wait(state: Optional[State]) -> float:
    """Seconds to sleep before the next repaint.

    The library says when the display next changes; this only applies the
    screen's own pacing policy — never idle longer than half a second (so a
    push still lands promptly) and never spin faster than 30ms.
    """
    due = state.next_change_in_ms() if state else None
    return max(min(due or 500, 500) / 1000, 0.03)


def run(stdscr, client: PodiumClient, tz: Optional[str]) -> None:
    curses.curs_set(0)
    curses.use_default_colors()
    for pair, color in (
        (C_DIM, curses.COLOR_BLUE),
        (C_HOME, curses.COLOR_MAGENTA),
        (C_AWAY, curses.COLOR_GREEN),
        (C_LIVE, curses.COLOR_GREEN),
        (C_STOP, curses.COLOR_YELLOW),
        (C_HEAD, curses.COLOR_CYAN),
        (C_WARN, curses.COLOR_RED),
    ):
        curses.init_pair(pair, color, -1)
    stdscr.nodelay(True)

    board = Board(client, tz)

    @client.on_any
    def anything(state: State, trigger: str, event: Any) -> None:
        # Handlers only record. The screen repaints on its own clock.
        if trigger in TOURNAMENT_TRIGGERS or trigger == "subscribed":
            return
        board.ticker.appendleft(f"{state.server_now:%H:%M:%S} {describe(trigger, event)}")

    client.start()
    while True:
        board.draw(stdscr)
        key = stdscr.getch()
        if key in (ord("q"), ord("Q")):
            return
        if key == curses.KEY_RESIZE:
            continue
        time.sleep(next_wait(client.state()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--key", required=True)
    parser.add_argument("--tournament", required=True, help="slug from the tournament URL")
    parser.add_argument("--court", required=True, help="court name as shown on the schedule")
    parser.add_argument("--url", default=None, help="override the region")
    args = parser.parse_args()

    kwargs = {"url": args.url} if args.url else {}
    client = PodiumClient(key=args.key, tournament=args.tournament, court=args.court, **kwargs)
    try:
        state = None
        deadline = time.monotonic() + 5
        client.start()
        while state is None and time.monotonic() < deadline:
            state = client.state()
            time.sleep(0.05)
        tz = state.tournament.timezone if state else None
        curses.wrapper(run, client, tz)
    finally:
        client.stop()


if __name__ == "__main__":
    main()
