# Scorebug Editor (`/editor`)

A visual, canvas-based editor for designing the scorebug layout shown on
`/display` — an alternative to hand-editing `public/scorebug-render.js` or
`display.html` to change the look of the on-air scoreboard.

## Presets

A **preset** is a named scorebug design, stored as its own file in
`presets/` (`preset_<random>.json`). Each preset holds:

- `canvas` — overall canvas settings
- `elements` — the shapes/text/logo elements making up the design
- `versions` — every saved version of the design, each with its own
  `canvas`/`elements` snapshot and timestamp
- `activeVersion` — which version is actually live

Saving a new draft (`POST /api/presets/:id/versions`) always appends a new
version rather than overwriting — so earlier versions stay available to
roll back to. Making a draft live is a separate, explicit step
(`PUT /api/presets/:id/active-version`); if that preset happens to be the
one currently selected on the broadcast, re-pointing `activeVersion` is
what `/display` actually re-renders from on its next update.

Which preset is live on the broadcast itself is tracked separately, via
`gameState.activePresetId` (set through the `setActivePreset` socket
event) — not implied by any preset's own `activeVersion`.

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

## Related files

- `public/editor.html` — the editor UI itself
- `public/scorebug-render.js` — shared rendering logic between the editor's
  live preview and the actual `/display` output
- `presets/`, `public/logos/` — gitignored; created on first use
