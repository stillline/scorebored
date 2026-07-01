#!/usr/bin/env python3
"""
Lists tournaments visible to your API key, so you can find the
slug/id to use as CHALLONGE_TOURNEY.

Usage:
    CHALLONGE_API_KEY=yourkey python3 list_tournaments.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

API_KEY = os.environ["CHALLONGE_API_KEY"]

req = urllib.request.Request("https://api.challonge.com/v2.1/tournaments.json")
req.add_header("Content-Type", "application/vnd.api+json")
req.add_header("Accept", "application/json")
req.add_header("Authorization-Type", "v1")
req.add_header("Authorization", API_KEY)
req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) challonge-scoreboard-script/1.0")

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.load(resp)
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    print(f"HTTP {e.code} {e.reason}", file=sys.stderr)
    print(body, file=sys.stderr)
    sys.exit(1)

for t in data["data"]:
    attrs = t["attributes"]
    print(f"{attrs.get('name'):40s}  slug: {attrs.get('url')}   id: {t['id']}   state: {attrs.get('state')}")
