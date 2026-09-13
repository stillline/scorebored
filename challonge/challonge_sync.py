#!/usr/bin/env python3
"""
Long-running Challonge sync service for scorebored.

Polls the Challonge v2.1 API on an interval (and immediately on SIGUSR1)
and writes state files that the scorebored Node server reads directly:

    state/next_matchups.json   - open matches, sorted by suggested_play_order
    state/participants.json    - full roster [{id, name, seed}]
    state/bracket.json         - all matches + tournament state, for the bracket viewer
    state/status.json          - {state, last_poll_at, last_error} for the settings UI

While enabled, also overwrites the app's top-level bracket.json (the manual
schedule file that /bracket and Next/Prev Game read) with the live Challonge
matchup queue, grouped by round. This makes bracket.json the single source
Next/Prev Game walks, whether the matchups came from Challonge or were typed
in by hand — no separate navigation path needed. Local edits to bracket.json
will be overwritten on the next poll while Challonge sync is enabled.

Read-only against Challonge: never writes/PATCHes anything back to it.

API call budget: Challonge's free tier caps out at 500 requests/month.
To stay well under that, this poller: (1) polls matches every 30 min
rather than every request, (2) caches participants and tournament
metadata, refreshing each only every ~4 hours instead of every poll,
and (3) stops regular polling entirely once tourney_meta reports the
tournament as "complete" (an on-demand SIGUSR1 poll still works if a
late correction needs picking up).

Usage:
    CHALLONGE_API_KEY=... CHALLONGE_TOURNEY=... ./challonge_sync.py
"""

import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request

API_KEY = os.environ["CHALLONGE_API_KEY"]
TOURNEY = os.environ["CHALLONGE_TOURNEY"]

POLL_SECONDS = 1800         # 30 min between polls (Next Game triggers an
                            # immediate poll on demand, so this only governs
                            # background staleness, not responsiveness)
PARTICIPANTS_REFRESH_EVERY = 8   # re-fetch participants every ~4 hrs (8 * 30min)
TOURNEY_META_REFRESH_EVERY = 8   # re-fetch tournament state/type every ~4 hrs;
                                 # it almost never changes between polls
NEXT_N = 3                  # how many upcoming matches to write out

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(SCRIPT_DIR, "state")
APP_BRACKET_FILE = os.path.join(SCRIPT_DIR, "..", "bracket.json")

DEFAULT_LEFT_COLOR = "#292929"
DEFAULT_RIGHT_COLOR = "#ebebeb"

BASE_URL = f"https://api.challonge.com/v2.1/tournaments/{TOURNEY}"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) challonge-scoreboard-script/1.0"

poll_now_requested = False


def request_poll_now(signum, frame):
    global poll_now_requested
    poll_now_requested = True


signal.signal(signal.SIGUSR1, request_poll_now)


def api_get(path, params=None):
    url = f"{BASE_URL}{path}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{url}?{query}"

    req = urllib.request.Request(url)
    req.add_header("Content-Type", "application/vnd.api+json")
    req.add_header("Accept", "application/json")
    req.add_header("Authorization-Type", "v1")
    req.add_header("Authorization", API_KEY)
    req.add_header("User-Agent", USER_AGENT)

    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def write_json_atomic(filename, data):
    path = os.path.join(STATE_DIR, filename)
    write_json_atomic_path(path, data)


def write_json_atomic_path(path, data):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, path)


def write_status(state, error=None):
    write_json_atomic("status.json", {
        "state": state,
        "last_poll_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "last_error": error,
    })


def team_name(full_name):
    """Challonge only stores one free-text name per participant, commonly
    formatted "<Team Name> - <player, player, player>" in this account.
    Split on the first " - " to get just the team name for the
    schedule/scoreboard/bracket views; the full string (with players) is
    still kept as-is in participants.json for the /teams roster page."""
    return full_name.split(" - ", 1)[0].strip()


def fetch_participants():
    """Returns (list of {id, name, seed}, dict: participant_id (str) -> full name,
    dict: participant_id (str) -> team name only)."""
    data = api_get("/participants.json")
    participants = []
    names = {}
    team_names = {}
    for p in data["data"]:
        attrs = p["attributes"]
        name = attrs.get("name") or attrs.get("display_name") or "(unnamed)"
        participants.append({"id": p["id"], "name": name, "seed": attrs.get("seed")})
        names[p["id"]] = name
        team_names[p["id"]] = team_name(name)
    return participants, names, team_names


def fetch_all_matches():
    data = api_get("/matches.json")
    return data["data"]


def match_participant_ids(match):
    """Resolve participant IDs via points_by_participant.

    relationships.player1/player2 are only present on 'open' matches;
    completed matches drop them entirely, so points_by_participant is
    the only reliable source across all match states.
    """
    pbp = match["attributes"].get("points_by_participant") or []
    ids = [str(entry["participant_id"]) for entry in pbp]
    p1 = ids[0] if len(ids) > 0 else None
    p2 = ids[1] if len(ids) > 1 else None
    return p1, p2


def build_next_matchups(matches, team_names, limit):
    open_matches = [m for m in matches if m["attributes"].get("state") == "open"]
    open_matches.sort(key=lambda m: (m["attributes"].get("suggested_play_order") or 0))

    out = []
    for m in open_matches[:limit]:
        attrs = m["attributes"]
        p1_id, p2_id = match_participant_ids(m)
        out.append({
            "round": attrs.get("round"),
            "identifier": attrs.get("identifier"),
            "suggested_play_order": attrs.get("suggested_play_order"),
            "player1": team_names.get(p1_id, "TBD"),
            "player2": team_names.get(p2_id, "TBD"),
            "player1_id": p1_id,
            "player2_id": p2_id,
        })
    return out


