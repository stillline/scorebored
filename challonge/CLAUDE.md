# Challonge Scoreboard Feed

## Purpose

Pulls "next up" matchup data from the Challonge tournament API and writes it to a local JSON file (`next_matchups.json`) that the tournament scoreboard display reads from. This directory is the source-of-truth for that feed; the scoreboard rendering side (whatever consumes `next_matchups.json`) lives wherever it lives on this Pi — check for it and wire the two together as the next step.

## Current tournament

- Name: **Summertides 3**
- Slug: `summertides`
- Numeric id: `18161031`
- State (as of last check): `group_stages_underway`
- 16 teams registered and seeded (2v2v2-style team names, e.g. "MC Heschers", "Juicy Juice", etc.) — pulled via `list_participants.py`.

Other tournaments visible on this API key (from `List_Tournamnets.py`): Wausau 6-7 (complete), Wausau 6-7 bracket (complete), Summertides II (complete / pending copies), Mayday 2025 (underway). Only Summertides 3 is currently live/relevant.

## Files

- **`challonge_next_matchups.py`** — the main long-running poller. Fetches `state=open` matches (ready to play, not yet complete) every `POLL_SECONDS` (currently 900s / 15 min), sorts by `suggested_play_order`, resolves participant IDs to team names, and writes the next `NEXT_N` (currently 3) matchups to `next_matchups.json` in this directory. Caches the participant list and only re-fetches it every ~4 hours (`PARTICIPANTS_REFRESH_EVERY`) since rosters rarely change mid-tournament — this keeps it to ~1 API call per poll (~96/day).
- **`list_participants.py`** — one-shot script to print all registered teams/seeds for a tournament. Useful for sanity-checking roster state.
- **`List_Tournamnets.py`** *(typo in filename, left as-is — rename if it bugs you)* — one-shot script to list every tournament visible to the API key, with slug/id/state. Useful for finding `CHALLONGE_TOURNEY` for a new event.

All three scripts hit `https://api.challonge.com/v2.1/...` with headers:
```
Authorization-Type: v1
Authorization: <the API key>
```
This is the **v1 API key** from `challonge.com/settings/developer` — not an OAuth Client ID/Secret (that's a different, unrelated auth flow via connect.challonge.com; don't use it here).

## Required environment variables

```bash
export CHALLONGE_API_KEY="<v1 api key>"
export CHALLONGE_TOURNEY="summertides"
```

Both must be set in the shell before running any script. **Never hardcode the key into a file or commit it** — it grants read/write access to the organizer's tournament data.

## Known gotchas already solved

1. **SSL cert errors on python.org-installed Python (macOS only):** fixed by running `/Applications/Python\ 3.11/Install\ Certificates.command`. Probably irrelevant on the Pi (Linux Python usually uses system CA certs), but if `CERTIFICATE_VERIFY_FAILED` shows up, try `pip install --upgrade certifi` first.
2. **Cloudflare 403 (`error_code: 1010`, `browser_signature_banned`):** Challonge's API is behind Cloudflare, which blocks Python's default `urllib` User-Agent string. All scripts set a browser-like `User-Agent` header to get past this — don't remove it.

## API usage cap

Challonge's free tier caps out at **500 requests/month**, enforced starting **2026-07-01** (i.e. now). Current polling design (~96 requests/day = ~1 call/poll, participants cached) should land well under that for a tournament weekend, but if this key is shared with other tools, keep an eye on usage at the developer settings page.

## Next steps for whoever (whatever agent) picks this up

1. **Find and wire up the actual scoreboard renderer.** `next_matchups.json` currently just sits in this directory — find what process/app on this Pi is meant to read it (text overlay macro, web page, whatever drives the physical scoreboard) and connect them. This wasn't scoped yet.
2. **Make the poller persistent across reboots** — set it up as a `systemd` service (or equivalent) rather than something run manually in a terminal, since this is now running unattended on the Pi.
3. **Add logging to a file**, not just stdout, since nobody will be watching a terminal during the event.
4. **Decide what "next matchups" means when there are no open matches** (e.g. between rounds, waiting on other results) — right now `next_matchups.json` would just have an empty/short `matchups` list. Confirm that's handled gracefully on the display side.
5. Consider whether match *completion* (not just upcoming) should also be reflected on the scoreboard — current script only queries `state=open`.
