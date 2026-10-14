// gel-ed web app: load → edit (tone, geometry) → lanes → bands → overlay.
// Profiles are read from the original pixels through the edit's transform (or, to
// compare, from the resampled edited image): see profilesFromOriginal in bands.js.

import { readImage } from "./image.js?v=f1f68556";
import { matrix, warp, frame, cropValid, clampCrop } from "./transform.js?v=f1f68556";
import { bandCentre, bandsFromProfile, coreColumns, countLanes, findLanes, profilesFromOriginal, DEFAULTS } from "./bands.js?v=f1f68556";
import { greyToImageData, drawOverlay, drawDividers, bandLetter, renderFigure } from "./draw.js?v=f1f68556";
import { median } from "./signal.js?v=f1f68556";
import { bandSolidity, laneBackground, pchip, pickLadderBands } from "./calibrate.js?v=f1f68556";
import { LADDERS } from "./ladders.js?v=f1f68556";
import { drawIcons } from "./icons.js?v=f1f68556";

const $ = (id) => document.getElementById(id);
const GEOMETRY = ["rotation", "skew", "distort", "perspective"];
const TONE = ["brightness", "contrast"];
const BANDS = ["k", "core", "smooth", "noiseRows"];
const LABEL_SPACE = 26; // screen px above the overlay for lane numbers

const state = {
  src: null,        // {grey, w, h, name}
  box: null,        // frame of the edited image: {x0, y0, W, H} (whole transformed image)
  m: null,          // the edit's transform (original pixel -> edited position), transform.js
  warped: null,     // geometry applied, W x H (for display and lane placement)
  edited: null,     // geometry + tone
  crop: null,       // analysed rectangle {x0, y0, x1, y1}, edited-image pixels (inclusive)
  cropUser: false,  // trimmed by hand (otherwise it follows the whole image)
  invert: false,
  bounds: null,     // lane boundaries in crop columns
  countLanes: true, // next analysis estimates the number of lanes (on load and "Find lanes")
  laneNote: "",
  ladders: [],      // one per ladder card: {type (key of LADDERS), lane (1-based), markers, manual, note}
  marks: null,      // per lane: ladder markers to draw [{y, x, kda, ladder, i}]
  picks: [],        // per lane: bands the user marked [{y, created}] (created: no band was found there)
  pickMarks: null,  // per lane: marked bands to draw [{y, x, name, kda, label, created}]
  laneNotes: [],    // per lane: annotation text the user typed (undefined = not edited)
  laneIds: [],      // per lane: lane label (undefined = the lane number)
  groups: [],       // lane groups (one column each): [{name, from, to}] (lane numbers, inclusive; null = none)
  results: null,
  cropImg: null,    // {grey, w, h}
};

// ---------- loading ----------

function setStatus(msg, error = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", error);
}

async function load(file) {
  try {
    setStatus(`Reading ${file.name} …`);
    const { grey, w, h } = await readImage(file);
    state.src = { grey, w, h, name: file.name.replace(/\.[^.]+$/, "") };
    resetEdits(false);
    state.bounds = null;
    state.countLanes = true;
    $("workspace").hidden = false;
    $("edit-stage").style.setProperty("--ar", `${w} / ${h}`); // display box keeps the original's shape
    $("drop").classList.add("compact");
    const light = median(grey.filter((_, i) => i % 97 === 0)) >= 0.5;
    setStatus(`${file.name}: ${w} × ${h} px.` +
      (light ? "" : " This looks like light bands on a dark background: press Invert before reading bands."));
    applyGeometry();
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't read ${file.name}: ${err.message}`, true);
  }
}

// ---------- edits ----------

const value = (id) => parseFloat($(id).value);
const geometry = () => Object.fromEntries(GEOMETRY.map((k) => [k, value(k)]));

function resetEdits(rerun = true) {
  [...GEOMETRY, ...TONE].forEach((id) => { $(id).value = 0; });
  state.invert = false;
  $("invert").setAttribute("aria-pressed", "false");
  state.crop = null;
  state.cropUser = false;
  state.box = null;
  showValues();
  if (rerun) applyGeometry();
}

function applyGeometry() {
  const { grey, w, h } = state.src;
  const m = matrix(w, h, geometry());
  const box = frame(w, h, m);
  const full = { x0: 0, y0: 0, x1: box.W - 1, y1: box.H - 1 };
  if (state.cropUser && state.crop && state.box) {
    // a hand-trimmed rectangle stays on the same part of the image as the frame moves
    const dx = state.box.x0 - box.x0, dy = state.box.y0 - box.y0, c = state.crop;
    const moved = { x0: Math.max(c.x0 + dx, 0), x1: Math.min(c.x1 + dx, box.W - 1),
                    y0: Math.max(c.y0 + dy, 0), y1: Math.min(c.y1 + dy, box.H - 1) };
    state.crop = cropValid(moved, null, box.W, box.H) ? moved : full;
  } else {
    state.crop = full; // the whole image: blank corners just contribute nothing
  }
  if (state.box && (state.box.W !== box.W || state.box.H !== box.H)) state.bounds = null;
  resetLadders();
  state.box = box;
  state.m = m;
  state.warped = warp(grey, w, h, m, box);
  applyTone();
}

