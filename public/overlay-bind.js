// Injected into every /overlay/:id page (see server.js's GET /overlay/:id),
// right after socket.io.js and scorebug-render.js. Makes a pasted,
// self-contained HTML document live without the author needing to write
// any JS themselves: scans for [data-role] elements and keeps their text
// content in sync with the real gameState, using the exact same
// resolveBinding()/computeClockDisplay() the preset-based /display uses.
//
// Convention: data-role="teamName|score|clock|penalties|timeouts|
// timeoutCount|penaltyCount|timeoutBanner|penaltyBanner" and, where
// relevant, data-side="left|right". Anything without a data-role is left
// completely untouched - a pasted document can be as much or as little
// live as the author wants.
//
// timeoutBanner/penaltyBanner are transient, unlike every other role: a
// data-live-hidden attribute is toggled on the node when there's nothing to
// show (no active timeout / no penalty being announced for that side), and
// the author's own CSS decides what that means visually (display:none, a
// fade, a slide - see docs/scorebug-editor.md) rather than this script
// forcing display:none directly, so a custom show/hide transition stays
// possible.
//
// Deliberately much dumber than renderPreset(): no x/y/w/h layout, no
// autoSize, no element array - the author's own HTML/CSS IS the layout.
// This only ever touches textContent and the data-live-hidden attribute.
"use strict";

