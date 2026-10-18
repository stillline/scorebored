"use strict";
// Shared rendering/data-binding logic for the scorebug system. Two
// consumers: public/display.html (renderPreset/tickClockElements, for the
// legacy element-based preset layout still supported for backward
// compatibility) and public/overlay-bind.js (resolveBinding/
// computeClockDisplay only, for the [data-role] live-binding on pasted
// HTML overlays - see docs/sync.md and docs/scorebug-editor.md). Both
// paths share the exact same gameState -> display-text resolution, so
// they can never drift apart by having two hand-kept implementations.
//
// Everything here is pure / stateless except where explicitly noted (the
// clock helpers take an externally-anchored clock object rather than
// tracking time themselves, so callers own their own render loop).

// ---------------------------------------------------------------- clock
//
// Each sync provider pushes its own native clock shape into gameState.clock
// rather than a common one, and each is kept in sync with the real game
// clock by a different means:
//
//   Podium:       { running, phase, remaining_seconds, formatted, ... }
//                 pushed on discrete events (goal, penalty, start/stop) PLUS
//                 a 100ms re-push ticker while running, so remaining_seconds
//                 is never more than ~100ms stale - interpolating the small
//                 gap locally (from THIS device's own receipt time) is a
//                 fine approximation at that push rate.
//
//   Shufflepolo:  { status, elapsed_seconds, running_since, duration_seconds,
//                   server_now }
//                 pushed only on realtime signals (score/clock change) -
//                 could be many seconds or minutes between pushes, so
//                 interpolating from local receipt time would accumulate
//                 real drift from anything that delays the moment this
//                 device actually processes a push (a slow preset fetch, a
//                 busy event loop, network jitter) - see the incident this
//                 is fixing, where switching presets visibly desynced the
//                 clock from Shufflepolo's own site.
//
//                 Instead, elapsed time is computed as
//                 (their-clock-right-now - running_since), where "their
//                 clock right now" is this device's Date.now() plus
//                 clock_offset_ms - a clock-sync offset MEASURED ONCE, as
//                 close as possible to the real network round trip, by
//                 shufflepolo_sync.js (see its updateClockOffset: a
//                 t0/t1-bracketed request, offset = server_now -
//                 midpoint(t0,t1), keeping only the fastest round trip
//                 seen). Per a Shufflepolo dev's own analysis of our
//                 drift: computing that offset any later - e.g. here in
//                 the browser, against a server_now that already crossed
//                 this process's own POST + this server's socket
//                 broadcast - bakes in however long those extra hops took
//                 as permanent (and different every time) error. Using a
//                 precomputed offset instead of a raw server_now means
//                 nothing downstream of the original round trip ever
//                 re-measures skew against stale data.

function secondsFromPodiumClock(clock, elapsedSeconds) {
  if (!clock.running) return { secs: clock.remaining_seconds, overtime: clock.phase === "overtime" };
  if (clock.phase === "overtime") {
    return { secs: Math.floor(clock.remaining_seconds + elapsedSeconds), overtime: true };
  }
  return { secs: Math.max(Math.ceil(clock.remaining_seconds - elapsedSeconds), 0), overtime: false };
}

// skewCorrectedNowMs: this device's current time, adjusted by the skew
// measured against Shufflepolo's server_now at push receipt - i.e. "what
// Shufflepolo's own clock reads right now", not this device's.
function secondsFromShufflepoloClock(clock, skewCorrectedNowMs) {
  const running = clock.status === "running";
  const runningSinceMs = Date.parse(clock.running_since);
  const elapsedSinceRunningStart = running && !isNaN(runningSinceMs)
    ? Math.max(0, (skewCorrectedNowMs - runningSinceMs) / 1000)
    : 0;
  const played = clock.elapsed_seconds + elapsedSinceRunningStart;
  if (clock.duration_seconds == null) {
    return { secs: Math.max(Math.floor(played), 0), overtime: false, running };
  }
  return { secs: Math.max(Math.ceil(clock.duration_seconds - played), 0), overtime: false, running };
}