// brightness, contrast and invert as one function of a pixel value
function toneFunction() {
  const b = value("brightness");
  const f = Math.tan(((value("contrast") + 1) * Math.PI) / 4); // 0 → ×1; ±0.9 → ×0.08 / ×12.7
  const inv = state.invert;
  return (v) => {
    const t = Math.min(Math.max((v - 0.5) * f + 0.5 + b, 0), 1);
    return inv ? 1 - t : t;
  };
}

function applyTone() {
  const tone = toneFunction();
  state.edited = state.warped.map((v) => (Number.isNaN(v) ? v : tone(v)));
  drawEditor();
  analyse();
}

// ---------- editor canvas and crop ----------

const editCanvas = $("edit-canvas");
let drag = null;

function drawEditor() {
  const { W: w, H: h } = state.box;
  editCanvas.width = w;
  editCanvas.height = h;
  const ctx = editCanvas.getContext("2d");
  ctx.putImageData(greyToImageData(ctx, state.edited, w, h), 0, 0);
  const px = w / (editCanvas.clientWidth || w);
  const c = state.crop;
  ctx.save();
  ctx.fillStyle = "rgba(60, 60, 60, 0.55)"; // grey out everything outside the crop
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.rect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
  ctx.fill("evenodd");
  ctx.strokeStyle = "#2a78d6";
  ctx.lineWidth = 2 * px;
  ctx.strokeRect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
  ctx.fillStyle = "#2a78d6";
  for (const [x, y] of [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]]) {
    ctx.fillRect(x - 5 * px, y - 5 * px, 10 * px, 10 * px);
  }
  ctx.restore();
}

function canvasPoint(canvas, e) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width, sy = canvas.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy, px: sx };
}

function cropHandle(p) {
  const c = state.crop, tol = 12 * p.px;
  const near = (a, b) => Math.abs(a - b) <= tol;
  const inY = p.y >= c.y0 - tol && p.y <= c.y1 + tol, inX = p.x >= c.x0 - tol && p.x <= c.x1 + tol;
  const edges = { x0: near(p.x, c.x0) && inY, x1: near(p.x, c.x1) && inY,
                  y0: near(p.y, c.y0) && inX, y1: near(p.y, c.y1) && inX };
  if (Object.values(edges).some(Boolean)) return edges;
  if (p.x > c.x0 && p.x < c.x1 && p.y > c.y0 && p.y < c.y1) return "move";
  return null;
}

editCanvas.addEventListener("pointerdown", (e) => {
  if (!state.crop) return;
  const p = canvasPoint(editCanvas, e);
  const handle = cropHandle(p);
  if (!handle) return;
  drag = { handle, start: p, crop: { ...state.crop } };
  editCanvas.setPointerCapture(e.pointerId);
});

editCanvas.addEventListener("pointermove", (e) => {
  const p = canvasPoint(editCanvas, e);
  if (!drag) {
    const h = state.crop && cropHandle(p);
    editCanvas.style.cursor = !h ? "default" : h === "move" ? "move" : "crosshair";
    return;
  }
  const dx = p.x - drag.start.x, dy = p.y - drag.start.y, c = drag.crop;
  const want = drag.handle === "move"
    ? { x0: c.x0 + dx, x1: c.x1 + dx, y0: c.y0 + dy, y1: c.y1 + dy }
    : { x0: c.x0 + (drag.handle.x0 ? dx : 0), x1: c.x1 + (drag.handle.x1 ? dx : 0),
        y0: c.y0 + (drag.handle.y0 ? dy : 0), y1: c.y1 + (drag.handle.y1 ? dy : 0) };
  const { W: w, H: h } = state.box;
  const next = clampCrop(state.crop, want, null, w, h);
  state.crop = { x0: Math.ceil(next.x0), y0: Math.ceil(next.y0), x1: Math.floor(next.x1), y1: Math.floor(next.y1) };
  if (!cropValid(state.crop, null, w, h)) state.crop = drag.crop;
  drawEditor();
});

editCanvas.addEventListener("pointerup", () => {
  if (!drag) return;
  drag = null;
  state.cropUser = true;
  state.bounds = null; // area changed: place lanes again
  resetLadders();
  analyse();
});

// ---------- lanes and bands ----------

const overlayCanvas = $("overlay-canvas");
let laneDrag = null;

function bandOptions() {
  return Object.fromEntries(BANDS.map((k) => [k, value(k)]));
}

function cropImage() {
  const w = state.box.W;
  const c = state.crop;
  const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
  const grey = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) grey[y * cw + x] = state.edited[(c.y0 + y) * w + c.x0 + x];
  return { grey, w: cw, h: ch };
}

