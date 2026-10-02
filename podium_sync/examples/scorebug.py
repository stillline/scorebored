#!/usr/bin/env python3
"""A complete scorebug overlay: fills an SVG template from the live state and
hands whole frames to a renderer that only knows how to show one file.

    python3 scorebug.py --key pk_live_… --tournament esq-2026 --court 2 \
        --template scorebug.svg --out /tmp/scorebug.svg

Swap ``Renderer.show`` for your own (svgkeyer's ``show(path)``, for example).
The library owns the socket and the parsing; this file owns the template, the
repaint timer and the renderer. Nothing here runs on the library's threads
except the two handlers, which only schedule a repaint.
"""

import argparse
import logging
import string
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from podium import Game, Goal, PodiumClient, State  # noqa: E402

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
  <g font-family="sans-serif" font-size="40" fill="white">
    <rect x="60" y="940" width="1100" height="90" rx="12" fill="rgba(0,0,0,0.7)"/>
    <text x="90" y="1000">$home <tspan font-size="24" opacity="0.7">$home_record</tspan></text>
    <text x="560" y="1000" font-weight="bold" text-anchor="middle">$home_score – $away_score</text>
    <text x="1130" y="1000" text-anchor="end">$away <tspan font-size="24" opacity="0.7">$away_record</tspan></text>
    <text x="560" y="960" font-size="26" text-anchor="middle" opacity="0.8">$clock $penalty</text>
    <text x="90" y="1060" font-size="22" opacity="0.7">$lower_third</text>
  </g>
</svg>
"""


class Renderer:
    """Stand-in for the thing that keys the frame. Replace ``show``."""

    def __init__(self, out: Path):
        self.out = out

    def show(self, svg: str) -> None:
        self.out.write_text(svg)


class Scorebug:
    def __init__(self, client: PodiumClient, template: string.Template, renderer: Renderer):
        self.client = client
        self.template = template
        self.renderer = renderer
        self.lower_third = ""
        self._timer = None
        self._lock = threading.Lock()  # one repaint at a time; handlers and the timer both call it

    def fill(self, state: State) -> str:
        game = state.game
        if game is None:
            return self.template.safe_substitute(
                home="", away="", home_score="", away_score="", home_record="", away_record="",
                clock="waiting for a game", penalty="", lower_third=state.tournament.name,
            )
        clock = game.clock.formatted() if game.clock else ""
        penalties = game.active_penalties()
        penalty = ""
        if penalties:
            p = penalties[0]
            penalty = f"· {p.side} {p.severity} {p.remaining_seconds()}s"
        return self.template.safe_substitute(
            home=game.home.name,
            away=game.away.name,
            home_score=game.home.score if game.home.score is not None else 0,
            away_score=game.away.score if game.away.score is not None else 0,
            home_record=str(game.home.record),
            away_record=str(game.away.record),
            clock=clock if self.client.connected else "NO DATA",
            penalty=penalty,
            lower_third=self.lower_third,
        )

    def repaint(self) -> None:
        with self._lock:
            state = self.client.state()
            if state is not None:
                self.renderer.show(self.fill(state))
            # Next tick on the second boundary; a stopped clock repaints slowly.
            wait_ms = None
            if state and state.game and state.game.clock:
                wait_ms = state.game.clock.next_change_in_ms()
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer((wait_ms or 1000) / 1000, self.repaint)
            self._timer.daemon = True
            self._timer.start()

    def stop(self) -> None:
        if self._timer is not None:
            self._timer.cancel()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--key", required=True)
    parser.add_argument("--tournament", required=True, help="slug from the tournament URL")
    parser.add_argument("--court", required=True, help="court name as shown on the schedule")
    parser.add_argument("--url", default=None, help="override the region, e.g. wss://eu.podiumbikepolo.com/api/livestream")
    parser.add_argument("--template", type=Path, help="SVG template with $home, $away, $home_score … placeholders")
    parser.add_argument("--out", type=Path, default=Path("/tmp/scorebug.svg"))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    template = string.Template(args.template.read_text() if args.template else TEMPLATE)

    kwargs = {"url": args.url} if args.url else {}
    client = PodiumClient(key=args.key, tournament=args.tournament, court=args.court, **kwargs)
    bug = Scorebug(client, template, Renderer(args.out))

    @client.on_subscribed
    def subscribed(state: State) -> None:
        bug.lower_third = state.tournament.name
        bug.repaint()

    @client.on_goal
    def goal(state: State, event: Goal) -> None:
        if event.player:
            bug.lower_third = f"GOAL — {event.player.name}"
            threading.Timer(6.0, lambda: setattr(bug, "lower_third", "")).start()
        bug.repaint()

    @client.on_game_started
    def game_started(state: State, event: Game) -> None:
        bug.lower_third = f"{event.round} · {event.home.name} vs {event.away.name}"
        bug.repaint()

    @client.on_game_finished
    def game_finished(state: State, event: Game) -> None:
        logging.info("chapter: %s–%s %s %s-%s %s", event.started_at, event.ended_at,
                     event.home.name, event.home.score, event.away.score, event.away.name)
        bug.repaint()

    @client.on_any
    def anything(state: State, trigger: str, event) -> None:
        if trigger not in ("goal", "game_started", "game_finished", "subscribed"):
            bug.repaint()

    try:
        client.run()
    finally:
        bug.stop()


if __name__ == "__main__":
    main()