// currentClock: gameState.clock spread with a localAnchorAt (Date.now() at
// receipt), or null. Returns { text, stopped } - stopped is true when the
// clock should render dim/paused styling.
// TEMPORARY debug instrumentation for tracking down a live clock-desync
// report (editor/display/Shufflepolo's own site disagreeing after Save +
// Set Active) - logs at most once every CLOCK_DEBUG_INTERVAL_MS per page,
// tagged with window.CLOCK_DEBUG_LABEL (set that in each page's console,
// e.g. CLOCK_DEBUG_LABEL="editor", to tell surfaces apart in a shared log).
// Remove this block once the bug's confirmed fixed.
const CLOCK_DEBUG_INTERVAL_MS = 2000;
let _lastClockDebugLogAt = 0;
function debugLogClock(currentClock, result){
  if (typeof window === "undefined" || !window.CLOCK_DEBUG) return;
  const now = Date.now();
  if (now - _lastClockDebugLogAt < CLOCK_DEBUG_INTERVAL_MS) return;
  _lastClockDebugLogAt = now;
  const label = window.CLOCK_DEBUG_LABEL || "?";
  console.log("[clock:" + label + "]", {
    now: new Date(now).toISOString(),
    status: currentClock && currentClock.status,
    running_since: currentClock && currentClock.running_since,
    elapsed_seconds: currentClock && currentClock.elapsed_seconds,
    duration_seconds: currentClock && currentClock.duration_seconds,
    clock_offset_ms: currentClock && currentClock.clock_offset_ms,
    result: result.text,
  });
}

// Shared by the main clock and timeoutBanner - plain "M:SS", no sign/
// padding beyond seconds (a timeout never runs into overtime, so this never
// needs computeClockDisplay's "+" prefix handling).
function formatMinutesSeconds(totalSeconds) {
  const secs = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  return mm + ":" + ss;
}

function computeClockDisplay(currentClock) {
  // "--:--" rather than "" - an empty string measures to ~0 width, which
  // collapses an autoSized clock element down to the Math.max(1,...) floor
  // (a near-invisible 1x1px box) whenever there's no live game, instead of
  // just showing no time. A placeholder keeps the box's size (and
  // visibility) stable regardless of whether a game is currently running.
  if (!currentClock) return { text: "--:--", stopped: true };

  const isShufflepolo = currentClock.status !== undefined;
  let secs, overtime, running;
  if (isShufflepolo) {
    // Falls back to 0 (trust local time as-is) if clock_offset_ms wasn't
    // sent - shouldn't happen with a current shufflepolo_sync.js, but a
    // mid-rollout mismatch or an old cached push shouldn't hard-fail the
    // clock.
    const offsetMs = typeof currentClock.clock_offset_ms === "number" ? currentClock.clock_offset_ms : 0;
    const skewCorrectedNowMs = Date.now() + offsetMs;
    ({ secs, overtime, running } = secondsFromShufflepoloClock(currentClock, skewCorrectedNowMs));
  } else {
    const elapsedSeconds = (Date.now() - currentClock.localAnchorAt) / 1000;
    ({ running } = currentClock);
    ({ secs, overtime } = secondsFromPodiumClock(currentClock, elapsedSeconds));
  }

  const formatted = formatMinutesSeconds(secs);
  const result = { text: overtime ? "+" + formatted : formatted, stopped: !running };
  debugLogClock(currentClock, result);
  return result;
}

// -------------------------------------------------------------- penalties

// penalties: [{player, severity, remaining_seconds, frozen}, ...] per side
function fmtPenTime(p) {
  if (p.frozen) return "--";
  const t = Math.max(0, Math.ceil(p.remaining_seconds));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}