// Each lane's raw profile (mean darkness per row, NaN where a row has no pixels) and
// near-black fraction, read either from the original pixels through the transform or
// from the resampled edited image.
function laneProfiles() {
  const core = value("core");
  if ($("source").value === "original") {
    const { grey, w, h } = state.src;
    return profilesFromOriginal(grey, w, h, state.m, state.box, state.crop, state.bounds, core,
                                DEFAULTS.satLevel, toneFunction());
  }
  const { grey, w, h } = state.cropImg;
  return lanePairs().map(([s, e]) => {
    const [c0, c1] = coreColumns(s, e, core);
    const mean = new Float64Array(h), black = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let sum = 0, n = 0, b = 0;
      for (let x = c0; x < c1; x++) {
        const v = grey[y * w + x];
        if (Number.isNaN(v)) continue;
        sum += 1 - v; n++;
        if (v <= DEFAULTS.satLevel) b++;
      }
      mean[y] = n ? sum / n : NaN;
      black[y] = n ? b / n : 0;
    }
    return { mean, black };
  });
}

function computeBands() {
  const opts = bandOptions();
  state.results = laneProfiles().map((p) => bandsFromProfile(p.mean, p.black, opts));
  // each band's horizontal middle (where it's marked), measured on the edited image
  const { grey, w, h } = state.cropImg;
  lanePairs().forEach(([s, e], i) => state.results[i].bands.forEach((b) => { b.x = bandCentre(grey, w, h, s, e, b.y); }));
  assignLadders();
}

// ---------- ladders: picking, calibration, masses ----------

// Ladder picks and the user's marked bands start over when the geometry, the analysed
// area or the lanes change (their rows and lanes no longer mean the same thing).
function resetLadders() {
  for (const l of state.ladders) { l.manual = false; l.markers = null; }
  state.picks = [];
}

const fmtKda = (k) => (k >= 10 ? k.toFixed(0) : k.toFixed(1));

// Ladder markers (picked automatically unless moved by hand), each ladder's calibration
// (log10 kDa against row, point-to-point PCHIP as in Python), and every other band's mass
// from the nearest ladder. No correction for lanes running differently yet.
function assignLadders() {
  const { grey, w, h } = state.cropImg;
  const lanes = lanePairs();
  for (const lad of state.ladders) {
    lad.lane = Math.min(Math.max(1, lad.lane), lanes.length);
    const sizes = LADDERS[lad.type].kda;
    const [s, e] = lanes[lad.lane - 1];
    if (!lad.manual || !lad.markers) {
      const bands = state.results[lad.lane - 1].bands;
      const bg = laneBackground(grey, w, h, s, e);
      const chosen = pickLadderBands(bands, bands.map((b) => bandSolidity(grey, w, h, s, e, b.y, bg)), sizes.length);
      lad.markers = chosen.map((b, i) => ({ y: b.y, kda: sizes[i] }));
      // sizes with no band found still get a marker, so they can be dragged into place:
      // at the row a straight line through log10(kDa) against row of the placed ones gives
      if (lad.markers.length >= 2 && lad.markers.length < sizes.length) {
        const ys = lad.markers.map((q) => q.y), ks = lad.markers.map((q) => Math.log10(q.kda));
        const my = ys.reduce((a, v) => a + v, 0) / ys.length, mk = ks.reduce((a, v) => a + v, 0) / ks.length;
        const slope = ys.reduce((a, v, i) => a + (v - my) * (ks[i] - mk), 0) / ys.reduce((a, v) => a + (v - my) ** 2, 0);
        let last = lad.markers[lad.markers.length - 1].y;
        for (const kda of sizes.slice(lad.markers.length)) {
          let y = Math.round(my + (Math.log10(kda) - mk) / slope);
          y = Math.min(Math.max(y, last + 3), h - 1); // below the last one, inside the image
          lad.markers.push({ y, kda, estimated: true });
          last = y;
        }
      }
    }
    const m = [...lad.markers].sort((a, b) => a.y - b.y);
    lad.note = "";
    lad.calib = null;
    const est = m.filter((q) => q.estimated).map((q) => q.kda);
    if (est.length) lad.note = `No band found for ${est.join(", ")} kDa: placed by estimate (pale). Drag onto the right band.`;
    if (m.length < sizes.length) lad.note = `Only ${m.length} of ${sizes.length} ladder bands placed.`;
    if (m.some((q, i) => i && (q.kda >= m[i - 1].kda || q.y <= m[i - 1].y))) {
      lad.note = "Ladder bands are out of order: drag them back so sizes fall from top to bottom.";
    } else if (m.length >= 2) {
      lad.calib = { f: pchip(m.map((q) => q.y), m.map((q) => Math.log10(q.kda))),
                    y0: m[0].y, y1: m[m.length - 1].y, kMax: m[0].kda, kMin: m[m.length - 1].kda };
    }
  }
  // markers to draw, per lane
  state.marks = lanes.map(() => []);
  state.ladders.forEach((lad, li) => {
    const [s, e] = lanes[lad.lane - 1];
    lad.markers.forEach((q, i) => state.marks[lad.lane - 1].push(
      { y: q.y, x: bandCentre(grey, w, h, s, e, q.y), kda: q.kda, ladder: li, i, estimated: !!q.estimated }));
  });
  // marked bands: named lane.letter top to bottom, mass from the nearest ladder with a
  // calibration (outside the ladder: ">top" / "<bottom")
  const centre = ([s, e]) => (s + e) / 2;
  state.pickMarks = lanes.map((lane, j) => {
    const near = state.ladders.filter((l) => l.calib)
      .sort((a, b) => Math.abs(centre(lanes[a.lane - 1]) - centre(lane)) - Math.abs(centre(lanes[b.lane - 1]) - centre(lane)))[0];
    return [...(state.picks[j] || [])].sort((a, b) => a.y - b.y).map((q, n) => {
      const out = { ref: q, y: q.y, x: bandCentre(grey, w, h, lane[0], lane[1], q.y), name: `${j + 1}.${bandLetter(n)}`,
                    created: q.created, kda: null, label: "" };
      if (near) {
        const c = near.calib;
        if (q.y < c.y0) out.label = `>${c.kMax}`;
        else if (q.y > c.y1) out.label = `<${c.kMin}`;
        else { out.kda = 10 ** c.f(q.y); out.label = fmtKda(out.kda); }
      }
      return out;
    });
  });
  for (const r of state.results) for (const b of r.bands) b.ladderBand = false;
  state.marks.forEach((marks, j) => { for (const b of state.results[j].bands) b.ladderBand = marks.some((q) => Math.abs(q.y - b.y) <= 1); });
  drawLadderCards();
}