def build_bracket(matches, team_names, tourney_meta):
    out_matches = []
    for m in matches:
        attrs = m["attributes"]
        p1_id, p2_id = match_participant_ids(m)
        out_matches.append({
            "id": m["id"],
            "state": attrs.get("state"),
            "round": attrs.get("round"),
            "identifier": attrs.get("identifier"),
            "suggested_play_order": attrs.get("suggested_play_order"),
            "scores": attrs.get("scores"),
            "winner_id": str(attrs["winner_id"]) if attrs.get("winner_id") else None,
            "tie": attrs.get("tie", False),
            "player1_id": p1_id,
            "player2_id": p2_id,
            "player1": team_names.get(p1_id, "TBD"),
            "player2": team_names.get(p2_id, "TBD"),
        })
    return {
        "tournament_state": tourney_meta.get("state"),
        "tournament_type": tourney_meta.get("tournament_type"),
        "matches": out_matches,
    }


def fetch_tourney_meta():
    data = api_get("")
    return data["data"]["attributes"]


def round_label(round_num):
    if round_num is None:
        return "Round ?"
    if round_num < 0:
        return f"Losers Round {-round_num}"
    return f"Round {round_num}"


def build_app_bracket_matchups(matches, team_names):
    """Convert Challonge matches into the app's bracket.json matchup shape,
    grouped by round with a `{group: label}` header before each round's
    matches — same structure the manual schedule editor already uses.

    Ordered by suggested_play_order (Challonge's actual "play this next"
    sequence across winners/losers brackets combined), not by round number —
    sorting by round would put the whole losers bracket before or after the
    winners bracket depending on sign, which doesn't match play order."""
    sorted_matches = sorted(
        matches,
        key=lambda m: (m["attributes"].get("suggested_play_order") or 0, m["attributes"].get("round") or 0),
    )

    out = []
    current_round = object()  # sentinel, never equal to a real round number
    for m in sorted_matches:
        attrs = m["attributes"]
        r = attrs.get("round")
        if r != current_round:
            out.append({"group": round_label(r)})
            current_round = r

        p1_id, p2_id = match_participant_ids(m)
        out.append({
            "round": r,
            "identifier": attrs.get("identifier"),
            "suggested_play_order": attrs.get("suggested_play_order"),
            "left": team_names.get(p1_id, "TBD"),
            "right": team_names.get(p2_id, "TBD"),
            "lc": DEFAULT_LEFT_COLOR,
            "rc": DEFAULT_RIGHT_COLOR,
        })
    return out


def poll_once(team_names_cache, tourney_meta):
    matches = fetch_all_matches()

    next_matchups = build_next_matchups(matches, team_names_cache, NEXT_N)
    write_json_atomic("next_matchups.json", {
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "matchups": next_matchups,
    })

    bracket = build_bracket(matches, team_names_cache, tourney_meta)
    bracket["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_json_atomic("bracket.json", bracket)

    app_matchups = build_app_bracket_matchups(matches, team_names_cache)
    write_json_atomic_path(APP_BRACKET_FILE, {"matchups": app_matchups, "source": "challonge"})

    print(f"[{time.strftime('%H:%M:%S')}] wrote {len(next_matchups)} next matchups, "
          f"{len(bracket['matches'])} total matches, synced {len(app_matchups)} rows to bracket.json", flush=True)


SECONDS_PER_DAY = 86400


def main():
    global poll_now_requested

    os.makedirs(STATE_DIR, exist_ok=True)

    participants, _, team_names_cache = fetch_participants()
    write_json_atomic("participants.json", participants)
    tourney_meta = fetch_tourney_meta()

    poll_count = 0

    while True:
        try:
            if poll_count > 0 and poll_count % PARTICIPANTS_REFRESH_EVERY == 0:
                participants, _, team_names_cache = fetch_participants()
                write_json_atomic("participants.json", participants)

            # tourney_meta (state/type) rarely changes between polls, so it's
            # cached and only re-fetched periodically instead of every poll —
            # cuts steady-state API usage roughly in half.
            if poll_count > 0 and poll_count % TOURNEY_META_REFRESH_EVERY == 0:
                tourney_meta = fetch_tourney_meta()

            poll_once(team_names_cache, tourney_meta)
            write_status("idle")

        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            err = f"HTTP {e.code} {e.reason}: {body}"
            print(f"[{time.strftime('%H:%M:%S')}] poll failed: {err}", file=sys.stderr, flush=True)
            write_status("error", err)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] poll failed: {e}", file=sys.stderr, flush=True)
            write_status("error", str(e))

        poll_count += 1

        # Once the tournament is finished, nothing more will change on
        # Challonge's side — stop regular polling (sleep a full day instead
        # of the normal interval) rather than keep spending API calls on a
        # done tournament. A SIGUSR1 on-demand poll (e.g. from clicking Next
        # Game, or a manual trigger) still wakes it immediately if a late
        # correction needs picking up.
        interval = SECONDS_PER_DAY if tourney_meta.get("state") == "complete" else POLL_SECONDS

        # Sleep in small increments so a SIGUSR1 "poll now" request is
        # picked up promptly instead of waiting out the full interval.
        slept = 0
        poll_now_requested = False
        while slept < interval and not poll_now_requested:
            time.sleep(1)
            slept += 1

        # If woken early by an on-demand poll while "complete", re-check the
        # tournament state too (in case it needed correcting on Challonge).
        if poll_now_requested and tourney_meta.get("state") == "complete":
            tourney_meta = fetch_tourney_meta()


if __name__ == "__main__":
    main()