function formatPenalties(leftPens, rightPens) {
  const fmt = (side, pens) => (pens || []).map(p => side + " " + (p.player || p.severity || "PEN") + " " + fmtPenTime(p)).join("  ·  ");
  const parts = [fmt("A", leftPens), fmt("B", rightPens)].filter(Boolean);
  return parts.join("   ");
}

function formatTimeouts(leftTO, rightTO) {
  return (leftTO ?? 0) + " - " + (rightTO ?? 0);
}

// Per-side counts (as opposed to "timeouts"/"penalties" above, which render
// both sides combined in one string) - for a preset that wants independent,
// separately-positioned left/right elements, same as teamName/score already
// support via `side`.
function countTimeouts(timeoutsForSide) {
  return String(timeoutsForSide ?? 0);
}

function countPenalties(penaltiesForSide) {
  return String((penaltiesForSide || []).length);
}

// -------------------------------------------------------------- penalties
//
// Penalty severity as server.js normalizes it for every provider (Podium
// reports it directly; Shufflepolo's codes are mapped in
// applyShufflepoloSnapshot), to the word the penaltyBanner shows.
const PENALTY_SEVERITY_LABEL = {
  minor: "MINOR",
  major: "MAJOR",
  turnover: "TURNOVER",
  ejection: "EJECTED",
};

// ------------------------------------------------------------ role binding
//
// The only code that knows gameState's literal field names. A preset
// element names a role+side ("score"/"left") rather than a gameState path,
// so gameState can be restructured later without migrating every saved
// preset - only this function would need to change.

function resolveBinding(role, side, gameState, element) {
  const penalties = gameState.penalties || {};
  const timeouts = gameState.timeouts || {};
  switch (role) {
    case "label":
      // A static caption with no gameState binding - element.text.content is
      // free text typed in the editor's props panel (e.g. "HOME" above a
      // score, or a sponsor line). Unlike every other role, its value lives
      // on the element itself, not derived from live game data.
      return (element && element.text && element.text.content) || "";
    case "teamName":
      return side === "left" ? (gameState.leftTeam || "") : (gameState.rightTeam || "");
    case "score":
      return String(side === "left" ? (gameState.leftScore ?? 0) : (gameState.rightScore ?? 0));
    case "clock":
      return computeClockDisplay(gameState._currentClock || null).text;
    case "timeouts":
      return formatTimeouts(timeouts.left, timeouts.right);
    case "penalties":
      return formatPenalties(penalties.left, penalties.right);
    case "timeoutCount":
      return countTimeouts(side === "left" ? timeouts.left : timeouts.right);
    case "penaltyCount":
      return countPenalties(side === "left" ? penalties.left : penalties.right);
    case "timeoutBanner": {
      // gameState.activeTimeout: {side, remainingSeconds} | null - a real,
      // ongoing countdown (see applyPodiumSnapshot/applyShufflepoloSnapshot
      // in server.js), unlike penaltyBanner below. null here (not "") is
      // the signal overlay-bind.js uses to hide the node - see its
      // data-live-hidden handling.
      // No countdown on screen (operator decision): the word only.
      const at = gameState.activeTimeout;
      if (!at || at.side !== side) return null;
      return "Timeout";
    }
    case "penaltyBanner":
      // Deliberately NOT resolved here - a penalty's real active window
      // depends on referee timing the feed never exposes, so unlike
      // timeoutBanner there is no gameState-backed "is it still active" to
      // check (see docs/scorebug-editor.md). overlay-bind.js's renderNode
      // special-cases this role entirely, reading its own local, fixed-
      // duration announcement timer instead of calling resolveBinding.
      return null;
    default:
      return "";
  }
}

// ------------------------------------------------------------ text measuring
//
// A single offscreen span, reused across calls, measured via
// getBoundingClientRect() with the exact same font/weight/letterSpacing/
// transform/whiteSpace as the real node so its natural size matches
// pixel-for-pixel. Shared by the editor canvas and the real display.