// Clicking on a band marks it: the nearest band found in that lane (within 15 screen
// px), or a new one exactly where clicked if none was found. (Right-click deletes.)
function clickBand(p) {
  const top = overlayCanvas.height - state.cropImg.h;
  const y = Math.round(p.y - top);
  if (y < 0 || y >= state.cropImg.h) return;
  const lane = state.bounds.findIndex((b, i) => i < state.bounds.length - 1 && p.x >= b && p.x < state.bounds[i + 1]);
  if (lane < 0) return;
  const picks = (state.picks[lane] = state.picks[lane] || []);
  const tol = 15 * p.px;
  if (picks.some((q) => Math.abs(q.y - y) <= 8 * p.px)) return; // already marked
  const { y: at, snapped } = snapRow(lane, y, tol);
  if (!picks.some((q) => q.y === at)) picks.push({ y: at, created: !snapped });
  assignLadders();
  drawResults();
}

// The nearest band found in a lane within tol rows of y, else y itself.
function snapRow(lane, y, tol) {
  const near = state.results[lane].bands.map((b) => b.y).sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0];
  return near !== undefined && Math.abs(near - y) <= tol ? { y: near, snapped: true } : { y, snapped: false };
}

let pending = false;
function analyse() {
  if (pending) return;
  pending = true;
  setTimeout(() => { // batch rapid slider changes; a timer also runs in background tabs
    pending = false;
    state.cropImg = cropImage();
    const { grey, w, h } = state.cropImg;
    if (state.countLanes) {
      const est = countLanes(grey, w, h);
      $("lanes").value = Math.max(1, Math.min(60, est.n));
      state.laneNote = `Found ${est.n} lanes (typical lane ${Math.round(est.pitch)} px wide). `;
      state.countLanes = false;
      state.bounds = null;
    }
    const n = Math.max(1, Math.min(60, parseInt($("lanes").value, 10) || 1));
    if (!state.bounds || state.bounds.length !== n + 1 || state.bounds[n] !== w) state.bounds = findLanes(grey, w, h, n);
    computeBands();
    drawResults();
  }, 0);
}

const lanePairs = () => state.bounds.slice(0, -1).map((b, i) => [Math.round(b), Math.round(state.bounds[i + 1])]);

function drawResults(active = -1) {
  const { grey, w, h } = state.cropImg;
  const px = w / (overlayCanvas.clientWidth || w);
  const top = Math.round(LABEL_SPACE * px);
  overlayCanvas.width = w;
  overlayCanvas.height = h + top;
  const ctx = overlayCanvas.getContext("2d");
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--surface").trim() || "#fff";
  ctx.fillRect(0, 0, w, top);
  ctx.putImageData(greyToImageData(ctx, grey, w, h), 0, top);
  drawDividers(ctx, state.bounds, top, h, px, active);
  drawOverlay(ctx, lanePairs(), state.results, top, px, $("show-profiles").getAttribute("aria-pressed") === "true",
              state.marks, markDrag, state.pickMarks);
  const found = state.results.reduce((a, r) => a + r.bands.length, 0);
  const marked = state.pickMarks.reduce((a, m) => a + m.length, 0);
  const from = $("source").value === "original" ? "original pixels" : "edited image";
  $("summary").textContent = state.laneNote + `${state.results.length} lanes, ${found} bands found, ${marked} marked. ` +
    `Click a band to mark it, drag to move it, right-click to delete it. Profiles read from the ${from}.`;
  drawFigure();
  drawLadderNotes();
  drawAnnotations();
}