(function () {
  const socket = io();
  let latestGameState = null;

  // ------------------------------------------------------- penalty banner
  //
  // A penalty is announced as one banner that slides out once and changes
  // its word in three phases - "Penalty", then the player's name (skipped
  // when nobody was credited), then the severity - then slides back in.
  //
  // Which penalties are new is decided here, by id, against
  // gameState.penaltyLog (the current game's penalties as the provider
  // reports them right now - see server.js). The first state this page
  // sees, and the first state of every new game, seeds the "already shown"
  // set silently, so a page reload or a server restart never replays the
  // game's history. After that, an id not yet seen is a penalty to announce.
  //
  // Queued per side, not last-one-wins: one update can carry several real
  // penalties for the same side (two calls close together, a late poll),
  // each with its own player/severity. Each plays out in full; while the
  // queue is non-empty the banner stays out and restarts the sequence for
  // the next one rather than sliding in and out between them.
  const PENALTY_PHASE_MS = 2000;
  const penaltyQueues = { left: [], right: [] }; // side -> [{phases: [text, ...]}, ...]
  const penaltyAnnouncements = { left: null, right: null }; // side -> {phases, startedAt}
  let seenPenaltyIds = new Set();
  let seenGameId = null;
  let seeded = false;

  function penaltyPhases(penalty) {
    const phases = ["Penalty"];
    if (penalty.player) phases.push(penalty.player);
    const label = PENALTY_SEVERITY_LABEL[penalty.severity];
    phases.push(label || (penalty.severity ? String(penalty.severity).toUpperCase() : "Penalty"));
    return phases;
  }

  function notePenalties(gameState) {
    const log = gameState.penaltyLog;
    const gameId = log ? log.gameId : null;
    const items = (log && log.items) || [];
    if (!seeded || gameId !== seenGameId) {
      seenPenaltyIds = new Set(items.map(p => p.id));
      seenGameId = gameId;
      seeded = true;
      return;
    }
    for (const penalty of items) {
      if (penalty.id == null || seenPenaltyIds.has(penalty.id)) continue;
      seenPenaltyIds.add(penalty.id);
      if (penalty.side !== "left" && penalty.side !== "right") continue;
      penaltyQueues[penalty.side].push({ phases: penaltyPhases(penalty) });
    }
  }

  // The text the side's penalty banner should show right now, or null to
  // hide it. Advances phases by elapsed time and starts the next queued
  // announcement the moment the current one ends.
  function penaltyTextFor(side, now) {
    let current = penaltyAnnouncements[side];
    if (current) {
      const phase = Math.floor((now - current.startedAt) / PENALTY_PHASE_MS);
      if (phase < current.phases.length) return current.phases[phase];
      current = penaltyAnnouncements[side] = null;
    }
    const next = penaltyQueues[side].shift();
    if (!next) return null;
    penaltyAnnouncements[side] = { phases: next.phases, startedAt: now };
    return next.phases[0];
  }

  // ------------------------------------------------------- timeout banner
  //
  // gameState.activeTimeout is {side, remainingSeconds} or null, worked out
  // by server.js from the provider's data at the moment of the update
  // (Shufflepolo: a timeout stops the clock and ends when the clock runs
  // again, with a 120 s ceiling; Podium reports the countdown directly).
  // Updates only arrive when something changed, so the ceiling is counted
  // down locally from the update's arrival rather than waiting for one.
  function timeoutActiveFor(side) {
    const at = latestGameState.activeTimeout;
    if (!at || at.side !== side) return false;
    const elapsed = (Date.now() - latestGameState._activeTimeoutAnchorAt) / 1000;
    return at.remainingSeconds - elapsed > 0;
  }

  // ------------------------------------------------------------ rendering

  function boundNodes() {
    return document.querySelectorAll("[data-role]");
  }

  function setLiveHidden(node, hidden) {
    if (hidden) node.setAttribute("data-live-hidden", "");
    else node.removeAttribute("data-live-hidden");
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function renderPenaltyBanner(node, now) {
    const text = penaltyTextFor(node.dataset.side || null, now);
    setLiveHidden(node, text == null);
    if (text != null) setText(node, text);
  }

  function renderTimeoutBanner(node) {
    const side = node.dataset.side || null;
    const active = timeoutActiveFor(side);
    setLiveHidden(node, !active);
    if (active) setText(node, resolveBinding("timeoutBanner", side, latestGameState, null) || "Timeout");
  }

  function renderNode(node) {
    const role = node.dataset.role;
    const side = node.dataset.side || null;
    if (!latestGameState) return;
    if (role === "penaltyBanner") return renderPenaltyBanner(node, Date.now());
    if (role === "timeoutBanner") return renderTimeoutBanner(node);
    node.textContent = resolveBinding(role, side, latestGameState, null);
    shrinkToFit(node);
  }

  // Team names (and any other single-line data-role text) come from
  // whatever the real roster/platform data says - an author's pasted CSS
  // sizes its box/font against whatever placeholder text they happened to
  // test with (often short, like "Hammers"), so a longer real name
  // wrapping to a second line - breaking a fixed-height single-row layout
  // - is a near-certain live-game surprise, not an edge case. Rather than
  // require every overlay author to hand-tune font-size for worst-case
  // name length, every data-role text node gets this generically: force
  // single-line (no wrap), then shrink font-size in integer px steps
  // until it fits the node's own width, down to a floor that keeps it
  // legible rather than shrinking to nothing for a truly long name.
  // Grows back toward the CSS-authored size first (not just shrinks),
  // since a later update's text might be SHORTER than a previous one that
  // triggered shrinking (e.g. a team name correction, or switching games).
  const SHRINK_FLOOR_PX = 10;
  const SHRINK_STEP_PX = 1;
  const naturalFontSizeCache = new WeakMap(); // node -> the CSS-authored font-size, read once

  function shrinkToFit(node) {
    if (!node.textContent) return;
    node.style.whiteSpace = "nowrap";
    const computed = getComputedStyle(node);
    if (!naturalFontSizeCache.has(node)) {
      naturalFontSizeCache.set(node, parseFloat(computed.fontSize));
    }
    const naturalSize = naturalFontSizeCache.get(node);
    // Reset to the natural size first - this update's text may fit fine
    // even if a previous update's (longer) text didn't.
    node.style.fontSize = naturalSize + "px";
    let size = naturalSize;
    while (node.scrollWidth > node.clientWidth && size > SHRINK_FLOOR_PX) {
      size -= SHRINK_STEP_PX;
      node.style.fontSize = size + "px";
    }
  }

  function renderAll() {
    boundNodes().forEach(renderNode);
  }

  // Same 250ms clock-tick cadence as display.html: the clock interpolates
  // between updates, the timeout ceiling counts down, and penalty phases
  // advance - none of which get an update of their own from the server.
  setInterval(() => {
    if (!latestGameState) return;
    latestGameState._currentClock = latestGameState.clock
      ? { ...latestGameState.clock, localAnchorAt: latestGameState._clockAnchorAt }
      : null;
    document.querySelectorAll('[data-role="clock"]').forEach(node => {
      setText(node, computeClockDisplay(latestGameState._currentClock || null).text);
    });
    document.querySelectorAll('[data-role="timeoutBanner"]').forEach(renderTimeoutBanner);
    const now = Date.now();
    document.querySelectorAll('[data-role="penaltyBanner"]').forEach(node => renderPenaltyBanner(node, now));
  }, 250);

  socket.on("gameUpdate", (gameState) => {
    // Anchor the clock to this device's receipt time - see display.html's
    // own identical comment on gameState._clockAnchorAt for why this must
    // happen before anything else touches the clock.
    gameState._clockAnchorAt = Date.now();
    gameState._currentClock = gameState.clock ? { ...gameState.clock, localAnchorAt: gameState._clockAnchorAt } : null;
    // Same receipt-time anchoring for the timeout ceiling.
    gameState._activeTimeoutAnchorAt = Date.now();
    notePenalties(gameState);
    latestGameState = gameState;
    renderAll();
  });
})();
