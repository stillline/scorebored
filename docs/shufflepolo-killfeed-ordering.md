# Kill feed event ordering — context for the in-progress event-timestamp work

Background for the Shufflepolo dev while the per-event UTC timestamp work
is underway: this is why we need it and exactly how we'll consume it, so
the field that lands matches what actually fixes the problem on our end.

## What we're seeing

Events occasionally appear in the wrong order in the feed, then the
ordering looks "fixed" a bit later — really just the wrong-ordered entry
getting pushed out of the visible window (we only show the most recent few)
by newer events, not an actual correction.

## Root cause (our side)

Your `live` snapshot gives us three separate arrays — `goals`, `timeouts`,
`penalties` — each cumulative for the game. Every time we poll, we diff
each array against the previous poll's copy to find newly-added ids, and
append a kill-feed entry for each new one we find.

We do that as three separate passes: all new goals, then all new timeouts,
then all new penalties. If a goal and a penalty both show up as "new" in
the same poll tick — which happens whenever two events land close together
in real time, inside one polling interval — the goal always gets appended
to our feed before the penalty, regardless of which actually happened
first on court. Nothing in the payload tells us otherwise: there's no
per-event timestamp to sort by, only an opaque `id`.

```js
// server.js, applyShufflepoloSnapshot() — what we currently keep per event
gameState._rawEvents = {
  goals: (snapshot.goals || []).map(g => ({
    id: g.id,
    side: sideForTeamId(g.team_id),
    player: g.player ? g.player.name : null,
  })),
  timeouts: (snapshot.timeouts || []).map(t => ({
    id: t.id,
    side: sideForTeamId(t.team_id),
  })),
  penalties: (snapshot.penalties || []).map(p => ({
    id: p.id,
    side: sideForTeamId(p.team_id),
    player: p.player ? p.player.name : null,
    severity: SHUFFLEPOLO_PENALTY_CODE[p.code] || p.code,
  })),
};
```

```js
// server.js, diffAndLogFeed() — the three-separate-passes problem
const beforeGoals = byId(beforeRaw && beforeRaw.goals);
for (const goal of afterRaw.goals) {
  if (!beforeGoals.has(goal.id)) pushFeedEntry('goal', { side: goal.side, player: goal.player });
}
const beforeTimeouts = byId(beforeRaw && beforeRaw.timeouts);
for (const timeout of afterRaw.timeouts) {
  if (!beforeTimeouts.has(timeout.id)) pushFeedEntry('timeout', { side: timeout.side });
}
const beforePenalties = byId(beforeRaw && beforeRaw.penalties);
for (const penalty of afterRaw.penalties) {
  if (!beforePenalties.has(penalty.id)) pushPenaltyFeedEntry(penalty.side, penalty);
}
```

Each loop appends in whatever order your array lists that category — not
necessarily chronological within the category either, just whatever order
`live.goals[]` / `live.penalties[]` / `live.timeouts[]` happen to be in.

## What the field needs to satisfy

To actually fix this, the timestamp needs to be comparable **across** the
three arrays (goals vs. timeouts vs. penalties), not just within one —
we'll be sorting a merged list of all three, so a goal's timestamp and a
penalty's timestamp need to sort correctly against each other, not just
against other goals. A per-category sequence number wouldn't do this; a
real wall-clock timestamp would.

UTC, same clock your `server_now` already uses elsewhere (see
`docs/shufflepolo-clock-sync-fix.md` for the existing clock-offset work —
we already trust that clock and don't need a second sync mechanism for
this). Doesn't need to be high precision, just enough to establish real
event order: something like

```json
{ "id": "...", "team_id": "...", "player": {...}, "created_at": "2026-10-05T08:40:12.331Z" }
```

on each entry in `goals`, `penalties`, and `timeouts`.

## What we'll do once it's available

Stop doing three separate category passes (current code above). Instead,
each poll we'll collect every newly-detected event across all three arrays
into one list, sort that list by the timestamp field, and push them to our
feed in that sorted order — so the feed reflects real event order instead
of detection/category order.