// A ladder marker or marked band under the pointer: {kind: "ladder"|"pick", lane, mark}.
// Only in the circles view.
let markDrag = null;
let clickStart = null; // a press that isn't on a marker or divider: a click on a band if it doesn't move
function markerAt(p) {
  if (!state.marks || $("show-profiles").getAttribute("aria-pressed") === "true") return null;
  const top = overlayCanvas.height - state.cropImg.h;
  let best = null, dist = 10 * p.px;
  const look = (kind) => (marks, lane) => marks.forEach((q) => {
    const d = Math.hypot(q.x - p.x, top + q.y - p.y);
    if (d <= dist) { best = { kind, lane, mark: q }; dist = d; }
  });
  state.marks.forEach(look("ladder"));
  (state.pickMarks || []).forEach(look("pick"));
  return best;
}

// Right-click on a marked band deletes it.
overlayCanvas.addEventListener("contextmenu", (e) => {
  if (!state.bounds) return;
  const hit = markerAt(canvasPoint(overlayCanvas, e));
  if (!hit || hit.kind !== "pick") return;
  e.preventDefault();
  const picks = state.picks[hit.lane];
  picks.splice(picks.indexOf(hit.mark.ref), 1);
  assignLadders();
  drawResults();
});

overlayCanvas.addEventListener("pointerdown", (e) => {
  if (!state.bounds) return;
  const p = canvasPoint(overlayCanvas, e);
  if (e.button !== 0) return; // right-click is handled by "contextmenu"
  const hit = markerAt(p);
  if (hit) {
    markDrag = { ...hit, x: hit.mark.x, y: hit.mark.y };
    overlayCanvas.setPointerCapture(e.pointerId);
    drawResults();
    return;
  }
  let best = -1, dist = 8 * p.px;
  state.bounds.forEach((b, i) => { if (Math.abs(b - p.x) <= dist) { best = i; dist = Math.abs(b - p.x); } });
  if (best < 0) {
    if ($("show-profiles").getAttribute("aria-pressed") !== "true") clickStart = p;
    return;
  }
  laneDrag = best;
  overlayCanvas.setPointerCapture(e.pointerId);
});

overlayCanvas.addEventListener("pointermove", (e) => {
  const p = canvasPoint(overlayCanvas, e);
  if (markDrag) { // moves stay inside the lane
    const [s0, e0] = lanePairs()[markDrag.lane];
    markDrag.x = Math.min(Math.max(p.x, s0), e0 - 1);
    markDrag.y = Math.min(Math.max(p.y - (overlayCanvas.height - state.cropImg.h), 0), state.cropImg.h - 1);
    drawResults();
    return;
  }
  if (laneDrag === null) {
    const near = state.bounds && state.bounds.some((b) => Math.abs(b - p.x) <= 8 * p.px);
    overlayCanvas.style.cursor = state.cropImg && markerAt(p) ? "grab" : near ? "ew-resize" : "default";
    return;
  }
  const b = state.bounds, i = laneDrag, gap = 4;
  const lo = i === 0 ? 0 : b[i - 1] + gap, hi = i === b.length - 1 ? state.cropImg.w : b[i + 1] - gap;
  b[i] = Math.round(Math.min(Math.max(p.x, lo), hi));
  computeBands();
  drawResults(i);
});

// Dropping a ladder marker or marked band: it snaps to the nearest band found in its lane
// (within 15 screen px), otherwise stays where it was dropped. A ladder marker dropped on
// another of the ladder's markers swaps with it; a marked band dropped on another marked
// band merges with it. Moves stay until the geometry, area, lanes or ladder change.
overlayCanvas.addEventListener("pointerup", (e) => {
  if (clickStart) {
    const p = canvasPoint(overlayCanvas, e), s0 = clickStart;
    clickStart = null;
    if (Math.hypot(p.x - s0.x, p.y - s0.y) <= 5 * p.px) clickBand(p);
    return;
  }
  if (markDrag) {
    const p = canvasPoint(overlayCanvas, e);
    const { kind, lane, mark } = markDrag;
    const dropped = Math.round(markDrag.y);
    markDrag = null;
    const { y, snapped } = snapRow(lane, dropped, 15 * p.px);
    if (kind === "pick") {
      const picks = state.picks[lane], me = mark.ref;
      if (picks.some((q) => q !== me && Math.abs(q.y - y) <= 2)) picks.splice(picks.indexOf(me), 1);
      else { me.y = y; me.created = !snapped; }
      assignLadders();
      drawResults();
      return;
    }
    const lad = state.ladders[mark.ladder];
    const me = lad.markers[mark.i];
    delete me.estimated;
    const other = lad.markers.find((q) => q !== me && Math.abs(q.y - y) <= 2);
    if (other) other.y = me.y;
    me.y = y;
    lad.manual = true;
    assignLadders();
    drawResults();
    return;
  }
  if (laneDrag === null) return;
  laneDrag = null;
  drawResults();
});

// ---------- ladders ----------

