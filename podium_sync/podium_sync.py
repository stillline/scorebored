#!/usr/bin/env python3
"""
Long-running Podium live-stream sync service for scorebored.

Podium (https://podiumbikepolo.com) pushes live bike polo game state over a
WebSocket — score, clock, penalties, timeouts, bracket, standings — rather
than answering polls. This process holds that subscription open (via the
vendored `podium` client, ./podium/) and on every event:

    1. POSTs a compact live-game snapshot (score/clock/penalties) to the
       scorebored Node server (POST /api/podium/push), which merges it into
       gameState and broadcasts it to the display over socket.io. Node owns
       the left/right <-> home/away mapping (it respects whatever the
       operator's sidesSwapped toggle is currently set to) — this script
       always reports in home/away terms and never guesses a side.
    2. Writes local state files the control panel reads over REST, mirroring
       the challonge_sync.py pattern:

        state/status.json        - {state, connected, last_event_at, last_error}
        state/participants.json  - full roster [{id, name, seed}]
        state/bracket.json       - current bracket, for the bracket viewer

    3. Overwrites the app's top-level bracket.json (the manual schedule file
       Next/Prev Game reads) from the tournament's current bracket, same as
       challonge_sync.py does — so bracket.json stays the single source
       Next/Prev Game walks regardless of which sync (or neither) is active.

Read-only against Podium: this client only subscribes; it never sends score
or clock changes back (there is no such op).

Usage:
    PODIUM_API_KEY=... PODIUM_TOURNAMENT=... PODIUM_COURT=... ./podium_sync.py
"""

import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from podium import PodiumClient, State  # noqa: E402

API_KEY = os.environ["PODIUM_API_KEY"]
TOURNAMENT = os.environ["PODIUM_TOURNAMENT"]
COURT = os.environ["PODIUM_COURT"]
PODIUM_URL = os.environ.get("PODIUM_URL", "wss://podiumbikepolo.com/api/livestream")
PUSH_URL = os.environ.get("PUSH_URL", "http://localhost:3000/api/podium/push")

BRACKET_REFRESH_EVERY_S = 300   # re-fetch bracket HTML at most every 5 min,
                                # on structure_changed / tournament_changed

TICK_SECONDS = 0.1   # Podium only pushes on discrete events (goal, penalty,
                      # clock start/stop), not every second, so a display
                      # that loads (or reloads) between events would render
                      # a stale remaining_seconds as if the clock had just
                      # reset. A background ticker re-pushes the current
                      # clock reading on this interval whenever it's
                      # running, independent of the event dispatcher, so a
                      # fresh reload is never more than TICK_SECONDS stale.

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(SCRIPT_DIR, "state")
APP_BRACKET_FILE = os.path.join(SCRIPT_DIR, "..", "bracket.json")

DEFAULT_HOME_COLOR = "#292929"
DEFAULT_AWAY_COLOR = "#ebebeb"


def write_json_atomic(filename, data):
    write_json_atomic_path(os.path.join(STATE_DIR, filename), data)


def write_json_atomic_path(path, data):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, path)


def write_status(state, connected, error=None):
    write_json_atomic("status.json", {
        "state": state,
        "connected": connected,
        "last_event_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "last_error": error,
    })