let measureSpan = null;
function measureText(value, t, whiteSpace) {
  if (!measureSpan) {
    measureSpan = document.createElement("span");
    measureSpan.style.position = "absolute";
    measureSpan.style.visibility = "hidden";
    measureSpan.style.left = "-99999px";
    measureSpan.style.top = "-99999px";
    document.body.appendChild(measureSpan);
  }
  measureSpan.style.fontFamily = t.fontFamily || "inherit";
  measureSpan.style.fontSize = (t.fontSizePx || 24) + "px";
  measureSpan.style.fontWeight = t.fontWeight || 400;
  measureSpan.style.letterSpacing = (t.letterSpacing || 0) + "px";
  measureSpan.style.textTransform = t.textTransform || "none";
  measureSpan.style.whiteSpace = whiteSpace;
  measureSpan.textContent = value;
  const rect = measureSpan.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

// ----------------------------------------------------- shape/polygon style
//
// Shared by both the "shape" (rect, CSS-rendered) and "polygon" (arbitrary
// point list, SVG-rendered) element types - same fill/gradient/border/
// shadow schema either way, since there's no reason a box and a freeform
// shape should have two different style vocabularies for the same visual
// idea. A plain solid fill and a gradient are mutually exclusive in CSS
// terms (background-color vs. a background-image gradient layered on top),
// so gradient wins when both are present - see the preset element's own
// gradient.enabled flag, which the editor toggles exclusively.

// CSS/SVG both accept an angle-based linear-gradient() function; SVG needs
// it wrapped in a <linearGradient> def instead, built separately in
// buildPolygonNode. This builds just the CSS background-image form.
function gradientCss(gradient) {
  const stops = (gradient.stops || []).map(s => s.color + " " + (s.offset ?? 0) + "%").join(", ");
  return "linear-gradient(" + (gradient.angle ?? 180) + "deg, " + stops + ")";
}

function boxShadowCss(shadow) {
  if (!shadow || !shadow.enabled) return "none";
  const color = shadow.color || "#000000";
  const alpha = shadow.opacity ?? 0.5;
  const rgba = hexToRgba(color, alpha);
  return (shadow.offsetX ?? 0) + "px " + (shadow.offsetY ?? 4) + "px " + (shadow.blur ?? 8) + "px 0 " + rgba;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "rgba(0,0,0," + alpha + ")";
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

// Applies fill/gradient/border/shadow to a plain rectangular node (the
// "shape" element type). Corner radius is CSS border-radius, which has no
// SVG polygon equivalent - that styling knob only exists on rectangles.
function applyShapeStyle(node, element) {
  node.style.borderRadius = (element.cornerRadius ?? 0) + "px";
  if (element.gradient && element.gradient.enabled) {
    node.style.backgroundImage = gradientCss(element.gradient);
    node.style.backgroundColor = "";
  } else {
    node.style.backgroundImage = "";
    node.style.backgroundColor = (element.fill && element.fill.color) || "transparent";
  }
  const border = element.border || {};
  node.style.border = border.width ? border.width + "px solid " + (border.color || "#000000") : "none";
  node.style.boxShadow = boxShadowCss(element.shadow);
}

// Builds the <svg> node for a "polygon" element. element.points is a list
// of {x,y} in CANVAS space (not relative to a bounding box, unlike every
// other element type) - the SVG itself is sized/positioned to exactly
// bound those points, with each point's coordinates then expressed
// relative to that bounding box's own top-left, so the element behaves
// like any other for drag/select purposes despite the underlying shape
// data being absolute points.
function polygonBounds(points) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const x1 = Math.max(...xs), y1 = Math.max(...ys);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function buildPolygonNode(element) {
  const points = element.points || [];
  const bounds = polygonBounds(points.length ? points : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", bounds.w);
  svg.setAttribute("height", bounds.h);
  svg.style.overflow = "visible"; // a drop shadow's blur extends past the point bounds

  const poly = document.createElementNS(SVG_NS, "polygon");
  poly.setAttribute("points", points.map(p => (p.x - bounds.x) + "," + (p.y - bounds.y)).join(" "));

  if (element.gradient && element.gradient.enabled) {
    const defs = document.createElementNS(SVG_NS, "defs");
    const grad = document.createElementNS(SVG_NS, "linearGradient");
    const gradId = "grad_" + element.id;
    grad.setAttribute("id", gradId);
    // CSS linear-gradient()'s angle is clockwise from "up"; SVG's x1/y1/x2/y2
    // go the other way around a unit square - converting through sin/cos
    // keeps the editor's single angle field meaning the same thing in both
    // the live SVG polygon and the CSS-rendered shape preview.
    const rad = ((element.gradient.angle ?? 180) - 90) * Math.PI / 180;
    const x2 = 50 + 50 * Math.cos(rad), y2 = 50 + 50 * Math.sin(rad);
    const x1 = 50 - 50 * Math.cos(rad), y1 = 50 - 50 * Math.sin(rad);
    grad.setAttribute("x1", x1 + "%"); grad.setAttribute("y1", y1 + "%");
    grad.setAttribute("x2", x2 + "%"); grad.setAttribute("y2", y2 + "%");
    (element.gradient.stops || []).forEach(s => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", (s.offset ?? 0) + "%");
      stop.setAttribute("stop-color", s.color);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);
    poly.setAttribute("fill", "url(#" + gradId + ")");
  } else {
    poly.setAttribute("fill", (element.fill && element.fill.color) || "transparent");
  }

  const border = element.border || {};
  if (border.width) {
    poly.setAttribute("stroke", border.color || "#000000");
    poly.setAttribute("stroke-width", border.width);
  }
  if (element.shadow && element.shadow.enabled) {
    const alpha = element.shadow.opacity ?? 0.5;
    poly.style.filter = "drop-shadow(" + (element.shadow.offsetX ?? 0) + "px " + (element.shadow.offsetY ?? 4) + "px " +
      (element.shadow.blur ?? 8) + "px " + hexToRgba(element.shadow.color || "#000000", alpha) + ")";
  }

  svg.appendChild(poly);
  return { svg, bounds };
}

// ---------------------------------------------------------- element render
//
// Given one preset element and its resolved live value, produce a styled,
// absolutely-positioned DOM node. Used for both the editor's canvas and the
// real display - the only difference between the two is which gameState
// (live vs. a static mock) feeds resolveBinding.
//
// When element.text.autoSize is set, the element's x/y/w/h are rewritten
// in place (mutating the preset element, not just the rendered node) to
// hug the resolved text's natural size, recentered on the box's previous
// center - so drag/save persist the derived box like any other edit, and
// repeated resizes as text changes (e.g. a score going 9 -> 10) keep
// re-centering from wherever the box currently sits rather than drifting
// from some other fixed point.

function renderElement(element, value) {
  const node = document.createElement("div");
  node.dataset.elId = element.id;
  node.style.position = "absolute";
  node.style.zIndex = element.z ?? 0;
  node.style.display = element.visible === false ? "none" : "block";

  if (element.type === "image") {
    node.style.left = element.x + "px";
    node.style.top = element.y + "px";
    node.style.width = element.w + "px";
    node.style.height = element.h + "px";
    node.style.opacity = element.opacity ?? 1;
    const img = document.createElement("img");
    img.src = "/logos/" + element.assetId;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    node.appendChild(img);
    return node;
  }

  if (element.type === "shape") {
    node.style.left = element.x + "px";
    node.style.top = element.y + "px";
    node.style.width = element.w + "px";
    node.style.height = element.h + "px";
    node.style.opacity = element.opacity ?? 1;
    applyShapeStyle(node, element);
    return node;
  }

  if (element.type === "polygon") {
    // The element's own x/y aren't used for layout here - points are
    // absolute canvas coordinates, and the SVG is placed at their bounding
    // box directly (see buildPolygonNode) - but x/y/w/h are still kept in
    // sync below so every other piece of editor chrome that reads an
    // element's box (the properties panel, marquee-select hit testing,
    // snap-guide candidates) keeps working without having to know polygons
    // are special.
    const { svg, bounds } = buildPolygonNode(element);
    element.x = bounds.x; element.y = bounds.y; element.w = bounds.w; element.h = bounds.h;
    node.style.left = bounds.x + "px";
    node.style.top = bounds.y + "px";
    node.style.width = bounds.w + "px";
    node.style.height = bounds.h + "px";
    node.style.opacity = element.opacity ?? 1;
    node.appendChild(svg);
    return node;
  }

  // dataText
  const t = element.text || {};
  const whiteSpace = "nowrap";

  if (t.autoSize) {
    const { width, height } = measureText(value, t, whiteSpace);
    const cx = element.x + element.w / 2;
    const cy = element.y + element.h / 2;
    element.w = Math.max(1, Math.round(width));
    element.h = Math.max(1, Math.round(height));
    element.x = Math.round(cx - element.w / 2);
    element.y = Math.round(cy - element.h / 2);
  }

  node.style.left = element.x + "px";
  node.style.top = element.y + "px";
  node.style.width = element.w + "px";
  node.style.height = element.h + "px";
  node.style.fontFamily = t.fontFamily || "inherit";
  node.style.fontSize = (t.fontSizePx || 24) + "px";
  node.style.fontWeight = t.fontWeight || 400;
  node.style.color = t.color || "#FFFFFF";
  node.style.textAlign = t.align || "left";
  node.style.letterSpacing = (t.letterSpacing || 0) + "px";
  node.style.textTransform = t.textTransform || "none";
  node.style.whiteSpace = whiteSpace;
  node.style.overflow = "hidden";
  if (element.fill && element.fill.color) {
    node.style.background = element.fill.color;
    node.style.opacity = element.fill.opacity ?? 1;
  }

  node.textContent = value;
  return node;
}

// Renders every element of a preset into targetEl (cleared first), using
// the given gameState for live bindings. gameState._currentClock, if set,
// should be the clock object (spread with localAnchorAt) used by the
// "clock" role - callers own the render-loop/interpolation timing, this
// just reads whatever's there at call time.
//
// Full teardown/rebuild on every call, so callers should only invoke this
// when the preset or gameState actually changed (e.g. on 'gameUpdate') -
// NOT on every clock tick, which would thrash image <img> elements (src
// reassignment forces a reload) and any other non-text element for no
// reason. Use tickClockElements for the per-frame clock interpolation
// instead; it only touches clock-role nodes' text content in place.
function renderPreset(preset, gameState, targetEl) {
  while (targetEl.firstChild) targetEl.removeChild(targetEl.firstChild);
  (preset.elements || []).forEach(element => {
    // One malformed/unexpected element (a bad binding, a role that throws
    // on edge-case data) must not take out every element after it in the
    // array - an uncaught throw here would abort this whole forEach, which
    // on a real preset looks exactly like "everything past element N just
    // silently stopped appearing" rather than an obvious crash. Logging the
    // element id/role means that failure is diagnosable from the console
    // instead of only showing up as an absence.
    try {
      const value = element.type === "image" ? null : resolveBinding(element.role, element.side, gameState, element);
      const node = renderElement(element, value);
      node.dataset.role = element.role || "";
      targetEl.appendChild(node);
    } catch (e) {
      console.error("renderPreset: failed to render element", element.id, element.role, e);
    }
  });
}

// Cheap per-frame update: re-reads gameState._currentClock and updates only
// clock-role elements' text content, without touching anything else. Safe
// to call on a fast interval (e.g. every 250ms) after renderPreset has
// already built the DOM once.
function tickClockElements(gameState, targetEl) {
  const { text } = computeClockDisplay(gameState._currentClock || null);
  targetEl.querySelectorAll('[data-role="clock"]').forEach(node => {
    node.textContent = text;
  });
}