// One card per ladder on the gel; its dropdown says which ladder it is (LADDERS).
function drawLadderCards() {
  const list = $("ladder-cards");
  list.replaceChildren();
  state.ladders.forEach((ladder, i) => {
    const card = $("ladder-card").content.firstElementChild.cloneNode(true);
    card.querySelector(".ladder-title").textContent = `Ladder ${i + 1}`;
    const select = card.querySelector(".ladder-type");
    for (const [key, { name }] of Object.entries(LADDERS)) select.add(new Option(name, key));
    select.value = ladder.type;
    card.querySelector(".ladder-sizes").textContent = `${LADDERS[ladder.type].kda.join(", ")} kDa`;
    const laneSelect = card.querySelector(".ladder-lane");
    const nLanes = state.bounds ? state.bounds.length - 1 : 1;
    for (let k = 1; k <= nLanes; k++) laneSelect.add(new Option(String(k), String(k)));
    laneSelect.value = String(Math.min(ladder.lane, nLanes));
    card.querySelector(".ladder-note").textContent = ladder.note || "";
    const changed = () => { ladder.manual = false; ladder.markers = null; if (state.results) { assignLadders(); drawResults(); } };
    select.addEventListener("change", () => { ladder.type = select.value; changed(); drawLadderCards(); });
    laneSelect.addEventListener("change", () => { ladder.lane = parseInt(laneSelect.value, 10); changed(); });
    card.querySelector(".ladder-remove").addEventListener("click", () => {
      state.ladders.splice(i, 1);
      if (state.results) { assignLadders(); drawResults(); } else drawLadderCards();
    });
    list.append(card);
  });
}

const newLadder = (lane) => ({ type: Object.keys(LADDERS)[0], lane, markers: null, manual: false, note: "" });
$("add-ladder").addEventListener("click", () => {
  state.ladders.push(newLadder(state.bounds ? state.bounds.length - 1 : 1)); // a second ladder: often the last lane
  if (state.results) { assignLadders(); drawResults(); } else drawLadderCards();
});
state.ladders.push(newLadder(1)); // most gels have one ladder, in the first lane
drawLadderCards();

// ---------- ladder notes, lane annotations and groups ----------

// Ladder box: one row per ladder, its text pre-filled with the selected ladder (kept
// once edited) and a volume box (left empty).
// true while the user is typing in a text box inside el (don't rebuild under them)
const typingIn = (el) => el.contains(document.activeElement) && document.activeElement.tagName === "INPUT";

function drawLadderNotes() {
  const box = $("ladder-notes");
  if (typingIn(box)) return;
  box.replaceChildren();
  state.ladders.forEach((lad, i) => {
    lad.noteText = lad.noteText ?? null; // null = follow the selected ladder
    const row = document.createElement("div");
    row.className = "ladder-note-row";
    row.innerHTML = `<span class="lane-no"></span><input type="text" class="ln-text">
      <label class="vol">Volume <span class="unit-box"><input type="text" class="ln-vol" inputmode="decimal"><span class="unit">µL</span></span></label>`;
    row.querySelector(".lane-no").textContent = state.ladders.length > 1 ? `Ladder ${i + 1}` : "Ladder";
    const text = row.querySelector(".ln-text"), vol = row.querySelector(".ln-vol");
    text.value = lad.noteText ?? LADDERS[lad.type].name;
    vol.value = lad.volume ?? "";
    text.addEventListener("input", () => { lad.noteText = text.value; });
    vol.addEventListener("input", () => { lad.volume = vol.value; });
    box.append(row);
  });
}

