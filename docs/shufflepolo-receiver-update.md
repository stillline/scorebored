# scorebored receiver update for the Shufflepolo dev (2026-10-09)

Thanks for the contract write-up and the corrected copy of our sync script.
We rebuilt our receiver on it. Summary of what changed on our side, and two
small questions at the end.

## What we fixed

- **We now join every topic in `realtime.topics`.** Our old client joined
  `games:<id>` only, so it never heard a penalty (those are on `feed:<id>`
  alone). That was the whole "realtime looks healthy but updates lag"
  mystery: penalties only showed up on our next safety poll.
- **We stopped polling every 2 seconds.** That was our workaround for the
  missing penalties. The safety poll is back to the contract's once per
  5 minutes; realtime is the update path again, with the 2-second re-read
  throttle and one trailing read after a burst.
- **Every read sends `If-None-Match`.** A 304 costs you one function call
  and no egress, and we write and push nothing on it. Idle, our receiver
  now generates no traffic beyond the 5-minute 304s.
- **We re-read at each live clock's `live_until`**, counted against
  `server_now` with our measured offset.
- **We follow one court via `courts[].current_game`** (court number from
  our config) and take the clock from `live[]`/`suspended[]` by id. The
  old `live[0]` logic is gone.
- **Clock offset** now uses your reference client's sampling: fastest
  round trip wins, held samples age, and a wall-clock step on our side
  (the Pi has no RTC) re-measures immediately.
- **`null` event lists are "not included", never "none"**; an unknown
  `status` makes a game not live rather than failing the read. We only use
  the default `events=active` scope: we dropped our play-by-play feed, so
  we never need `events=all`.
- The receiver pushes to our scoreboard only when the snapshot changed,
  and our server only saves/broadcasts on an actual change.

## What we observed

- The ETag/304 path works exactly as documented against production.
- One socket close (code 1006) during a 2.5-hour watch, rejoined within
  two seconds, no reads lost. Matches your "disconnects are normal" note.
- Our previous 2-second full reads were costing roughly 340 MB per
  10-hour day of your egress. Sorry about that; it is near zero now.

## Two questions

1. **Timeouts.** We found `TIMEOUT_SECONDS = 120` and `timeout_ends_at` in
   your console code, and that calling a timeout stops the clock in the
   same statement. We show the timeout banner while the newest timeout is
   more recent than the last clock start and the clock is paused, with
   120 s as a ceiling. Is that the right reading? If `timeout_ends_at`
   ever makes it into the feed we would use it directly, but this works
   without it.
2. **Safety poll interval.** 5 minutes is what we run. If you are
   comfortable with a shorter conditional poll (say 60 s, always with
   `If-None-Match`, so a 304 when idle), we would take it as extra
   insurance on cellular. If not, 5 minutes is fine.
