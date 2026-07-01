#!/usr/bin/env python3
"""
Polls Challonge for the next open matchups in a tournament and writes
them to next_matchups.json for a scoreboard/graphics tool to read.

Usage:
    export CHALLONGE_API_KEY="your-v1-api-key"
    export CHALLONGE_TOURNEY="summertides"   # slug or numeric id
    ./challonge_next_matchups.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

API_KEY = os.environ["CHALLONGE_API_KEY"]
TOURNEY = os.environ["CHALLONGE_TOURNEY"]

POLL_SECONDS = 900          # 15 min between polls
PARTICIPANTS_REFRESH_EVERY = 16  # re-fetch participants every ~4 hrs (16 * 15min)
NEXT_N = 3                  # how many upcoming matches to write out

OUTPUT_FILE = "next_matchups.json"

BASE_URL = f"https://api.challonge.com/v2.1/tournaments/{TOURNEY}"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) challonge-scoreboard-script/1.0"


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

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} {e.reason}: {body}", file=sys.stderr)
        raise


def fetch_participants():
    """Returns dict: participant_id (str) -> display name."""
    data = api_get("/participants.json")
    names = {}
    for p in data["data"]:
        names[p["id"]] = p["attributes"].get("name") or p["attributes"].get("display_name")
    return names


def fetch_open_matches():
    data = api_get("/matches.json", params={"state": "open"})
    matches = data["data"]
    matches.sort(key=lambda m: (m["attributes"].get("suggested_play_order") or 0))
    return matches


def participant_id(match, side):
    rel = match["relationships"].get(side)
    if not rel or not rel.get("data"):
        return None
    return rel["data"]["id"]


def build_matchups(matches, names, limit):
    out = []
    for m in matches[:limit]:
        attrs = m["attributes"]
        p1_id = participant_id(m, "player1")
        p2_id = participant_id(m, "player2")
        out.append({
            "round": attrs.get("round"),
            "identifier": attrs.get("identifier"),
            "suggested_play_order": attrs.get("suggested_play_order"),
            "player1": names.get(p1_id, "TBD"),
            "player2": names.get(p2_id, "TBD"),
        })
    return out


def main():
    names = fetch_participants()
    poll_count = 0

    while True:
        try:
            if poll_count > 0 and poll_count % PARTICIPANTS_REFRESH_EVERY == 0:
                names = fetch_participants()

            matches = fetch_open_matches()
            matchups = build_matchups(matches, names, NEXT_N)

            with open(OUTPUT_FILE, "w") as f:
                json.dump({"updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "matchups": matchups}, f, indent=2)

            print(f"[{time.strftime('%H:%M:%S')}] wrote {len(matchups)} matchups to {OUTPUT_FILE}")

        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] poll failed: {e}", file=sys.stderr)

        poll_count += 1
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
