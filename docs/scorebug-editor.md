# Scorebug Editor (`/overlay-editor`)

Scorebug design is authored by pasting a self-contained HTML/CSS document —
there's no element-based visual canvas (an earlier version of this app had
one at `/editor`; it's retired). Logos are placed separately with their own
Resolve-style transform controls and composited on top server-side.

## Overlays

An **overlay** is a named scorebug design, stored as its own file in
`overlays/` (`overlay_<random>.json`). Each overlay holds:

- `versions` — every saved version of the pasted HTML, each with its own
  `html` snapshot and timestamp
- `activeVersion` — which version `/overlay/:id` currently serves
- `logos` — placed PNGs (position/scale/rotation), independent of which
  version is active — see below
- `name` — editable via the pencil button next to the overlay picker in
  the toolbar (the dropdown itself shows the current name; there's no
  separate always-visible name field)

**Save** (top toolbar) always appends a new version rather than
overwriting, so a draft in progress never clobbers what's actually on
air. **Set Active (Live)** saves the current textarea content if it
differs from the loaded version, points the overlay's `activeVersion` at
it, and — critically — also makes *this overlay* the thing `/display`
renders, via the `setActive` socket event
(`{ kind: 'overlay', id }` → `gameState.activeKind`/`activeId`).
These are two different "active" concepts: an overlay's own
`activeVersion` (which of its versions `/overlay/:id` serves) and the
app-wide `gameState.activeId` (which preset *or* overlay `/display`
shows at all). Set Active sets both at once; switching `/display` back
and forth between two different overlays (or an overlay and a legacy
preset) only needs the second one to change.

The canvas preview shows live game data only while viewing the overlay's
currently-active version — editing an older version, or an unsaved new
overlay, falls back to a static layout-only preview, since there's no
real URL that would reflect content nothing has published yet.

### The locked Scorebug default

`overlays/overlay_daca270d.json` ("Scorebug") is tracked in git and marked
`locked: true`. It is the house scorebug: the server answers `423` to any edit route for
it, and in the editor Delete, blocks and logos are disabled. Its code can
still be edited and **Save as copy** writes the result to a new, unlocked
overlay (named from the rename box if open, else "Scorebug copy"). There
is no time-based versioning any more: an overlay has one version and Save
overwrites it in place. Change it by editing
the file's block `html` directly, then `POST /api/display/reload` (or the
control page's "Refresh display page") to pick it up on the kiosk. Earlier
versions and the old overlays live in `overlays/archive/`.

### Live data binding

Mark any element with `data-role="teamName|score|clock|penalties|
timeouts|timeoutCount|penaltyCount|timeoutBanner|penaltyBanner"` and, where
relevant, `data-side="left|right"`. Everything else renders exactly as
pasted, unchanged — a document can be purely decorative, partially live, or
fully live, author's choice. See [docs/sync.md](sync.md) for what each role
resolves to.

#### Timeout & penalty banners

`timeoutBanner` with `data-side` shows the word `Timeout` next to whichever
team called a timeout, and hides when the timeout is over (no countdown on
screen, by design). `penaltyBanner` is a three-phase announcement: it comes
out reading `Penalty`, the word changes to the player's name (skipped when
nobody was credited), then to the severity (`MINOR`, `MAJOR`, `TURNOVER`,
`EJECTED`), 2 seconds per phase, and then it hides.

Both are transient — unlike every other role, they don't always resolve to
something to display. `overlay-bind.js` toggles a bare `data-live-hidden`
attribute on the node instead of forcing `display:none` directly, so the
author's own CSS controls what "hidden" looks like: an instant cut, a fade,
a slide-out, whatever fits the design. **Always include a CSS rule for
`[data-live-hidden]`** — without one, the node has nothing telling it to
disappear and sits visible (with stale or empty text) even when there's
nothing to show.

**Also give the element `data-live-hidden` in the pasted markup itself**,
not just in CSS. `overlay-bind.js` only *toggles* the attribute reactively
when the underlying data changes — it never sets an initial state on page
load. Without `data-live-hidden` already on the tag, the node starts in
its *visible* position (just empty), so the very first time real content
arrives it snaps straight into place instead of transitioning in from
hidden — a real, easy-to-hit bug, not a style choice. Starting hidden in
the markup is what gives the browser a genuine "before" state to animate
*from*.

**Also give the banner a fixed `width`** (and `box-sizing: border-box`).
These nodes start empty and get real text set into them the moment they
activate — an unsized box grows from 0 to its final width *instantly* (no
transition on size) at the same time it's supposed to be sliding, which
reads as the whole banner "popping"/resizing rather than smoothly sliding
in. A fixed width means only *position* ever changes.

