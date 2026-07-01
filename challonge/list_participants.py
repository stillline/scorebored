#!/usr/bin/env python3
"""
Lists participants/teams registered in a tournament.

Usage:
    export CHALLONGE_API_KEY="your-v1-api-key"
    export CHALLONGE_TOURNEY="summertides"
    ./list_participants.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

API_KEY = os.environ["CHALLONGE_API_KEY"]
TOURNEY = os.environ["CHALLONGE_TOURNEY"]

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) challonge-scoreboard-script/1.0"

req = urllib.request.Request(f"https://api.challonge.com/v2.1/tournaments/{TOURNEY}/participants.json")
req.add_header("Content-Type", "application/vnd.api+json")
req.add_header("Accept", "application/json")
req.add_header("Authorization-Type", "v1")
req.add_header("Authorization", API_KEY)
req.add_header("User-Agent", USER_AGENT)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code} {e.reason}: {e.read().decode('utf-8', errors='replace')}", file=sys.stderr)
    sys.exit(1)

participants = data["data"]
if not participants:
    print("No participants/teams registered yet.")
else:
    print(f"{len(participants)} participant(s):")
    for p in participants:
        attrs = p["attributes"]
        name = attrs.get("name") or attrs.get("display_name") or "(unnamed)"
        seed = attrs.get("seed")
        print(f"  - {name}  (seed {seed}, id {p['id']})")