// Lane annotations: one row per sample lane (ladder lanes are in the Ladder box), one
// column per group. A group's lanes are set by clicking a cell and dragging down its
// column, so a group is always a continuous run of lanes (from..to, lane numbers).
let groupDrag = null; // {g, start}
function drawAnnotations(force = false) {
  const table = $("annot");
  if (!force && (typingIn(table) || groupDrag)) return; // don't rebuild under the user
  const n = state.bounds ? state.bounds.length - 1 : 0;
  const ladderLanes = new Set(state.ladders.map((l) => l.lane));
  const lanes = Array.from({ length: n }, (_, i) => i + 1).filter((k) => !ladderLanes.has(k));
  for (const g of state.groups) if (g.from && (g.from > n || g.to > n)) { g.from = g.to = null; }
  const head = document.createElement("tr");
  head.innerHTML = "<th>Lane</th><th>Annotation</th>";
  state.groups.forEach((g, gi) => {
    const th = document.createElement("th");
    th.className = "group-head";
    th.innerHTML = `<input type="text" class="group-name" placeholder="Group name"><button type="button" class="link group-remove" title="Remove this group">×</button>`;
    const name = th.querySelector(".group-name");
    name.value = g.name;
    name.addEventListener("input", () => { g.name = name.value; drawFigure(); });
    th.querySelector(".group-remove").addEventListener("click", () => { state.groups.splice(gi, 1); drawAnnotations(true); });
    head.append(th);
  });
  const addTh = document.createElement("th");
  addTh.innerHTML = `<button type="button" class="btn add-group">+ Add group</button>`;
  addTh.querySelector("button").addEventListener("click", () => {
    state.groups.push({ name: "", from: null, to: null });
    drawAnnotations(true);
    const names = $("annot").querySelectorAll(".group-name");
    names[names.length - 1].focus(); // ready to type the new group's name
  });
  head.append(addTh);
  const rows = lanes.map((k) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input type="text" class="lane-id"></td><td><input type="text" class="lane-text" placeholder="Sample, treatment, …"></td>`;
    const id = tr.querySelector(".lane-id");
    id.value = state.laneIds[k] ?? String(k);
    id.addEventListener("input", () => { state.laneIds[k] = id.value; drawFigure(); });
    const input = tr.querySelector(".lane-text");
    input.value = state.laneNotes[k] ?? "";
    input.addEventListener("input", () => { state.laneNotes[k] = input.value; drawFigure(); });
    state.groups.forEach((g, gi) => {
      const td = document.createElement("td");
      td.className = "group-cell";
      td.dataset.g = String(gi);
      td.dataset.lane = String(k);
      tr.append(td);
    });
    tr.append(document.createElement("td"));
    return tr;
  });
  table.replaceChildren(head, ...rows);
  paintGroups();
}

function paintGroups() {
  for (const td of $("annot").querySelectorAll(".group-cell")) {
    const g = state.groups[+td.dataset.g], k = +td.dataset.lane;
    td.classList.toggle("on", g.from !== null && k >= g.from && k <= g.to);
  }
}

$("annot").addEventListener("pointerdown", (e) => {
  const td = e.target.closest(".group-cell");
  if (!td) return;
  e.preventDefault();
  const g = state.groups[+td.dataset.g], k = +td.dataset.lane;
  if (g.from === k && g.to === k) { g.from = g.to = null; paintGroups(); return; } // clear a lone cell
  groupDrag = { g, start: k };
  g.from = g.to = k;
  paintGroups();
});
$("annot").addEventListener("pointerover", (e) => {
  const td = e.target.closest(".group-cell");
  if (!groupDrag || !td || state.groups[+td.dataset.g] !== groupDrag.g) return;
  const k = +td.dataset.lane;
  groupDrag.g.from = Math.min(groupDrag.start, k);
  groupDrag.g.to = Math.max(groupDrag.start, k);
  paintGroups();
});
window.addEventListener("pointerup", () => { if (groupDrag) { groupDrag = null; drawFigure(); } });

// ---------- figure ----------

// The analysed gel with ladder sizes down the side: the leftmost ladder on the left, a
// second ladder on the right. (More than two ladders: only those two are shown, for now.)
function drawFigure() {
  const { grey, w, h } = state.cropImg;
  const placed = state.ladders.filter((l) => l.markers && l.markers.length).sort((a, b) => a.lane - b.lane);
  const side = (l) => (l ? [...l.markers].sort((a, b) => a.y - b.y).map((q) => ({ y: q.y, kda: q.kda })) : null);
  // above the gel: lane labels and annotations (sample lanes; ladders are on the MW scale)
  // and group bars, one row per group column that has lanes
  const pairs = lanePairs(), ladderLanes = new Set(state.ladders.map((l) => l.lane));
  const lanes = pairs.map(([x0, x1], i) => (ladderLanes.has(i + 1) ? { x0, x1, id: "", text: "" }
    : { x0, x1, id: state.laneIds[i + 1] ?? String(i + 1), text: state.laneNotes[i + 1] ?? "" }));
  // each group on the lowest row where it doesn't overlap another (side-by-side groups share a row)
  const rows = [];
  const groups = state.groups.filter((g) => g.from !== null && g.to <= pairs.length).map((g) => {
    let level = 0;
    while ((rows[level] || []).some((o) => o.from <= g.to && g.from <= o.to)) level++;
    (rows[level] = rows[level] || []).push(g);
    return { x0: pairs[g.from - 1][0], x1: pairs[g.to - 1][1], name: g.name, level };
  });
  const show = { ids: $("show-ids").checked, notes: $("show-notes").checked, groups: $("show-groups").checked };
  renderFigure($("figure-canvas"), grey, w, h, side(placed[0]), placed.length > 1 ? side(placed[placed.length - 1]) : null,
               { lanes, groups, show });
  $("figure-note").textContent = placed.length > 2
    ? `${placed.length} ladders: only the leftmost and rightmost are marked on the figure.` : "";
}

for (const id of ["show-ids", "show-notes", "show-groups"]) $(id).addEventListener("change", () => state.cropImg && drawFigure());

$("fig-download").addEventListener("click", () => {
  $("figure-canvas").toBlob((b) => save(b, `${state.src.name}_figure.png`));
});

// The clipboard is asked during the click itself, with a promise of the PNG: browsers
// (Safari especially) refuse clipboard writes that start after the click has finished.
$("fig-copy").addEventListener("click", async () => {
  const png = new Promise((resolve) => $("figure-canvas").toBlob(resolve, "image/png"));
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    $("figure-note").textContent = "Copied to the clipboard.";
  } catch (err) {
    $("figure-note").textContent = `Couldn't copy (${err.message}); use Download instead.`;
  }
});

