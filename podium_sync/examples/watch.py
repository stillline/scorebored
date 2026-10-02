#!/usr/bin/env python3
"""Print every frame as it arrives — the first thing to run against a new key.

    python3 watch.py --key pk_live_… --tournament esq-2026 --court 2

One line per push: what fired, and what it changed. Game pushes show the
scorebug and the event; tournament pushes show the part of the tournament
that trigger is about (the court queue, the standings, the brackets), since
those carry no event of their own. Reconnects are logged by the library.

Times are the frame's `server_now`, in UTC. `--raw` appends the full typed
event; `--json` is the unparsed frame instead, for comparing against wire.md.
"""

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

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


def ms(value: Optional[int]) -> str:
    """Milliseconds as m:ss."""
    if value is None:
        return "--:--"
    seconds = value // 1000
    return f"{seconds // 60}:{seconds % 60:02d}"


def stamp(when: Optional[datetime]) -> str:
    return f"{when:%H:%M:%S}" if when else "--:--:--"


def progress(bracket: Any) -> str:
    """Decided matches out of real (non-padding) ones, so movement shows."""
    matches = [m for r in bracket.rounds for m in r.matches if m]
    done = sum(1 for m in matches if m.status == "completed")
    return f"{done}/{len(matches)}"


def scorebug(game: Optional[Game]) -> str:
    if game is None:
        return "(no game on court)"
    running = "▶" if game.clock and game.clock.running else "⏸"
    clock = game.clock.formatted() if game.clock else "--:--"
    line = f"{game.home.name} {game.home.score}-{game.away.score} {game.away.name}  {running} {clock}"
    for penalty in game.active_penalties():
        line += f"  [{penalty.side} {penalty.severity} {penalty.remaining_seconds()}s]"
    timeout = game.running_timeout()
    if timeout:
        line += f"  [{timeout.side} timeout {timeout.remaining_seconds()}s]"
    return line


def game_detail(trigger: str, event: Any, state: State) -> str:
    """The one thing the trigger is announcing, for a `game` push."""
    if isinstance(event, Goal):
        who = event.player.name if event.player else "unattributed"
        verb = "goal removed" if trigger == "goal_removed" else "goal"
        return f"{event.side} {verb} · {who} · {ms(event.elapsed_ms)} elapsed"
    if isinstance(event, Penalty):
        who = event.player.name if event.player else "team"
        if trigger == "penalty_ended":
            return f"{event.side} {event.severity} ended · {who} · {event.ended_reason}"
        window = f" · {event.duration_ms // 1000}s" if event.duration_ms else " · untimed"
        return f"{event.side} {event.severity} · {who}{window}"
    if isinstance(event, Timeout):
        return f"{event.side} timeout · {event.duration_ms // 1000}s · ends {stamp(event.ends_at)}"
    if isinstance(event, Clock):
        if event.phase == "overtime":
            return f"overtime · {event.formatted()} played"
        state_word = "running" if event.running else "stopped"
        expired = " · regulation expired" if event.regulation_expired else ""
        return f"{state_word} at {event.formatted()}{expired}"
    if isinstance(event, Game):
        if trigger == "game_finished":
            played = ""
            if event.started_at and event.ended_at:
                wall = int((event.ended_at - event.started_at).total_seconds())
                played = f" · {wall // 60}m{wall % 60:02d}s wall"
            return (
                f"FINAL {event.home.name} {event.home.score}-{event.away.score} {event.away.name}"
                f" · {stamp(event.started_at)}–{stamp(event.ended_at)}{played}"
            )
        return f"{event.round or '?'} · {event.home.name} vs {event.away.name} · court {event.court}"
    return ""