```html
<style>
  .timeout-banner, .penalty-banner {
    color: #fff; font-weight: bold; padding: 8px 20px; font-size: 22px;
    width: 220px; box-sizing: border-box; text-align: left;
    transform: translateX(0);
    transition: transform 0.5s ease-out;
  }
  .timeout-banner { background: #1e3a8a; }
  .penalty-banner { background: #c0392b; }

  /* Each side slides out AWAY from its own team's box, not both toward
     the same edge. */
  [data-side="left"].timeout-banner[data-live-hidden],
  [data-side="left"].penalty-banner[data-live-hidden] {
    transform: translateX(-120px); pointer-events: none;
  }
  [data-side="right"].timeout-banner[data-live-hidden],
  [data-side="right"].penalty-banner[data-live-hidden] {
    transform: translateX(120px); pointer-events: none;
  }
</style>

<div class="timeout-banner" data-role="timeoutBanner" data-side="left" data-live-hidden></div>
<div class="penalty-banner" data-role="penaltyBanner" data-side="left" data-live-hidden></div>
```

(mirror both with `data-side="right"` for the other team — and the
opposite-direction CSS rule above already handles that side's slide
direction.) Position them with ordinary CSS, same as any other element
here — e.g. absolutely positioned next to that side's `teamName` box.

The penalty banner never shows a countdown number, by design: a real
penalty's active window depends on how long the referee takes to inform
players and reset positions, which isn't something any sync provider's feed
can tell us — showing a fake countdown would imply precision we don't have.
It's an announcement only (`PENALTY_PHASE_MS` in `overlay-bind.js`, 2s per
phase). Which penalties are new is decided in the browser, by id, against
`gameState.penaltyLog` (the current game's penalties as the provider reports
them): the first update a page sees, and the first update of every new game,
is taken as history and never announced, so a reload or a server restart
never replays a game. If more than one penalty lands for the same side in a
single update, each one queues and plays out in full — the banner stays out
and restarts the sequence for the next one — so a real penalty call is never
dropped just because the feed batched it with another.

The timeout banner is driven by `gameState.activeTimeout`, which server.js
derives per provider: Podium reports the timeout in progress directly;
Shufflepolo's console stops the clock when a timeout is called and ends the
timeout when the clock is started again, so the banner shows while the
newest timeout is more recent than the last clock run and the clock is
paused, with the platform's fixed 120-second timeout as a ceiling.

## Logos

Logo images are uploaded as PNGs (`POST /api/logos`, field name `logo`,
10MB limit) and served statically from `public/logos/`.

Every upload is normalized server-side before being saved:

1. **Hard alpha threshold** — any pixel ≥50% opacity becomes fully opaque,
   anything below becomes fully transparent. This happens *before*
   flattening.
2. **Flatten against pure black** (`#000000`), producing a 3-channel PNG
   with no alpha channel at all.

This exists because the ATEM keys on **luma** (black = transparent), not
true alpha — a naive upload with anti-aliased or semi-transparent edges
would blend those edge pixels to dark gray, which looks fine in a browser
but shows up as a visible fringe/halo on a hard luma key. Thresholding
before flattening means only pure black or pure source color ever reaches
the final file, regardless of how the source PNG was originally exported
or matted.

Once uploaded, a logo is placed on the overlay's canvas and positioned
with Resolve-style **Transform** controls rather than a plain x/y/width/
height box:

- **Zoom X / Zoom Y** — percentage of the uploaded image's native size
  (100 = native), with a link toggle for uniform scaling
- **Position X / Position Y** — pixel offset from the canvas **center**
  (960, 540 on the fixed 1920×1080 canvas), not the top-left corner
- **Rotation** — degrees

Drag the logo directly on the canvas to move it, its corner handle to
scale, or the handle above it to rotate — the Transform panel's fields
update live either way. Logos are composited server-side into
`/overlay/:id`'s served HTML as absolutely-positioned `<img>` tags, so
they show up correctly wherever that URL is opened, not just in the
editor's own preview.

## Related files

- `public/overlay-editor.html` — the editor UI (HTML/CSS textarea, canvas
  preview, logo transform panel)
- `public/overlay-bind.js` — injected into every served `/overlay/:id`
  page; walks `[data-role]` nodes and keeps them in sync with live
  `gameState` over the same `resolveBinding()`/`computeClockDisplay()`
  logic `/display` uses (see `public/scorebug-render.js`)
- `overlays/`, `public/logos/` — gitignored; created on first use