def push_json(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()


def penalty_to_dict(p):
    return {
        "id": p.id,
        "severity": p.severity,
        "player": p.player.name if p.player else None,
        "club": p.player.club if p.player else None,
        "remaining_seconds": p.remaining_seconds(),
        "active": p.active(),
        "frozen": p.frozen(),
    }


def build_live_snapshot(state: State, last_goal=None):
    game = state.game
    if game is None:
        return {
            "connected": True,
            "has_game": False,
            "court": state.tournament.court.name if state.tournament.court else COURT,
        }

    clock = None
    if game.clock is not None:
        c = game.clock
        # remaining_seconds is a snapshot; the browser interpolates it
        # forward locally while running=true (anchored to its own clock at
        # receipt, not a timestamp from this process — see display.html).
        clock = {
            "running": c.running,
            "phase": c.phase,
            "remaining_seconds": c.remaining_seconds(),
            "formatted": c.formatted(),
            "in_stoppage_window": c.in_stoppage_window(),
            "whistle_stops_clock": c.whistle_stops_clock(),
        }

    penalties_home = [penalty_to_dict(p) for p in game.active_penalties() if p.side == "home"]
    penalties_away = [penalty_to_dict(p) for p in game.active_penalties() if p.side == "away"]

    return {
        "connected": True,
        "has_game": True,
        "court": game.court,
        "status": game.status,
        "round": game.round,
        "home": {
            "name": game.home.name,
            "score": game.home.score,
            "timeouts_left": game.timeouts_left("home"),
        },
        "away": {
            "name": game.away.name,
            "score": game.away.score,
            "timeouts_left": game.timeouts_left("away"),
        },
        "clock": clock,
        "penalties": {
            "home": penalties_home,
            "away": penalties_away,
        },
        # Only set on the specific push that announces a new goal (the
        # "goal" trigger) - server.js reads this to label the feed entry
        # with who scored. Not derived from game.goals (cumulative), so it
        # never resurfaces on later unrelated pushes.
        "last_goal": last_goal,
    }


def write_participants(tournament):
    participants = [{"id": t.id, "name": t.name, "seed": t.seed} for t in tournament.teams]
    write_json_atomic("participants.json", participants)


def round_label(round_num, role):
    if role == "losers":
        return f"Losers Round {round_num}"
    return f"Round {round_num}"


def build_app_bracket_matchups(bracket):
    """Convert a Podium Bracket (rounds -> padded match slots) into the app's
    bracket.json matchup shape: a flat list with `{group: label}` headers
    before each round's matches, same structure challonge_sync.py produces
    and the manual schedule editor already understands."""
    out = []
    for r in bracket.rounds:
        out.append({"group": round_label(r.round, bracket.role)})
        for m in r.matches:
            if m is None:
                continue
            out.append({
                "round": r.round,
                "identifier": m.label,
                "suggested_play_order": m.game_number,
                "left": m.home.display(),
                "right": m.away.display(),
                "lc": DEFAULT_HOME_COLOR,
                "rc": DEFAULT_AWAY_COLOR,
            })
    return out


def write_bracket_state(tournament):
    bracket = tournament.current_bracket()
    if bracket is None:
        return

    out_matches = []
    for r in bracket.rounds:
        for m in r.matches:
            if m is None:
                continue
            out_matches.append({
                "id": m.id,
                "state": m.status,
                "round": r.round,
                "identifier": m.label,
                "suggested_play_order": m.game_number,
                "home": m.home.display(),
                "away": m.away.display(),
                "home_score": m.home.score,
                "away_score": m.away.score,
                "winner": m.winner,
            })

    write_json_atomic("bracket.json", {
        "tournament_state": tournament.status,
        "bracket_role": bracket.role,
        "bracket_state": bracket.state,
        "matches": out_matches,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })

    app_matchups = build_app_bracket_matchups(bracket)
    write_json_atomic_path(APP_BRACKET_FILE, {"matchups": app_matchups, "source": "podium"})


def push_snapshot(state: State, last_goal=None) -> None:
    snapshot = build_live_snapshot(state, last_goal=last_goal)
    try:
        push_json(PUSH_URL, snapshot)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        print(f"[{time.strftime('%H:%M:%S')}] push to {PUSH_URL} failed: {e}",
              file=sys.stderr, flush=True)


def clock_ticker(client: PodiumClient, stop: threading.Event) -> None:
    """Re-pushes the current clock reading every TICK_SECONDS whenever it's
    running, independent of Podium's own event pushes. client.state() is
    lock-free and safe to call from any thread (see client.py)."""
    while not stop.wait(TICK_SECONDS):
        state = client.state()
        if state and state.game and state.game.clock and state.game.clock.running:
            push_snapshot(state)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)

    client = PodiumClient(key=API_KEY, tournament=TOURNAMENT, court=COURT, url=PODIUM_URL)

    def handle(state: State, trigger: str, event) -> None:
        try:
            if trigger in ("subscribed", "structure_changed", "tournament_changed"):
                write_participants(state.tournament)
                write_bracket_state(state.tournament)

            last_goal = None
            if trigger == "goal":
                last_goal = {
                    "side": event.side,
                    "player": event.player.name if event.player else None,
                }

            push_snapshot(state, last_goal=last_goal)

            write_status("live", connected=True)
            print(f"[{time.strftime('%H:%M:%S')}] {trigger}", flush=True)
        except Exception as e:  # noqa: BLE001 - the dispatcher must survive any handler error
            print(f"[{time.strftime('%H:%M:%S')}] handling {trigger} failed: {e}",
                  file=sys.stderr, flush=True)
            write_status("error", connected=client.connected, error=str(e))

    client.on_any(handle)

    ticker_stop = threading.Event()
    ticker_thread = threading.Thread(target=clock_ticker, args=(client, ticker_stop), daemon=True)
    ticker_thread.start()

    def shutdown(signum, frame):
        write_status("stopped", connected=False)
        ticker_stop.set()
        client.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    write_status("connecting", connected=False)
    client.run()


if __name__ == "__main__":
    main()