def tournament_detail(trigger: str, state: State) -> str:
    """A tournament push carries no event, so show the part it's about."""
    t = state.tournament

    if trigger == "queue_changed":
        on_court = scorebug(state.game).split("  ")[0] if t.court.game_id else "open"
        parts = [f"on court {on_court}"]
        for label, item in (("on deck", t.court.on_deck), ("in the hole", t.court.in_the_hole)):
            if item:
                parts.append(f"{label} {item.home.name} v {item.away.name} ({item.round})")
            else:
                parts.append(f"{label} —")
        return f"court {t.court.name}: " + " · ".join(parts)

    if trigger == "standings_changed":
        live = [s for s in t.stages if s.state == "live"] or list(t.stages)
        if not live:
            return "no group or swiss stages"
        out = []
        for stage in live[:2]:
            rows = " · ".join(
                f"{row.position} {row.name} {row.points}pt ({row.wins}-{row.losses}"
                + (f"-{row.ties}" if row.ties else "")
                + ")"
                for row in stage.teams[:4]
            )
            round_at = f"r{stage.current_round}/{stage.total_rounds}" if stage.current_round else "done"
            out.append(f"{stage.name} [{stage.state} {round_at}] {rows}")
        return "  ||  ".join(out)

    if trigger == "structure_changed":
        if not t.brackets:
            return f"{len(t.stages)} stage(s), {len(t.teams)} teams, {len(t.courts)} courts"
        out = []
        for bset in t.brackets:
            roles = " · ".join(
                f"{b.role} {b.state} {progress(b)}" + (" ◀current" if b.current else "")
                for b in bset.brackets
            )
            out.append(f"{bset.name} ({bset.format}, {bset.state}): {roles}")
        return "  ||  ".join(out)

    if trigger == "tournament_changed":
        return f"{t.name} · {t.status} · {ms(t.game_seconds * 1000)} games · {t.timezone}"

    return ""


def header(state: State) -> str:
    t = state.tournament
    lines = [
        f"{t.name}  ({t.slug})  {t.status}  {t.timezone}  {ms(t.game_seconds * 1000)} games",
        f"  court {t.court.name} of {', '.join(c.name for c in t.courts)}   {len(t.teams)} teams"
        f"   {len(t.completed_games)} finished here",
        f"  on court    {scorebug(state.game)}",
    ]
    for label, item in (("on deck", t.court.on_deck), ("in the hole", t.court.in_the_hole)):
        text = f"{item.home.name} v {item.away.name} ({item.round})" if item else "—"
        lines.append(f"  {label:<11} {text}")
    for stage in t.stages:
        leader = stage.teams[0].name if stage.teams else "—"
        lines.append(f"  stage       {stage.name} [{stage.kind} {stage.state}] leader {leader}")
    for bset in t.brackets:
        roles = ", ".join(
            f"{b.role} {progress(b)}" + ("*" if b.current else "") for b in bset.brackets
        )
        lines.append(f"  bracket     {bset.name} ({bset.format}, {bset.state}): {roles}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--key", required=True)
    parser.add_argument("--tournament", required=True, help="slug from the tournament URL")
    parser.add_argument("--court", required=True, help="court name as shown on the schedule")
    parser.add_argument("--url", default=None, help="override the region")
    parser.add_argument("--raw", action="store_true", help="append the full typed event")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    kwargs = {"url": args.url} if args.url else {}
    client = PodiumClient(key=args.key, tournament=args.tournament, court=args.court, **kwargs)

    @client.on_subscribed
    def subscribed(state: State) -> None:
        print(f"\n{stamp(state.server_now)}  SUBSCRIBED")
        print(header(state), flush=True)

    @client.on_any
    def anything(state: State, trigger: str, event: Any) -> None:
        if trigger == "subscribed":
            return
        if trigger in TOURNAMENT_TRIGGERS:
            detail = tournament_detail(trigger, state)
        else:
            detail = f"{scorebug(state.game)}   → {game_detail(trigger, event, state)}"
        line = f"{state.server_now:%H:%M:%S.%f}"[:-3] + f"  {trigger:<18} {detail}"
        if args.raw and event is not None:
            line += f"\n    {event}"
        print(line, flush=True)

    client.run()


if __name__ == "__main__":
    main()