$("caption-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("caption").value);
    $("figure-note").textContent = "Caption copied to the clipboard.";
  } catch (err) {
    $("caption").select(); // fall back: selected, ready for Cmd+C
    $("figure-note").textContent = `Couldn't copy the caption (${err.message}); it's selected, press Cmd+C.`;
  }
});

// ---------- downloads ----------

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("dl-overlay").addEventListener("click", () => {
  overlayCanvas.toBlob((b) => save(b, `${state.src.name}_overlay.png`));
});

$("dl-image").addEventListener("click", () => {
  const { grey, w, h } = state.cropImg;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.putImageData(greyToImageData(ctx, grey, w, h), 0, 0);
  c.convertToBlob({ type: "image/png" }).then((b) => save(b, `${state.src.name}_edited.png`));
});

$("dl-csv").addEventListener("click", () => {
  // the edit settings go in every row, so a CSV records how it was made
  const edits = [...GEOMETRY, ...TONE].map((k) => value(k));
  // marked bands and ladder bands; kind/saturated/snr come from the band found at that row (if any)
  const rows = [["band", "lane", "lane_start_col", "lane_end_col", "row", "col", "kDa", "ladder_size_kDa", "found_or_created",
                 "kind", "saturated", "snr", "read_from", ...GEOMETRY, ...TONE, "invert"]];
  const found = (i, y) => state.results[i].bands.find((b) => Math.abs(b.y - y) <= 1);
  const extra = (b) => (b ? [b.kind, b.saturated, b.snr.toFixed(1)] : ["", "", ""]);
  lanePairs().forEach(([s, e], i) => {
    for (const q of state.marks[i]) rows.push(["", i + 1, s, e - 1, q.y, q.x.toFixed(1), q.kda, q.kda,
      found(i, q.y) ? "found" : "created", ...extra(found(i, q.y)), $("source").value, ...edits, state.invert]);
    for (const q of state.pickMarks[i]) rows.push([q.name, i + 1, s, e - 1, q.y, q.x.toFixed(1),
      q.kda !== null ? q.kda.toFixed(1) : q.label, "", q.created ? "created" : "found", ...extra(found(i, q.y)),
      $("source").value, ...edits, state.invert]);
  });
  save(new Blob([rows.map((r) => r.join(",")).join("\n") + "\n"], { type: "text/csv" }), `${state.src.name}_bands.csv`);
});

// ---------- controls ----------

function showValues() {
  document.querySelectorAll("output[data-for]").forEach((o) => {
    const v = value(o.dataset.for);
    o.textContent = o.dataset.for === "rotation" ? `${v.toFixed(1)}°` : String(+v.toFixed(3));
  });
}

for (const id of GEOMETRY) $(id).addEventListener("input", () => { showValues(); state.src && applyGeometry(); });
for (const id of TONE) $(id).addEventListener("input", () => { showValues(); state.src && applyTone(); });
for (const id of BANDS) $(id).addEventListener("input", () => { showValues(); state.src && analyse(); });
$("source").addEventListener("change", () => state.src && analyse());
$("redo").addEventListener("click", () => state.src && analyse());
$("show-profiles").addEventListener("click", () => { // for debugging: profiles and band kinds
  const on = $("show-profiles").getAttribute("aria-pressed") !== "true";
  $("show-profiles").setAttribute("aria-pressed", String(on));
  $("key-profiles").hidden = !on;
  $("key-bands").hidden = on;
  if (state.cropImg && state.results) drawResults();
});
for (const id of [...GEOMETRY, ...TONE]) {
  $(id).addEventListener("dblclick", () => { $(id).value = 0; $(id).dispatchEvent(new Event("input")); });
}
$("invert").addEventListener("click", () => {
  state.invert = !state.invert;
  $("invert").setAttribute("aria-pressed", String(state.invert));
  applyTone();
});
$("reset-edits").addEventListener("click", () => resetEdits());
$("lanes").addEventListener("change", () => { state.bounds = null; state.laneNote = ""; resetLadders(); analyse(); });
$("find-lanes").addEventListener("click", () => { state.countLanes = true; resetLadders(); analyse(); });
window.addEventListener("resize", () => {
  if (state.box) drawEditor();
  if (state.cropImg && state.results) drawResults();
});

const drop = $("drop");
$("browse").addEventListener("click", (e) => { e.stopPropagation(); $("file").click(); });
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") $("file").click(); });
$("file").addEventListener("change", (e) => e.target.files[0] && load(e.target.files[0]));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
});
showValues();
drawIcons();

// ?image=<url> loads an image straight away (same-origin; handy for local testing)
const param = new URLSearchParams(location.search).get("image");
if (param) {
  fetch(param).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.blob();
  }).then((b) => load(new File([b], param.split("/").pop(), { type: b.type })))
    .catch((err) => setStatus(`Couldn't load ${param}: ${err.message}`, true));
}
