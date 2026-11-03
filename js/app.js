// gel-ed web app: load → edit (tone, geometry) → lanes → bands → overlay.
// Profiles are read from the original pixels through the edit's transform (or, to
// compare, from the resampled edited image): see profilesFromOriginal in bands.js.

import { readImage } from "./image.js?v=f78e7ddd";
import { matrix, warp, frame, cropValid, clampCrop } from "./transform.js?v=f78e7ddd";
import { bandCentre, bandsFromProfile, coreColumns, countLanes, findLanes, profilesFromOriginal, DEFAULTS } from "./bands.js?v=f78e7ddd";
import { greyToImageData, drawOverlay, drawDividers, drawDeadSpace, bandLetter, renderFigure, drawCalibration } from "./draw.js?v=f78e7ddd";
import { median } from "./signal.js?v=f78e7ddd";
import { bandSolidity, ladderLoo, laneBackground, pchip, pickLadderBands } from "./calibrate.js?v=f78e7ddd";
import { align, alignmentSigma, matchSignal, toRef } from "./running.js?v=f78e7ddd";
import { ANTIBODIES, antibodyCaption, antibodyLabel } from "./antibodies.js?v=f78e7ddd";
import { log, logOnChange, logText } from "./log.js?v=f78e7ddd";
import { LADDERS } from "./ladders.js?v=f78e7ddd";
import { drawIcons } from "./icons.js?v=f78e7ddd";

const $ = (id) => document.getElementById(id);
const GEOMETRY = ["rotation", "perspective", "skew", "distort"];
const TONE = ["brightness", "contrast"];
const BANDS = ["k", "core", "smooth", "noiseRows"];
const LABEL_SPACE = 26; // screen px above the overlay for lane numbers
const LANE_ARRAYS = ["laneIds", "laneNotes", "laneVols", "laneConc", "laneUg", "laneRed"]; // state kept per lane (index = lane number)

const state = {
  src: null,        // {grey, w, h, name}
  box: null,        // frame of the edited image: {x0, y0, W, H} (whole transformed image)
  m: null,          // the edit's transform (original pixel -> edited position), transform.js
  warped: null,     // geometry applied, W x H (for display and lane placement)
  edited: null,     // geometry + tone
  crop: null,       // analysed rectangle {x0, y0, x1, y1}, edited-image pixels (inclusive)
  cropUser: false,  // trimmed by hand (otherwise it follows the whole image)
  invert: false,
  flip: false,      // mirrored left-right (before the other geometry edits)
  bounds: null,     // dividers in crop columns; the spaces between them are lanes or dead space
  dead: new Set(),  // spaces between dividers (index into bounds) that aren't lanes: lanes are numbered over the rest
  countLanes: true, // next analysis estimates the number of lanes (on load and "Find lanes")
  laneNote: "",
  ladders: [],      // one per ladder card: {type (key of LADDERS), lane (1-based), markers, manual, note}
  marks: null,      // per lane: ladder markers to draw [{y, x, kda, ladder, i}]
  picks: [],        // per lane: bands the user marked [{y, created}] (created: no band was found there)
  pickMarks: null,  // per lane: marked bands to draw [{y, x, name, kda, label, created}]
  laneIds: [],      // per lane: lane label (undefined = the lane number)
  laneNotes: [],    // per lane: annotation (not on the figure)
  laneVols: [],     // per lane: volume loaded (µL), as typed
  laneConc: [],     // per lane: sample concentration (mg/mL), as typed (sample preparation)
  laneUg: [],       // per lane: amount to load (µg), as typed (blank: as much sample as fits)
  laneRed: [],      // per lane: reducing agent added (true/false; undefined = ticked if in the group named Reduced)
  aligns: {},       // running correction per "lane:refLane", cleared when bands are found again
  captionAuto: true, // the caption follows the annotations until the user edits it
  // Method (caption only): western blot with antibodies (preset key or "custom" + text), or SDS-PAGE with a stain
  method: { type: "sds", stain: "Coomassie", antibodies: [{ key: Object.keys(ANTIBODIES)[0], text: "" }] },
  // how the gel was run and (western blots) transferred: free text per field, "" = not
  // given. Defaults: what the lab's notebooks use most (NuPAGE gels in MES, 95 °C 5 min,
  // 180 V ~35 min; wet transfer at 100 V 1 h in the cold, Ponceau check, BSA block, ECL).
  // Wells vary (10, 12, 15), so left blank.
  run: { gel: "NuPAGE 4–12% Bis-Tris", wells: "", buffer: "MES", heatC: "95", heatMin: "5", volts: "180", minutes: "35",
         membrane: "nitrocellulose", transfer: "100 V, 1 h, cold room", ponceau: true, blocking: "5% BSA in TBS, 1 h, RT",
         detection: "ECL chemiluminescence" },
  // sample preparation: every tube made up to total µL with dye at dyeFold×, and the
  // reducing agent in the lanes ticked Reduced (laneRed)
  prep: { total: "20", dyeFold: "4", diluent: "PBS", reducer: "1 M DTT", reducerUl: "2" },
  panels: [],       // figures kept as panels: [{canvas, caption}], drawn left of this one
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
    $("edit-stage").style.maxWidth = `calc(80vh * ${(w / h).toFixed(4)})`; // and is no taller than most of the window
    $("drop").classList.add("compact");
    const light = median(grey.filter((_, i) => i % 97 === 0)) >= 0.5;
    log("load", { name: file.name, type: file.type, bytes: file.size, w, h, lightBackground: light });
    setStatus(`${file.name}: ${w} × ${h} px.` +
      (light ? "" : " This looks like light bands on a dark background: press Invert before reading bands."));
    applyGeometry();
  } catch (err) {
    console.error(err);
    log("load-failed", { name: file.name, type: file.type, bytes: file.size, message: err.message });
    setStatus(`Couldn't read ${file.name}: ${err.message}`, true);
  }
}

// ---------- edits ----------

const value = (id) => parseFloat($(id).value);
const geometry = () => ({ ...Object.fromEntries(GEOMETRY.map((k) => [k, value(k)])), flip: state.flip });

function resetEdits(rerun = true) {
  [...GEOMETRY, ...TONE].forEach((id) => { $(id).value = 0; });
  state.invert = false;
  $("invert").setAttribute("aria-pressed", "false");
  state.flip = false;
  $("flip").setAttribute("aria-pressed", "false");
  state.crop = null;
  state.cropUser = false;
  state.box = null;
  showValues();
  if (rerun) applyGeometry();
}

// After a flip: lane k of n becomes lane n + 1 - k. Ladders always follow (clamped to the
// new count); labels, annotations, volumes and groups only if the count is unchanged.
function mirrorLanes(before, after) {
  for (const lad of state.ladders) lad.lane = Math.min(Math.max(1, after + 1 - lad.lane), after);
  if (before !== after) return;
  const flip = (arr) => { const out = []; arr.forEach((v, k) => { if (k >= 1 && k <= after) out[after + 1 - k] = v; }); return out; };
  for (const key of LANE_ARRAYS) state[key] = flip(state[key]);
  for (const g of state.groups) if (g.from !== null) [g.from, g.to] = [after + 1 - g.to, after + 1 - g.from];
  drawAnnotations(true);
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
  const before = drag.crop;
  drag = null;
  state.cropUser = true;
  log("crop", { area: state.crop, frame: state.box && { W: state.box.W, H: state.box.H } });
  carryLanes(before);
  resetLadders();
  analyse();
});

// After the area is trimmed, the lanes stay where they were on the gel: dividers move
// with the crop's left edge, spaces cut off go, ones cut through are trimmed, and what's
// left at the edges is empty space. Lanes cut off on the left shift everything kept per
// lane (labels, annotations, ladders, groups) down. No lanes yet (or none left): placed again.
function carryLanes(old) {
  if (!state.bounds || !old) { state.bounds = null; return; }
  const dx = old.x0 - state.crop.x0, w = state.crop.x1 - state.crop.x0 + 1;
  const sp = spaces().map(([a, b], i) => ({ a: Math.max(0, a + dx), b: Math.min(w, b + dx), dead: state.dead.has(i), was: a + dx }));
  const kept = sp.filter((s) => s.b - s.a >= 4);
  if (!kept.some((s) => !s.dead)) { state.bounds = null; return; }
  const lost = sp.filter((s) => !s.dead && s.b - s.a < 4 && s.was < 0).length; // lanes cut off on the left
  if (kept[0].a > 0) kept.unshift({ a: 0, b: kept[0].a, dead: true });
  if (kept[kept.length - 1].b < w) kept.push({ a: kept[kept.length - 1].b, b: w, dead: true });
  state.bounds = [kept[0].a, ...kept.map((s) => s.b)];
  state.dead = new Set(kept.map((s, i) => (s.dead ? i : -1)).filter((i) => i >= 0));
  const n = kept.filter((s) => !s.dead).length;
  if (lost) {
    for (const key of LANE_ARRAYS) state[key] = state[key].map((_, k, arr) => arr[k + lost]);
    for (const lad of state.ladders) lad.lane = Math.min(n, Math.max(1, lad.lane - lost));
    for (const g of state.groups) if (g.from !== null) {
      g.from = Math.max(1, g.from - lost); g.to -= lost;
      if (g.to < 1 || g.from > n) g.from = g.to = null; else g.to = Math.min(n, g.to);
    }
  }
  $("lanes").value = n;
}

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
                                DEFAULTS.satLevel, toneFunction()).filter((_, i) => !state.dead.has(i));
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
  state.profiles = laneProfiles();
  state.results = state.profiles.map((p) => bandsFromProfile(p.mean, p.black, opts));
  state.aligns = {};
  // each band's horizontal middle (where it's marked), measured on the edited image
  const { grey, w, h } = state.cropImg;
  lanePairs().forEach(([s, e], i) => state.results[i].bands.forEach((b) => { b.x = bandCentre(grey, w, h, s, e, b.y); }));
  state.baseResults = [...state.results];
  state.resultsId = (state.resultsId || 0) + 1; // ladder lanes found automatically are found again
  assignLadders();
}

// ---------- ladders: picking, calibration, masses ----------

// Ladder picks and the user's marked bands start over when the geometry, the analysed
// area or the lanes change (their rows and lanes no longer mean the same thing).
function resetLadders() {
  for (const l of state.ladders) { l.manual = false; l.markers = null; delete l.home; }
  state.picks = [];
}

const fmtKda = (k) => (k >= 10 ? k.toFixed(0) : k.toFixed(1));
const medianOf = (v) => { if (!v.length) return 0; const t = [...v].sort((a, b) => a - b); return t[Math.floor(t.length / 2)]; };
// a ladder's band spread interpolated between its two nearest bands at reference row y
function spreadAt(c, y) {
  const { ys, spread } = c;
  if (y <= ys[0]) return spread[0];
  if (y >= ys[ys.length - 1]) return spread[spread.length - 1];
  let i = 0;
  while (y > ys[i + 1]) i++;
  return spread[i] + ((spread[i + 1] - spread[i]) * (y - ys[i])) / (ys[i + 1] - ys[i]);
}

// A ladder is bands from top to bottom, so its own noise estimate (wobble around a
// smoothed copy) is mostly bands, and can come out several times too high, hiding
// half its bands (gel_04: 0.065 against 0.006 for the other lanes; 7 of 15 found).
// When a ladder lane has fewer bands than sizes, it's read again with its noise
// capped at the gel's median lane noise (band_peaks.find_bands noise_cap). Returns
// that lane's results (the usual ones when the cap isn't needed or finds no more).
function ladderCandidates(i, sizes) {
  const base = state.baseResults[i];
  const gelNoise = median(state.baseResults.map((r) => r.noise));
  if (base.bands.length >= sizes.length || !(base.noise > gelNoise)) return base;
  const r = bandsFromProfile(state.profiles[i].mean, state.profiles[i].black, { ...bandOptions(), noiseCap: gelNoise });
  if (r.bands.length <= base.bands.length) return base;
  const { grey, w, h } = state.cropImg;
  const [s, e] = lanePairs()[i];
  r.bands.forEach((b) => { b.x = bandCentre(grey, w, h, s, e, b.y); });
  return r;
}

// The ladder's bands in lane i as the ladder would pick them (pickLadderBands).
function ladderPicks(i, sizes) {
  const { grey, w, h } = state.cropImg;
  const [s, e] = lanePairs()[i];
  const bands = ladderCandidates(i, sizes).bands;
  const bg = laneBackground(grey, w, h, s, e);
  const solidity = bands.map((b) => bandSolidity(grey, w, h, s, e, b.y, bg));
  return { picks: pickLadderBands(bands, solidity, sizes),
           solid: bands.filter((b, k) => b.kind === "peak" && solidity[k] >= 0.85).length };
}

// Which lane is this ladder in? (until the user chooses one on its card) The lane whose
// picked bands fit the ladder's sizes best: mean over consecutive picks of (ln of the
// ratio of the two slopes of log10(kDa) against row)^2, as pickLadderBands, plus
// 2 x the share of sizes with no solid band (a sample lane with a few evenly spaced
// bands can fit well; a ladder has a band for most sizes). Lanes holding another ladder
// are skipped. On every sample the ladder lane wins clearly (gel_04, ladder in lane 8
// of 15: 0.19 against 1.9 for the next best; gel_02: 0.53 against 1.39).
// scoping/ladder_pick.py find_ladder_lane does the same.
function autoLadderLane(lad) {
  const sizes = ladderSizes(lad);
  const taken = state.ladders.filter((l) => l !== lad && !l.auto).map((l) => l.lane)
    .concat(state.ladders.slice(0, state.ladders.indexOf(lad)).filter((l) => l.auto).map((l) => l.lane));
  const key = `${state.resultsId}|${sizes.join(",")}|${taken.join(",")}`;
  if (lad.autoKey === key) return;
  lad.autoKey = key;
  if (sizes.length < 3) return;
  const lk = sizes.map((k) => Math.log10(k));
  let best = Infinity, at = lad.lane;
  lanePairs().forEach((_, i) => {
    if (taken.includes(i + 1)) return;
    const { picks, solid } = ladderPicks(i, sizes);
    if (picks.length < 3) return;
    let c = 0;
    for (let k = 2; k < picks.length; k++) {
      const s1 = (lk[k - 1] - lk[k - 2]) / (picks[k - 1].y - picks[k - 2].y);
      const s2 = (lk[k] - lk[k - 1]) / (picks[k].y - picks[k - 1].y);
      c += Math.log(s2 / s1) ** 2;
    }
    const score = c / (picks.length - 2) + 2 * (1 - Math.min(solid, sizes.length) / sizes.length);
    if (score < best) { best = score; at = i + 1; }
  });
  if (at !== lad.lane) { lad.lane = at; lad.markers = null; }
  log("ladder-lane-auto", { ladder: state.ladders.indexOf(lad) + 1, lane: at, score: +best.toFixed(2) });
}

// Ladder markers (picked automatically unless moved by hand), each ladder's calibration
// (log10 kDa against row, point-to-point PCHIP as in Python), and every other band's mass
// from the nearest ladder. No correction for lanes running differently yet.
function assignLadders() {
  const { grey, w, h } = state.cropImg;
  const lanes = lanePairs();
  state.results = [...state.baseResults];
  for (const lad of state.ladders) {
    lad.lane = Math.min(Math.max(1, lad.lane), lanes.length);
    if (lad.auto && !lad.manual) autoLadderLane(lad);
    state.results[lad.lane - 1] = ladderCandidates(lad.lane - 1, ladderSizes(lad));
  }
  for (const lad of state.ladders) {
    const sizes = ladderSizes(lad);
    const [s, e] = lanes[lad.lane - 1];
    if (!lad.manual || !lad.markers) {
      lad.offGel = [];
      const chosen = ladderPicks(lad.lane - 1, sizes).picks;
      lad.markers = chosen.map((b, i) => ({ y: b.y, kda: sizes[i] }));
      // sizes with no band found still get a marker, so they can be dragged into place:
      // at the row a straight line through log10(kDa) against row of the placed ones gives
      if (lad.markers.length >= 2 && lad.markers.length < sizes.length) {
        const ys = lad.markers.map((q) => q.y), ks = lad.markers.map((q) => Math.log10(q.kda));
        const my = ys.reduce((a, v) => a + v, 0) / ys.length, mk = ks.reduce((a, v) => a + v, 0) / ks.length;
        const slope = ys.reduce((a, v, i) => a + (v - my) * (ks[i] - mk), 0) / ys.reduce((a, v) => a + (v - my) ** 2, 0);
        let last = lad.markers[lad.markers.length - 1].y;
        for (const kda of sizes.slice(lad.markers.length)) {
          let y = Math.max(Math.round(my + (Math.log10(kda) - mk) / slope), last + 3); // below the last one
          if (y > h - 1) { lad.offGel.push(kda); continue; } // would be below the image: not placed
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
    if (lad.offGel && lad.offGel.length) {
      lad.note = `No band found for ${lad.offGel.join(", ")} kDa, and they would be below the image: delete them from Sizes if they ran off.`;
    }
    if (sizes.length < 2) lad.note = "Type at least two sizes (kDa) for this ladder.";
    if (m.some((q, i) => i && (q.kda >= m[i - 1].kda || q.y <= m[i - 1].y))) {
      lad.note = "Ladder bands are out of order: drag them back so sizes fall from top to bottom.";
    } else if (m.length >= 2) {
      const ys = m.map((q) => q.y), lk = m.map((q) => Math.log10(q.kda));
      // each ladder band's own spread (FWHM / 2.355, rows); placed ones use the lane's median
      const lb = state.results[lad.lane - 1].bands;
      const typical = medianOf(lb.filter((b) => b.fwhm).map((b) => b.fwhm)) / 2.355 || 3;
      const spread = m.map((q) => { const b = lb.find((d) => Math.abs(d.y - q.y) <= 1); return b && b.fwhm ? b.fwhm / 2.355 : typical; });
      lad.calib = { f: pchip(ys, lk), loo: ladderLoo(ys, lk), ys, spread,
                    y0: m[0].y, y1: m[m.length - 1].y, kMax: m[0].kda, kMin: m[m.length - 1].kda };
    }
  }
  state.ladders.forEach((lad, i) => logOnChange(`ladder-${i + 1}`, {
    type: lad.type, sizes: lad.sizes, lane: lad.lane, movedByHand: lad.manual, note: lad.note,
    bands: lad.markers.map((q) => `${q.y}:${q.kda}${q.estimated ? "(est)" : ""}`),
  }));
  // markers to draw, per lane
  state.marks = lanes.map(() => []);
  state.ladders.forEach((lad, li) => {
    const [s, e] = lanes[lad.lane - 1];
    lad.markers.forEach((q, i) => state.marks[lad.lane - 1].push(
      { y: q.y, x: bandCentre(grey, w, h, s, e, q.y), kda: q.kda, ladder: li, i, estimated: !!q.estimated }));
  });
  // marked bands: named lane.letter top to bottom, mass from the nearest ladder with a
  // calibration, read at the band's row corrected for its lane running differently from
  // the lane next to that ladder (outside the ladder: ">top" / "<bottom")
  const centre = ([s, e]) => (s + e) / 2;
  const ladderLanes = new Set(state.ladders.map((l) => l.lane));
  const nearest = (lane) => state.ladders.filter((l) => l.calib)
    .sort((a, b) => Math.abs(centre(lanes[a.lane - 1]) - centre(lane)) - Math.abs(centre(lanes[b.lane - 1]) - centre(lane)))[0];
  const identity = { shift: 0, stretch: 1, corr: 1, centre: 0, sigma: 0, ok: true };
  const alignFor = (j, near) => {
    if (!near || ladderLanes.has(j + 1)) return identity;
    const step = near.lane < lanes.length && !ladderLanes.has(near.lane + 1) ? 1 : -1;
    const refLane = near.lane + step; // 1-based: the lane next to the ladder
    if (refLane === j + 1 || refLane < 1 || refLane > lanes.length) return identity;
    const key = `${j}:${refLane}`;
    if (!state.aligns[key]) {
      const me = state.results[j], ref = state.results[refLane - 1];
      const a = align(matchSignal(me.profile, me.noise), matchSignal(ref.profile, ref.noise));
      a.ok = a.corr >= 0.5;
      a.sigma = alignmentSigma(me.bands, ref.bands, a);
      a.refLane = refLane;
      state.aligns[key] = a;
      log("running-correction", { lane: j + 1, refLane, shift: a.shift, stretch: a.stretch, corr: +a.corr.toFixed(3),
                                  leftoverRows: a.sigma === null ? null : +a.sigma.toFixed(2), ok: a.ok });
    }
    return state.aligns[key];
  };
  const laneAlign = lanes.map((lane, j) => alignFor(j, nearest(lane)));
  // lanes whose leftover mismatch couldn't be measured (< 3 paired peaks) get the largest seen
  const worst = Math.max(0, ...laneAlign.map((a) => a.sigma ?? 0));
  state.pickMarks = lanes.map((lane, j) => {
    const near = nearest(lane), al = laneAlign[j];
    return [...(state.picks[j] || [])].sort((a, b) => a.y - b.y).map((q, n) => {
      const out = { ref: q, y: q.y, x: bandCentre(grey, w, h, lane[0], lane[1], q.y), name: `${j + 1}.${bandLetter(n)}`,
                    created: q.created, kda: null, label: "", alignOk: al.ok };
      if (near) {
        const c = near.calib, yr = toRef(q.y, al);
        out.ladder = state.ladders.indexOf(near); out.yr = yr;
        if (yr < c.y0) out.label = `>${c.kMax}`;
        else if (yr > c.y1) out.label = `<${c.kMin}`;
        else {
          out.kda = 10 ** c.f(yr);
          out.label = fmtKda(out.kda);
          // uncertainty (log10): band position and leftover running mismatch (rows), through
          // the curve's local slope, plus calibration (ladder leave-one-out)
          const laneBands = state.results[j].bands;
          const found = laneBands.find((b) => Math.abs(b.y - q.y) <= 1);
          const sy = found && !q.created ? found.sigmaY : 3; // 3 rows for a band placed by hand
          // the band's own spread (FWHM / 2.355): a band covers a range of rows, not one row;
          // shoulders and bands placed by hand use the lane's median
          const typical = medianOf(laneBands.filter((b) => b.fwhm).map((b) => b.fwhm)) / 2.355 || 3;
          const sw = found && found.fwhm && !q.created ? found.fwhm / 2.355 : typical;
          const sl = spreadAt(c, yr); // the ladder bands' spread at this row (their positions are as uncertain)
          // running: the leftover mismatch after the correction; where the lane matches the
          // one next to the ladder poorly, the correction itself is in doubt, so the band
          // could be anywhere from its corrected row to where it sits (and at least the worst
          // mismatch seen)
          const run = al.ok ? al.sigma ?? worst : Math.max(al.sigma ?? 0, worst, Math.abs(yr - q.y));
          const rows = Math.hypot(Math.hypot(sy, sw) * al.stretch, run, sl);
          const slope = Math.abs(c.f(Math.min(yr + 0.5, c.y1)) - c.f(Math.max(yr - 0.5, c.y0)));
          const sd = Math.hypot(slope * rows, c.loo ? c.loo(yr) : 0);
          out.pm = out.kda * (10 ** sd - 1);
        }
      }
      return out;
    });
  });
  for (const r of state.results) for (const b of r.bands) b.ladderBand = false;
  state.marks.forEach((marks, j) => { for (const b of state.results[j].bands) b.ladderBand = marks.some((q) => Math.abs(q.y - b.y) <= 1); });
  drawLadderCards();
}

// With Show profiles on: each ladder's calibration curve (log kDa against row) with its
// bands, and the marked bands read from it at their corrected rows (drawCalibration).
function drawCalibrationPlot() {
  const box = $("calibration"), on = $("show-profiles").getAttribute("aria-pressed") === "true";
  const ladders = state.ladders.filter((l) => l.calib);
  box.hidden = !on || !ladders.length;
  if (box.hidden) return;
  const marks = state.pickMarks.flat();
  const outside = marks.filter((q) => q.ladder !== undefined && q.kda === null).map((q) => `${q.name} (${q.label})`);
  drawCalibration($("calibration-canvas"), ladders.map((l) => {
    const m = [...l.markers].sort((a, b) => a.y - b.y);
    return { name: `Ladder ${state.ladders.indexOf(l) + 1}: ${ladderName(l)}, lane ${l.lane}`, kda: m.map((q) => q.kda),
             ys: m.map((q) => q.y), est: m.map((q) => !!q.estimated), f: l.calib.f, y0: l.calib.y0, y1: l.calib.y1 };
  }), ladders.map((l) => marks.filter((q) => q.kda !== null && state.ladders[q.ladder] === l)
    .map((q) => ({ name: q.name, y: q.yr, kda: q.kda, pm: q.pm || 0 }))),
  getComputedStyle(document.body).getPropertyValue("--text-primary").trim() || "#222222");
  $("calibration-note").textContent = "Dots: ladder bands (pale: placed by estimate). Blue: the curve masses are read from, " +
    "passing through every ladder band (log MW, smooth between neighbouring bands). Dashed: a straight line of best fit " +
    "through all the ladder bands, as a check on the gel (r² near 1: it ran evenly; bands far off it: the gel bent there " +
    "or a ladder band is on the wrong size); masses aren't read from it. Red: bands you've marked, at their row corrected for their lane running " +
    "differently, with their ± as a bar." + (outside.length ? ` Outside the ladder (not plotted): ${outside.join(", ")}.` : "");
}

// Clicking on a band marks it: the nearest band found in that lane that isn't marked
// yet (within 8 screen px), or a new one exactly where clicked. (Right-click deletes.)
function clickBand(p) {
  const top = overlayCanvas.height - state.cropImg.h;
  const y = Math.round(p.y - top);
  if (y < 0 || y >= state.cropImg.h) return;
  const space = spaceAt(p.x);
  if (space < 0 || state.dead.has(space)) return; // dead space: not a lane
  const lane = laneSpaces().indexOf(space);
  const picks = (state.picks[lane] = state.picks[lane] || []);
  // snap to the nearest band found that isn't marked yet (within 8 screen px); otherwise
  // create one where clicked. Close neighbours (e.g. a triplet) can each be marked, and a
  // band the finder missed next to a marked one gets created rather than ignored.
  const free = state.results[lane].bands.map((b) => b.y).filter((by) => !picks.some((q) => q.y === by));
  const near = free.sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0];
  if (near !== undefined && Math.abs(near - y) <= 8 * p.px) picks.push({ y: near, created: false });
  else if (!picks.some((q) => Math.abs(q.y - y) <= 2)) picks.push({ y, created: true });
  else { log("click-ignored", { lane: lane + 1, row: y, reason: "already marked" }); return; }
  log("mark", { lane: lane + 1, clickedRow: y, row: picks[picks.length - 1].y, created: picks[picks.length - 1].created });
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
      log("lane-count", { n: est.n, pitch: Math.round(est.pitch), gaps: est.gaps });
      $("lanes").value = Math.max(1, Math.min(60, est.n));
      state.laneNote = `Found ${est.n} lanes (typical lane ${Math.round(est.pitch)} px wide). `;
      state.countLanes = false;
      state.bounds = est.n <= 60 ? est.bounds : null;
      state.dead = new Set(est.dead);
      if (state.flipLanes) mirrorLanes(state.flipLanes, est.n);
      state.flipLanes = 0;
    }
    const n = Math.max(1, Math.min(60, parseInt($("lanes").value, 10) || 1));
    if (!state.bounds || lanePairs().length !== n || state.bounds[state.bounds.length - 1] > w) {
      state.bounds = findLanes(grey, w, h, n);
      state.dead = new Set();
    }
    computeBands();
    logOnChange("analysis", {
      area: { w, h }, geometry: geometry(), source: $("source").value, settings: bandOptions(),
      bounds: state.bounds.map(Math.round), dead: [...state.dead],
      bandsPerLane: state.results.map((r) => r.bands.length),
      noisePerLane: state.results.map((r) => +r.noise.toPrecision(3)),
    });
    drawResults();
  }, 0);
}

// spaces between dividers [start, end); lanes are those that aren't dead space
const spaces = () => state.bounds.slice(0, -1).map((b, i) => [Math.round(b), Math.round(state.bounds[i + 1])]);
const laneSpaces = () => spaces().map((_, i) => i).filter((i) => !state.dead.has(i));
const lanePairs = () => spaces().filter((_, i) => !state.dead.has(i));
const spaceAt = (x) => state.bounds.findIndex((b, i) => i < state.bounds.length - 1 && x >= b && x < state.bounds[i + 1]);

// Turn the space between two dividers into dead space (on) or back into a lane. Lanes
// are numbered over the rest, so everything kept per lane moves with its lane: labels,
// annotations, volumes, marked bands, ladders (a ladder whose lane goes moves to the
// nearest lane and is picked again, and returns if that lane comes back) and groups
// (trimmed to the lanes left).
function setDead(space, on) {
  const before = laneSpaces();
  if (on && before.length <= 1) return; // keep at least one lane
  if (on) state.dead.add(space); else state.dead.delete(space);
  const after = laneSpaces();
  const renumber = (k) => { const i = after.indexOf(before[k - 1]); return i < 0 ? null : i + 1; }; // old lane -> new
  const remap = (arr, offset) => { // arrays indexed by lane number - offset
    const out = [];
    arr.forEach((v, i) => { const k = renumber(i + offset); if (k !== null) out[k - offset] = v; });
    return out;
  };
  for (const key of LANE_ARRAYS) state[key] = remap(state[key], 0);
  state.picks = remap(state.picks, 1);
  const nearest = (sp) => 1 + after.reduce((bi, s, i) => (Math.abs(s - sp) < Math.abs(after[bi] - sp) ? i : bi), 0);
  for (const lad of state.ladders) {
    const k = renumber(lad.lane);
    if (lad.home !== undefined && after.includes(lad.home)) { // its own lane is back
      lad.lane = after.indexOf(lad.home) + 1; delete lad.home; lad.manual = false; lad.markers = null;
    } else if (k === null) {
      lad.home ??= before[lad.lane - 1];
      lad.lane = nearest(before[lad.lane - 1]); lad.manual = false; lad.markers = null;
    } else lad.lane = k;
  }
  for (const g of state.groups) {
    if (g.from === null) continue;
    const kept = after.map((s, i) => i + 1).filter((k) => after[k - 1] >= before[g.from - 1] && after[k - 1] <= before[g.to - 1]);
    if (kept.length) { g.from = kept[0]; g.to = kept[kept.length - 1]; } else g.from = g.to = null;
  }
  log(on ? "lane-removed" : "lane-added", { space, lanes: after.length, dead: [...state.dead] });
  $("lanes").value = after.length;
  stripHover = null;
  computeBands();
  drawResults();
  drawAnnotations(true);
}

function drawResults(active = -1) {
  const { grey, w, h } = state.cropImg;
  // no taller than most of the window, so tall narrow gels can be edited without scrolling
  overlayCanvas.style.maxWidth = `calc(80vh * ${(w / h).toFixed(4)})`;
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
              state.marks, markDrag, state.pickMarks, lanePairs().map(([s, e]) => coreColumns(s, e, value("core"))));
  const sp = spaces();
  drawDeadSpace(ctx, [...state.dead].map((i) => sp[i]).filter(Boolean), top, h, px,
                stripHover === null || !sp[stripHover] ? null
                  : { start: sp[stripHover][0], end: sp[stripHover][1], dead: state.dead.has(stripHover) },
                getComputedStyle(document.body).getPropertyValue("--surface").trim() || "#fff");
  const found = state.results.reduce((a, r) => a + r.bands.length, 0);
  const marked = state.pickMarks.reduce((a, m) => a + m.length, 0);
  const from = $("source").value === "original" ? "original pixels" : "edited image";
  $("summary").textContent = state.laneNote + `${state.results.length} lanes, ${found} bands found, ${marked} marked. ` +
    `Click a band to mark it, drag to move it, right-click to delete it. Profiles read from the ${from}.`;
  drawFigure();
  drawCalibrationPlot();
  drawLadderNotes();
  drawAnnotations();
  drawBandNotes();
  updateCaption();
}

// A ladder marker or marked band under the pointer: {kind: "ladder"|"pick", lane, mark}.
// Only in the circles view.
let stripHover = null; // space under the pointer in the strip above the gel (null: none)
overlayCanvas.addEventListener("pointerleave", () => { if (stripHover !== null) { stripHover = null; drawResults(); } });
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
  log("delete", { lane: hit.lane + 1, row: hit.mark.y, name: hit.mark.name });
  assignLadders();
  drawResults();
});

overlayCanvas.addEventListener("pointerdown", (e) => {
  if (!state.bounds) return;
  const p = canvasPoint(overlayCanvas, e);
  if (e.button !== 0) return; // right-click is handled by "contextmenu"
  if (p.y < overlayCanvas.height - state.cropImg.h) { // the strip above the gel: remove or add a lane
    const space = spaceAt(p.x);
    if (space >= 0) setDead(space, !state.dead.has(space));
    return;
  }
  const hit = markerAt(p);
  if (hit) {
    markDrag = { ...hit, x: hit.mark.x, y: hit.mark.y, startX: p.x, startY: p.y };
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
    if (!state.bounds || !state.cropImg) return;
    const inStrip = p.y < overlayCanvas.height - state.cropImg.h;
    const space = inStrip ? spaceAt(p.x) : -1;
    if ((space < 0 ? null : space) !== stripHover) { stripHover = space < 0 ? null : space; drawResults(); }
    overlayCanvas.title = space < 0 ? "" : state.dead.has(space) ? "Make this a lane" : `Remove lane ${laneSpaces().indexOf(space) + 1} (make it empty space)`;
    const near = !inStrip && state.bounds.some((b) => Math.abs(b - p.x) <= 8 * p.px);
    overlayCanvas.style.cursor = inStrip ? (space < 0 ? "default" : "pointer") : markerAt(p) ? "grab" : near ? "ew-resize" : "default";
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
    const top = overlayCanvas.height - state.cropImg.h;
    const still = Math.hypot(p.x - markDrag.startX, p.y - markDrag.startY) <= 4 * p.px;
    markDrag = null;
    // a press that didn't move, off the circle's centre: a click on a neighbouring band
    // (close bands, e.g. a triplet, sit only a few screen pixels apart)
    if (still && Math.abs(p.y - (top + mark.y)) > 3 * p.px) { clickBand(p); return; }
    if (still) { drawResults(); return; }
    const { y, snapped } = snapRow(lane, dropped, 15 * p.px);
    if (kind === "pick") {
      const picks = state.picks[lane], me = mark.ref;
      const merged = picks.some((q) => q !== me && Math.abs(q.y - y) <= 2);
      log("move-band", { lane: lane + 1, from: me.y, droppedAt: dropped, to: y, snapped, merged });
      if (merged) picks.splice(picks.indexOf(me), 1);
      else { me.y = y; me.created = !snapped; }
      assignLadders();
      drawResults();
      return;
    }
    const lad = state.ladders[mark.ladder];
    const me = lad.markers[mark.i];
    delete me.estimated;
    const other = lad.markers.find((q) => q !== me && Math.abs(q.y - y) <= 2);
    log("move-ladder-band", { ladder: mark.ladder + 1, kda: me.kda, from: me.y, droppedAt: dropped, to: y, snapped,
                              swappedWith: other ? other.kda : null });
    if (other) other.y = me.y;
    me.y = y;
    lad.manual = true;
    assignLadders();
    drawResults();
    return;
  }
  if (laneDrag === null) return;
  log("lane-divider", { divider: laneDrag, x: state.bounds[laneDrag], bounds: state.bounds.map(Math.round) });
  laneDrag = null;
  drawResults();
});

// ---------- ladders ----------

// A ladder's sizes (kDa, largest first): pre-filled from LADDERS when its type is chosen
// (empty for "custom"), then as edited on its card (e.g. sizes that ran off the gel deleted).
const ladderSizes = (lad) => lad.sizes;
const presetSizes = (type) => (type === "custom" ? [] : [...LADDERS[type].kda]);
const ladderName = (lad) => (lad.type === "custom" ? (lad.sizes.length ? `Custom ladder (${lad.sizes.join(", ")} kDa)` : "Custom ladder") : LADDERS[lad.type].name);
// as in the caption: with supplier and catalogue number, e.g. "BenchMark™ Protein Ladder (Thermo Fisher Scientific, cat. # 10747012)"
const ladderCaption = (lad) => {
  const L = LADDERS[lad.type];
  return L && L.catalog ? `${ladderName(lad)} (${[L.supplier, `cat. # ${L.catalog}`].filter(Boolean).join(", ")})` : ladderName(lad);
};
const ladderShort = (lad) => (LADDERS[lad.type] && LADDERS[lad.type].short) || "Ladder";
// "250, 150 100;75" -> [250, 150, 100, 75]: positive numbers, largest first, no repeats
const parseSizes = (text) => [...new Set((text.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((v) => v > 0))]
  .sort((a, b) => b - a);

// One card per ladder on the gel; its dropdown says which ladder it is (LADDERS, or Custom).
function drawLadderCards() {
  const list = $("ladder-cards");
  list.replaceChildren();
  state.ladders.forEach((ladder, i) => {
    const card = $("ladder-card").content.firstElementChild.cloneNode(true);
    card.querySelector(".ladder-title").textContent = `Ladder ${i + 1}`;
    const select = card.querySelector(".ladder-type");
    for (const [key, { name }] of Object.entries(LADDERS)) select.add(new Option(name, key));
    select.add(new Option("Custom (type the sizes)", "custom"));
    select.value = ladder.type;
    const sizesBox = card.querySelector(".ladder-sizes");
    sizesBox.value = ladder.sizes.join(", ");
    sizesBox.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); sizesBox.blur(); } });
    sizesBox.addEventListener("change", () => {
      ladder.sizes = parseSizes(sizesBox.value);
      log("ladder-sizes", { ladder: i + 1, sizes: ladder.sizes });
      changed(); drawLadderCards(); drawLadderNotes(); updateCaption();
    });
    const laneSelect = card.querySelector(".ladder-lane");
    const nLanes = state.bounds ? lanePairs().length : 1;
    laneSelect.add(new Option(state.results ? `Auto (lane ${ladder.lane})` : "Auto", "auto"));
    for (let k = 1; k <= nLanes; k++) laneSelect.add(new Option(String(k), String(k)));
    laneSelect.value = ladder.auto ? "auto" : String(Math.min(ladder.lane, nLanes));
    card.querySelector(".ladder-note").textContent = ladder.note || "";
    const changed = () => { ladder.manual = false; ladder.markers = null; if (state.results) { assignLadders(); drawResults(); } };
    select.addEventListener("change", () => { ladder.type = select.value; ladder.sizes = presetSizes(ladder.type);
      log("ladder-type", { ladder: i + 1, type: ladder.type }); changed(); drawLadderCards(); drawLadderNotes(); updateCaption();
      if (ladder.type === "custom") $("ladder-cards").children[i].querySelector(".ladder-sizes").focus(); });
    laneSelect.addEventListener("change", () => {
      ladder.auto = laneSelect.value === "auto";
      if (ladder.auto) delete ladder.autoKey; else ladder.lane = parseInt(laneSelect.value, 10);
      delete ladder.home; log("ladder-lane", { ladder: i + 1, lane: ladder.auto ? "auto" : ladder.lane }); changed(); drawLadderCards();
    });
    card.querySelector(".ladder-remove").addEventListener("click", () => {
      state.ladders.splice(i, 1);
      if (state.results) { assignLadders(); drawResults(); } else drawLadderCards();
    });
    list.append(card);
  });
}

// lane: where it starts; auto: the page finds its lane (autoLadderLane) until the user chooses one
const newLadder = (lane) => ({ type: Object.keys(LADDERS)[0], sizes: presetSizes(Object.keys(LADDERS)[0]), lane, auto: true, markers: null, manual: false, note: "" });
$("add-ladder").addEventListener("click", () => {
  state.ladders.push(newLadder(state.bounds ? lanePairs().length : 1)); // a second ladder: often the last lane
  if (state.results) { assignLadders(); drawResults(); } else drawLadderCards();
});
state.ladders.push(newLadder(1)); // its lane is found once bands are
drawLadderCards();

// ---------- ladder notes, lane annotations and groups ----------

// Ladder box: one row per ladder, its text pre-filled with the selected ladder (kept
// once edited) and a volume box (left empty).
// true while the user is typing in a text box inside el (don't rebuild under them)
const typingIn = (el) => el.contains(document.activeElement) && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
// a text box that grows a line at a time as lines are added (Enter)
const grow = (el) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; };

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
    text.value = lad.noteText ?? ladderCaption(lad);
    vol.value = lad.volume ?? "";
    text.addEventListener("input", () => { lad.noteText = text.value; updateCaption(); });
    vol.addEventListener("input", () => { lad.volume = vol.value; updateCaption(); });
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
  const n = state.bounds ? lanePairs().length : 0;
  const ladderLanes = new Set(state.ladders.map((l) => l.lane));
  const lanes = Array.from({ length: n }, (_, i) => i + 1).filter((k) => !ladderLanes.has(k));
  for (const g of state.groups) if (g.from && (g.from > n || g.to > n)) { g.from = g.to = null; }
  const head = document.createElement("tr");
  head.innerHTML = "<th>Lane</th><th>Annotation</th><th>Volume</th>";
  state.groups.forEach((g, gi) => {
    const th = document.createElement("th");
    th.className = "group-head";
    th.innerHTML = `<input type="text" class="group-name" placeholder="Group name"><button type="button" class="link group-remove" title="Remove this group">×</button>`;
    const name = th.querySelector(".group-name");
    name.value = g.name;
    name.addEventListener("input", () => { g.name = name.value; drawFigure(); drawPrep(); updateCaption(); });
    th.querySelector(".group-remove").addEventListener("click", () => {
      state.groups.splice(gi, 1);
      drawAnnotations(true); updateCaption();
    });
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
    tr.innerHTML = `<td><textarea class="lane-id" rows="1" spellcheck="false" title="Enter starts a new line"></textarea></td>
      <td><input type="text" class="lane-text" placeholder="Sample, treatment, …"></td>
      <td><span class="unit-box"><input type="text" class="lane-vol" inputmode="decimal"><span class="unit">µL</span></span></td>`;
    const note = tr.querySelector(".lane-text"), vol = tr.querySelector(".lane-vol");
    note.value = state.laneNotes[k] ?? "";
    vol.value = state.laneVols[k] ?? "";
    note.addEventListener("input", () => { state.laneNotes[k] = note.value; drawPrep(); updateCaption(); });
    vol.addEventListener("input", () => { state.laneVols[k] = vol.value; updateCaption(); });
    const id = tr.querySelector(".lane-id");
    id.value = state.laneIds[k] ?? String(k);
    id.addEventListener("input", () => { grow(id); state.laneIds[k] = id.value; drawFigure(); drawPrep(); updateCaption(); });
    state.groups.forEach((g, gi) => {
      const td = document.createElement("td");
      td.className = "group-cell";
      td.dataset.g = String(gi);
      td.dataset.lane = String(k);
      tr.append(td);
    });
    const end = document.createElement("td");
    end.innerHTML = `<button type="button" class="link lane-remove" title="Remove lane ${k} (make it empty space)">×</button>`;
    end.querySelector("button").addEventListener("click", () => setDead(laneSpaces()[k - 1], true));
    tr.append(end);
    return tr;
  });
  table.replaceChildren(head, ...rows);
  table.querySelectorAll("textarea.lane-id").forEach(grow);
  paintGroups();
  drawPrep();
}

// Pasting several lines into a lane annotation box fills that lane and the ones below,
// one line per lane; tab-separated columns (e.g. copied from a spreadsheet) fill across
// Lane label → Annotation → Volume from the column pasted into. One line pastes normally.
$("annot").addEventListener("paste", (e) => {
  const input = e.target.closest("input, textarea");
  const cols = ["lane-id", "lane-text", "lane-vol"];
  const col = input ? cols.findIndex((c) => input.classList.contains(c)) : -1;
  const text = (e.clipboardData || window.clipboardData)?.getData("text") ?? "";
  if (col < 0 || !/[\n\t]/.test(text.replace(/\s+$/, ""))) return;
  e.preventDefault();
  const lines = text.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  const rows = [...$("annot").querySelectorAll("tr")].slice(1);
  const start = rows.indexOf(input.closest("tr"));
  lines.forEach((line, r) => {
    const tr = rows[start + r];
    if (!tr) return; // more lines than lanes: the rest are dropped
    line.split("\t").forEach((cell, c) => {
      const box = cols[col + c] && tr.querySelector(`.${cols[col + c]}`);
      if (!box) return;
      box.value = cell.trim();
      box.dispatchEvent(new Event("input")); // stores it and updates the figure and caption
    });
  });
});

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
window.addEventListener("pointerup", () => {
  if (!groupDrag) return;
  log("group", { group: state.groups.indexOf(groupDrag.g) + 1, from: groupDrag.g.from, to: groupDrag.g.to });
  groupDrag = null;
  drawFigure();
  drawPrep();
  updateCaption();
});

// ---------- band annotations ----------

// Appears once a non-ladder band is marked: per marked band its name, estimated MW with
// uncertainty, and an annotation (kept on the band while it stays marked).
function drawBandNotes() {
  const marked = (state.pickMarks || []).flat();
  logOnChange("marked-bands", marked.map((q) => ({ name: q.name, row: q.y, kDa: q.kda === null ? q.label : +q.kda.toFixed(1),
                                                   pm: q.pm === undefined ? null : +q.pm.toFixed(2), created: q.created,
                                                   runningOk: q.alignOk })));
  $("band-annot").hidden = marked.length === 0;
  const table = $("band-table");
  if (typingIn(table)) return;
  const head = document.createElement("tr");
  head.innerHTML = "<th>Band</th><th>MW (kDa)</th><th>Annotation</th>";
  const rows = marked.map((q) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="band-name"></td><td class="band-mw"></td><td><input type="text" class="band-text" placeholder="e.g. full-length, cleaved, …"></td>`;
    tr.querySelector(".band-name").textContent = q.name;
    tr.querySelector(".band-mw").textContent = q.kda === null ? (q.label || "—")
      : `${fmtKda(q.kda)} ± ${q.pm >= 10 ? q.pm.toFixed(0) : q.pm.toFixed(1)}`;
    const input = tr.querySelector(".band-text");
    input.value = q.ref.note ?? "";
    input.addEventListener("input", () => { q.ref.note = input.value; drawTables(); drawFigure(); });
    return tr;
  });
  table.replaceChildren(head, ...rows);
}

// ---------- sample preparation and tables for the notebook ----------

const num = (v) => { const x = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(x) ? x : null; };
const fmt = (v) => String(+v.toFixed(2)); // 2.0 -> "2", 7.857 -> "7.86"

// Whether a lane gets the reducing agent: as ticked, else (not touched) whether it's in a
// group whose name starts "Reduc", "Red", "Re" or "R" (not "Non-reduced")
const reducedGroup = (k) => state.groups.some((g) => g.from !== null && k >= g.from && k <= g.to
  && /^\s*(reduc|red\b|re\b|r\b)/i.test(g.name) && !/non/i.test(g.name));
const isReduced = (k) => state.laneRed[k] ?? reducedGroup(k);

// One lane's tube: every tube is made up to the total with dye at dyeFold× and, in the
// reduced group, the reducing agent; the rest ("room") is sample and diluent. With an
// amount and a concentration, sample = amount ÷ concentration (mg/mL = µg/µL); without
// an amount, the sample fills the room. over: the amount doesn't fit.
function prepRow(k) {
  const p = state.prep, total = num(p.total), fold = num(p.dyeFold);
  const conc = num(state.laneConc[k]), ug = num(state.laneUg[k]);
  const reduced = isReduced(k);
  const dye = total !== null && fold > 1 ? total / fold : null;
  const red = reduced ? (num(p.reducerUl) ?? 0) : 0;
  const room = dye !== null ? total - dye - red : null;
  let sample = room, amount = conc !== null && room !== null ? conc * room : null;
  if (ug !== null) { amount = ug; sample = conc ? ug / conc : null; }
  const over = sample !== null && room !== null && sample > room + 1e-9;
  const diluent = sample !== null && room !== null ? Math.max(0, room - sample) : null;
  return { conc, ug: amount, sample, diluent, red, dye, total, reduced, over, given: conc !== null || ug !== null };
}

// A sample lane as text: its label (if it isn't just the number) and annotation
function laneDesc(k) {
  const label = (state.laneIds[k] ?? String(k)).replace(/\s*\n\s*/g, " ").trim();
  return [label === String(k) ? "" : label, (state.laneNotes[k] ?? "").trim()].filter(Boolean).join(", ");
}

// Sample preparation: one row per sample lane, its concentration and amount typed, the
// volumes worked out (prepRow). The settings above it apply to every lane.
function drawPrep(force = false) {
  const table = $("prep");
  for (const el of document.querySelectorAll("[data-prep]")) if (document.activeElement !== el) el.value = state.prep[el.dataset.prep];
  if (!force && typingIn(table)) { fillPrep(); return; }
  const n = state.bounds ? lanePairs().length : 0;
  const ladderLanes = new Set(state.ladders.map((l) => l.lane));
  const p = state.prep;
  const head = document.createElement("tr");
  head.innerHTML = `<th>Lane</th><th>Conc.</th><th>Amount</th><th>Reduced</th><th>Sample</th><th></th><th></th><th>Dye</th><th>Total</th>`;
  head.children[5].textContent = p.diluent.trim() || "Diluent";
  head.children[6].textContent = p.reducer.trim() || "Reducing agent";
  const rows = Array.from({ length: n }, (_, i) => i + 1).filter((k) => !ladderLanes.has(k)).map((k) => {
    const tr = document.createElement("tr");
    tr.dataset.lane = String(k);
    tr.innerHTML = `<td class="prep-lane"></td>
      <td><span class="unit-box"><input type="text" class="prep-conc" inputmode="decimal"><span class="unit">mg/mL</span></span></td>
      <td><span class="unit-box"><input type="text" class="prep-ug" inputmode="decimal"><span class="unit">µg</span></span></td>
      <td class="prep-red-tick"><input type="checkbox" class="prep-reduced"></td>
      <td class="calc prep-sample"></td><td class="calc prep-dil"></td><td class="calc prep-red"></td><td class="calc prep-dye"></td><td class="calc prep-total"></td>`;
    const desc = laneDesc(k);
    tr.querySelector(".prep-lane").textContent = desc ? `${k} · ${desc}` : String(k);
    const conc = tr.querySelector(".prep-conc"), ug = tr.querySelector(".prep-ug");
    conc.value = state.laneConc[k] ?? "";
    ug.value = state.laneUg[k] ?? "";
    conc.addEventListener("input", () => { state.laneConc[k] = conc.value; fillPrep(); updateCaption(); });
    ug.addEventListener("input", () => { state.laneUg[k] = ug.value; fillPrep(); updateCaption(); });
    const red = tr.querySelector(".prep-reduced");
    red.checked = isReduced(k);
    red.title = state.laneRed[k] === undefined && reducedGroup(k) ? "Ticked because the lane is in the Reduced group" : "";
    red.addEventListener("change", () => { state.laneRed[k] = red.checked; red.title = ""; fillPrep(); updateCaption(); });
    return tr;
  });
  table.replaceChildren(head, ...rows);
  fillPrep();
}

// the worked-out cells (rebuilt as the user types, without touching their boxes)
function fillPrep() {
  const ul = (v) => (v === null ? "" : `${fmt(v)} µL`);
  for (const tr of $("prep").querySelectorAll("tr[data-lane]")) {
    const r = prepRow(+tr.dataset.lane);
    const cell = (cls, text) => { tr.querySelector(cls).textContent = text; };
    cell(".prep-sample", r.ug !== null && r.conc === null ? "needs conc." : ul(r.sample));
    cell(".prep-dil", r.over ? "" : ul(r.diluent));
    cell(".prep-red", r.reduced ? ul(r.red) : "");
    cell(".prep-dye", ul(r.dye));
    cell(".prep-total", ul(r.total));
    tr.classList.toggle("over", r.over);
    tr.querySelector(".prep-sample").title = r.over
      ? `Too dilute: ${fmt(r.sample)} µL is more than the ${fmt(r.total - r.dye - r.red)} µL left; at most ${fmt(r.conc * (r.total - r.dye - r.red))} µg fits.` : "";
  }
  const over = [...$("prep").querySelectorAll("tr.over")].map((tr) => tr.dataset.lane);
  $("prep-note").textContent = over.length ? `Lane${over.length > 1 ? "s" : ""} ${over.join(", ")}: the amount doesn't fit in the tube (hover for the most that does).` : "";
}

for (const el of document.querySelectorAll("[data-prep]")) {
  el.addEventListener("input", () => { state.prep[el.dataset.prep] = el.value; drawPrep(); updateCaption(); });
}

// The sample preparation as a table for the notebook (lanes with a concentration or amount;
// the reducing agent column only if a group is reduced)
function prepTable() {
  const p = state.prep;
  const ks = state.bounds ? lanePairs().map((_, i) => i + 1).filter((k) => !state.ladders.some((l) => l.lane === k) && prepRow(k).given) : [];
  const g = ks.some(isReduced);
  const rows = [["Lane", "Sample", "Concentration (mg/mL)", "Amount (µg)", "Sample (µL)", `${p.diluent.trim() || "Diluent"} (µL)`,
                 ...(g ? [`${p.reducer.trim() || "Reducing agent"} (µL)`] : []), `Loading dye ${p.dyeFold}× (µL)`, "Total (µL)"]];
  const v = (x) => (x === null ? "" : fmt(x));
  for (const k of ks) {
    const r = prepRow(k);
    const typed = (arr) => (arr[k] ?? "").trim(); // as typed (0.636 stays 0.636)
    rows.push([String(k), laneDesc(k), typed(state.laneConc), typed(state.laneUg) || v(r.ug), r.over ? `${v(r.sample)} (too much)` : v(r.sample), r.over ? "" : v(r.diluent),
               ...(g ? [r.reduced ? v(r.red) : "0"] : []), v(r.dye), v(r.total)]);
  }
  return rows;
}

// Lane assignments: every lane with its sample (ladders: the ladder), its groups, and the
// amount and volume loaded where known (those columns only if any lane has one)
function laneTable() {
  const n = state.bounds ? lanePairs().length : 0;
  const rows = [];
  for (let k = 1; k <= n; k++) {
    const lad = state.ladders.find((l) => l.lane === k);
    const inGroups = state.groups.filter((g) => g.from !== null && k >= g.from && k <= g.to && g.name.trim()).map((g) => g.name.trim()).join(", ");
    if (lad) { rows.push([String(k), (lad.noteText ?? ladderCaption(lad)).trim(), inGroups, "", (lad.volume ?? "").trim()]); continue; }
    const r = prepRow(k), vol = (state.laneVols[k] ?? "").trim().replace(/\s*(µ|u)l$/i, "") || (r.given && r.total !== null ? fmt(r.total) : "");
    rows.push([String(k), laneDesc(k), inGroups, r.ug !== null ? fmt(r.ug) : "", vol]);
  }
  const head = ["Lane", "Sample", "Group", "Amount (µg)", "Volume (µL)"];
  const keep = head.map((_, c) => c < 2 || rows.some((r) => r[c]));
  return [head, ...rows].map((r) => r.filter((_, c) => keep[c]));
}

// Marked bands: name, lane, estimated MW ± uncertainty (? = running correction uncertain)
// and annotation
function bandTable() {
  const rows = [["Band", "Lane", "MW (kDa)", "± (kDa)", "Annotation"]];
  (state.pickMarks || []).forEach((m, i) => m.forEach((q) => rows.push([q.name, String(i + 1),
    q.kda === null ? q.label || "" : fmtKda(q.kda),
    q.kda === null || q.pm === undefined ? "" : q.pm >= 10 ? q.pm.toFixed(0) : q.pm.toFixed(1), (q.ref.note ?? "").trim()])));
  return rows;
}

// The tables under the figure, each with its own Copy button, and Copy all
const TABLES = [
  { title: "Run method", rows: () => runRecord(), empty: "" },
  { title: "Lane assignments", rows: () => laneTable(), empty: "Lanes appear once the image is analysed." },
  { title: "Sample preparation", rows: () => prepTable(), empty: "Type a concentration or amount for a lane under Sample preparation." },
  { title: "Band annotations", rows: () => bandTable(), empty: "Click a band on the gel to mark it." },
];
function drawTables() {
  const box = $("tables");
  box.replaceChildren(...TABLES.map((t) => {
    const rows = t.rows(), sec = document.createElement("div");
    sec.className = "eln-section";
    sec.innerHTML = `<div class="eln-head"><h3 class="sub"></h3><button type="button" class="btn">Copy</button></div>`;
    sec.querySelector("h3").textContent = t.title;
    const btn = sec.querySelector("button");
    if (rows.length < 2) {
      btn.disabled = true;
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = t.empty;
      sec.append(p);
    } else {
      sec.append(htmlTable(rows, false));
      btn.addEventListener("click", () => copyTables([{ title: t.title, rows: t.rows() }], $("tables-note")));
    }
    return sec;
  }));
}
$("copy-all").addEventListener("click", () => {
  const all = TABLES.map((t) => ({ title: t.title, rows: t.rows() })).filter((t) => t.rows.length > 1);
  if (all.length) copyTables(all, $("tables-note"));
});

// rows (first = header) as a <table>; styled: borders written on every cell, for pasting
function htmlTable(rows, styled) {
  const table = document.createElement("table");
  table.className = "eln";
  const cell = "border:1px solid #000;padding:2px 6px;text-align:left;vertical-align:top";
  if (styled) table.setAttribute("style", "border-collapse:collapse");
  rows.forEach((r, i) => {
    const tr = table.insertRow();
    for (const c of r) {
      const td = document.createElement(i ? "td" : "th");
      td.textContent = c;
      if (styled) td.setAttribute("style", cell);
      tr.append(td);
    }
  });
  return table;
}

// Copy tables so they paste as tables into the notebook's rich text (HTML, each under its
// heading if more than one) or a spreadsheet (tab-separated, a blank line between). The
// clipboard is asked during the click.
async function copyTables(tables, note) {
  const many = tables.length > 1;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = tables.map((t) => (many ? `<h3>${esc(t.title)}</h3>` : "") + htmlTable(t.rows, true).outerHTML).join("<p></p>");
  const tsv = tables.map((t) => (many ? `${t.title}\n` : "") + t.rows.map((r) => r.join("\t")).join("\n")).join("\n\n");
  const what = many ? `${tables.length} tables` : `${tables[0].title} (${tables[0].rows.length - 1} row${tables[0].rows.length === 2 ? "" : "s"})`;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }),
                                                         "text/plain": new Blob([tsv], { type: "text/plain" }) })]);
    note.textContent = `Copied ${what}: paste into the notebook or a spreadsheet.`;
  } catch {
    try { await navigator.clipboard.writeText(tsv); note.textContent = `Copied ${what} as tab-separated text.`; }
    catch (err) { note.textContent = `Couldn't copy (${err.message}).`; }
  }
}

// ---------- method ----------

function drawMethod() {
  const m = state.method;
  $("method-type").value = m.type;
  $("stain-row").hidden = m.type !== "sds";
  $("antibody-box").hidden = m.type !== "western";
  $("transfer-fields").hidden = m.type !== "western";
  for (const el of document.querySelectorAll("[data-run]")) {
    if (el.type === "checkbox") el.checked = state.run[el.dataset.run]; else el.value = state.run[el.dataset.run];
  }
  $("stain").value = m.stain;
  const list = $("antibodies");
  list.replaceChildren();
  m.antibodies.forEach((ab, i) => {
    const row = document.createElement("div");
    row.className = "antibody-row";
    row.innerHTML = `<span class="lane-no">Antibody ${i + 1}</span><select class="ab-select"></select>
      <input type="text" class="ab-text" placeholder="Name (supplier, cat. #; dilution)">
      <button type="button" class="link ab-remove">Remove</button>`;
    const sel = row.querySelector(".ab-select"), text = row.querySelector(".ab-text");
    for (const [key, a] of Object.entries(ANTIBODIES)) sel.add(new Option(antibodyLabel(a), key));
    sel.add(new Option("Other (type your own)", "custom"));
    sel.value = ab.key;
    text.value = ab.text;
    text.hidden = ab.key !== "custom";
    sel.addEventListener("change", () => { ab.key = sel.value; text.hidden = ab.key !== "custom"; if (!text.hidden) text.focus(); updateCaption(); });
    text.addEventListener("input", () => { ab.text = text.value; updateCaption(); });
    const remove = row.querySelector(".ab-remove");
    remove.hidden = m.antibodies.length === 1; // always at least one
    remove.addEventListener("click", () => { m.antibodies.splice(i, 1); drawMethod(); updateCaption(); });
    list.append(row);
  });
}

$("method-type").addEventListener("change", () => { state.method.type = $("method-type").value; log("method", { type: state.method.type }); drawMethod(); updateCaption(); });
$("stain").addEventListener("input", () => { state.method.stain = $("stain").value; updateCaption(); });
$("add-antibody").addEventListener("click", () => {
  state.method.antibodies.push({ key: Object.keys(ANTIBODIES)[0], text: "" });
  drawMethod();
  updateCaption();
});
drawMethod();

// "Western blot probed with A and B." / "SDS-PAGE stained with Coomassie."
function methodSentence() {
  const m = state.method;
  if (m.type === "sds") return m.stain.trim() ? `SDS-PAGE stained with ${m.stain.trim()}.` : "SDS-PAGE.";
  const abs = m.antibodies.map((ab) => (ab.key === "custom" ? ab.text.trim() : antibodyCaption(ANTIBODIES[ab.key]))).filter(Boolean);
  const list = abs.length < 3 ? abs.join(" and ") : `${abs.slice(0, -1).join(", ")} and ${abs[abs.length - 1]}`;
  const det = state.run.detection.trim() ? `, detected by ${state.run.detection.trim()}` : "";
  return abs.length ? `Western blot probed with ${list}${det}.` : `Western blot${det}.`;
}

for (const el of document.querySelectorAll("[data-run]")) {
  el.addEventListener(el.type === "checkbox" ? "change" : "input", () => {
    state.run[el.dataset.run] = el.type === "checkbox" ? el.checked : el.value;
    updateCaption();
  });
}

// How the gel was run (and transferred), from the fields filled in, e.g.
//   "Samples were heated at 95 °C for 5 min and run on a NuPAGE 4–12% Bis-Tris gel (12
//    wells) in MES running buffer at 165 V for 35 min."
//   "Proteins were transferred to nitrocellulose (100 V, 1 h, cold room), checked with
//    Ponceau S staining and blocked with 5% BSA in TBS."
function runSentences() {
  const r = Object.fromEntries(Object.entries(state.run).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const out = [];
  const heat = r.heatC || r.heatMin ? `heated${r.heatC ? ` at ${r.heatC} °C` : ""}${r.heatMin ? ` for ${r.heatMin} min` : ""}` : "";
  let run = "";
  if (r.gel || r.buffer || r.volts || r.minutes || r.wells) {
    const gel = r.gel ? (/gels?$/i.test(r.gel) ? r.gel : `${r.gel} gel`) : "";
    run = "run" + (gel ? ` on ${/^([aeiou]|8|11|18)/i.test(gel) ? "an" : "a"} ${gel}` : "")
      + (r.wells ? ` (${r.wells} wells)` : "")
      + (r.buffer ? ` in ${/buffer/i.test(r.buffer) ? r.buffer : `${r.buffer} running buffer`}` : "")
      + (r.volts ? ` at ${r.volts} V` : "") + (r.minutes ? ` for ${r.minutes} min` : "");
  }
  if (heat || run) out.push(`Samples were ${[heat, run].filter(Boolean).join(" and ")}.`);
  if (state.method.type === "western" && (r.membrane || r.transfer || r.ponceau || r.blocking)) {
    const steps = [`transferred${r.membrane ? ` to ${r.membrane}` : ""}${r.transfer ? ` (${r.transfer})` : ""}`];
    if (r.ponceau) steps.push("checked with Ponceau S staining");
    if (r.blocking) steps.push(`blocked with ${r.blocking}`);
    out.push(`Proteins were ${steps.length > 1 ? `${steps.slice(0, -1).join(", ")} and ${steps[steps.length - 1]}` : steps[0]}.`);
  }
  return out;
}

// The run record as a two-column table (Parameter, Details), filled-in fields only.
function runRecord() {
  const r = state.run, m = state.method, rows = [["Parameter", "Details"]];
  const add = (name, v) => { if (v !== "" && v !== false && v != null) rows.push([name, String(v)]); };
  add("Method", m.type === "sds" ? `SDS-PAGE${m.stain.trim() ? `, ${m.stain.trim()} stain` : ""}` : "Western blot");
  add("Gel", r.gel.trim());
  add("Number of wells", r.wells.trim());
  add("Running buffer", r.buffer.trim());
  add("Sample heating", [r.heatC.trim() && `${r.heatC.trim()} °C`, r.heatMin.trim() && `${r.heatMin.trim()} min`].filter(Boolean).join(", "));
  add("Voltage", r.volts.trim() && `${r.volts.trim()} V`);
  add("Running time", r.minutes.trim() && `${r.minutes.trim()} min`);
  state.ladders.forEach((lad, i) => add(state.ladders.length > 1 ? `Ladder ${i + 1}` : "Ladder", (lad.noteText ?? ladderCaption(lad)).trim()));
  const p = state.prep, given = state.bounds ? lanePairs().map((_, i) => i + 1).filter((k) => prepRow(k).given) : [];
  const g = given.some(isReduced);
  if (given.length) {
    const dye = num(p.total) !== null && num(p.dyeFold) > 1 ? `${fmt(num(p.total) / num(p.dyeFold))} µL ` : "";
    add("Sample preparation", `${p.total} µL per lane: sample${p.diluent.trim() ? ` and ${p.diluent.trim()}` : ""}, ${dye}${p.dyeFold}× loading dye`
      + (g ? `; reduced lanes with ${p.reducerUl} µL ${p.reducer.trim()}` : ""));
  }
  if (m.type === "western") {
    add("Membrane", r.membrane.trim());
    add("Transfer", r.transfer.trim());
    if (r.ponceau) add("Transfer check", "Ponceau S staining");
    add("Blocking", r.blocking.trim());
    m.antibodies.forEach((ab, i) => add(m.antibodies.length > 1 ? `Antibody ${i + 1}` : "Antibody",
      ab.key === "custom" ? ab.text.trim() : antibodyLabel(ANTIBODIES[ab.key])));
    add("Detection", r.detection.trim());
  }
  return rows;
}


// ---------- figure caption ----------

// A caption from what's filled in: the method (western blot antibodies, or SDS-PAGE
// stain), then each lane in order with its label, annotation and
// volume (ladders: the ladder's text and volume), lanes with nothing filled left out,
// then the groups with their lanes. Human-readable, e.g.
//   "Lane 1: MagicMark™ XP Western Protein Standard (5 µL). Lane 2: AV/+ neat (10 µL).
//    Groups: + CPI, lanes 2–7; Veh (no CPI), lanes 8–13."
function generateCaption() {
  if (!state.bounds) return "";
  const n = lanePairs().length;
  const vol = (v) => (v && v.trim() ? ` (${v.trim().replace(/\s*(µ|u)l$/i, "")} µL)` : "");
  // sample lanes: amount (from the sample preparation) and volume loaded, e.g. " (5 µg, 20 µL)"
  const load = (k) => {
    const r = prepRow(k), v = (state.laneVols[k] ?? "").trim().replace(/\s*(µ|u)l$/i, "") || (r.given && r.total !== null ? fmt(r.total) : "");
    const parts = [r.ug !== null ? `${fmt(r.ug)} µg` : "", v ? `${v} µL` : ""].filter(Boolean);
    return parts.length ? ` (${parts.join(", ")})` : "";
  };
  const lines = [];
  // lane labels on one line; if two lanes share a label, every lane is named by number too
  const labelOf = (k) => (state.laneIds[k] ?? String(k)).replace(/\s*\n\s*/g, " ").trim() || String(k);
  const all = Array.from({ length: n }, (_, i) => labelOf(i + 1));
  const repeated = all.some((t, i) => all.indexOf(t) !== i);
  for (let k = 1; k <= n; k++) {
    const lad = state.ladders.find((l) => l.lane === k);
    const label = repeated && labelOf(k) !== String(k) ? `${k} (${labelOf(k)})` : labelOf(k);
    if (lad) {
      lines.push(`Lane ${label}: ${(lad.noteText ?? ladderCaption(lad)).trim()}${vol(lad.volume)}.`);
      continue;
    }
    const text = (state.laneNotes[k] ?? "").trim(), v = load(k);
    if (text || v) lines.push(`Lane ${label}: ${text || "sample"}${v}.`);
  }
  lines.unshift(methodSentence(), ...runSentences());
  const range = (g) => (g.from === g.to ? `lane ${g.from}` : `lanes ${g.from}–${g.to}`);
  const groups = state.groups.filter((g) => g.from !== null && g.name.trim());
  if (groups.length) lines.push(`Groups: ${groups.map((g) => `${g.name.trim()}, ${range(g)}`).join("; ")}.`);
  return lines.join(" ");
}

function updateCaption() {
  drawTables();
  if (!state.captionAuto) return;
  const own = generateCaption();
  if (!state.panels.length) { $("caption").value = own; return; }
  const parts = state.panels.map((p, i) => `(${letter(i)}) ${p.caption}`);
  if (showCurrent() && own) parts.push(`(${letter(state.panels.length)}) ${own}`);
  $("caption").value = parts.join(" ");
}

$("caption").addEventListener("input", () => { state.captionAuto = false; }); // edited: stop following
$("caption-regenerate").addEventListener("click", () => { state.captionAuto = true; updateCaption(); });

// ---------- figure ----------

// The analysed gel with ladder sizes down the side: the leftmost ladder on the left, a
// second ladder on the right. (More than two ladders: only those two are shown, for now.)
function drawFigure() {
  const { grey, w, h } = state.cropImg;
  const placed = state.ladders.filter((l) => l.markers && l.markers.length).sort((a, b) => a.lane - b.lane);
  const side = (l) => (l ? [...l.markers].sort((a, b) => a.y - b.y).map((q) => ({ y: q.y, kda: q.kda })) : null);
  // above the gel: lane labels and annotations (sample lanes; ladders are on the MW scale)
  // and group bars, one row per group column that has lanes
  // with the lane list, lanes are numbered above the gel and described beside it
  const pairs = lanePairs(), listed = $("show-list").checked, named = $("show-ladder-names").checked;
  const ladderAt = (k) => state.ladders.find((l) => l.lane === k);
  const lanes = pairs.map(([x0, x1], i) => {
    const lad = ladderAt(i + 1);
    if (lad) return { x0, x1, id: listed && !named ? String(i + 1) : "", text: "", ladder: named ? ladderShort(lad) : "" };
    return { x0, x1, id: listed ? String(i + 1) : state.laneIds[i + 1] ?? String(i + 1), text: "" };
  });
  const list = !listed ? [] : pairs.map((_, i) => {
    const lad = ladderAt(i + 1), text = lad ? `Ladder: ${(lad.noteText ?? ladderName(lad)).trim()}` : laneDesc(i + 1);
    return text ? `${i + 1}. ${text}` : "";
  }).filter(Boolean);
  // each group on the lowest row where it doesn't overlap another (side-by-side groups share a row)
  const rows = [];
  const groups = state.groups.filter((g) => g.from !== null && g.to <= pairs.length).map((g) => {
    let level = 0;
    while ((rows[level] || []).some((o) => o.from <= g.to && g.from <= o.to)) level++;
    (rows[level] = rows[level] || []).push(g);
    return { x0: pairs[g.from - 1][0], x1: pairs[g.to - 1][1], name: g.name, level };
  });
  // marked bands: a red arrowhead and name ("4.A") on the gel; the key beside it gives each
  // name's annotation and MW (the full table is under Tables for the notebook)
  const picked = (state.pickMarks || []).flatMap((m, j) => m.map((q) => ({ q, j })));
  const bands = !$("show-bands").checked ? [] : picked.map(({ q, j }) => ({ x0: pairs[j][0], x1: pairs[j][1], y: q.y, name: q.name }));
  const key = !$("show-bands").checked || !$("show-band-key").checked ? [] : picked.map(({ q }) => {
    const note = (q.ref.note ?? "").trim(), mw = q.kda !== null ? `${fmtKda(q.kda)} kDa` : q.label ? `${q.label} kDa` : "";
    return { name: q.name, text: note && mw ? `${note} (${mw})` : note || mw };
  });
  const show = { ids: $("show-ids").checked, notes: false, groups: $("show-groups").checked, crowded: $("show-crowded").checked };
  const sizes = $("show-sizes").checked;
  renderFigure(figCanvas, grey, w, h, sizes ? side(placed[0]) : null, sizes && placed.length > 1 ? side(placed[placed.length - 1]) : null,
               { lanes, groups, show, list, bands, key });
  composeFigure();
  $("figure-note").textContent = placed.length > 2
    ? `${placed.length} ladders: only the leftmost and rightmost are marked on the figure.` : "";
}

for (const id of ["show-ids", "show-groups", "show-crowded", "show-list", "show-ladder-names", "show-sizes", "show-bands", "show-band-key"]) {
  $(id).addEventListener("change", () => state.cropImg && drawFigure());
}

// Panels: figures kept with "Keep as panel" are drawn left of this one, all scaled to the
// same height and lettered A, B, …; the caption gives each panel's caption after its
// letter. A kept figure isn't drawn twice: this image's figure shows again once another
// image is loaded.
const figCanvas = document.createElement("canvas"); // this image's figure, before panels
const letter = (i) => String.fromCharCode(65 + i);
const showCurrent = () => !state.panels.length || state.panels[state.panels.length - 1].src !== state.src;
function composeFigure() {
  const out = $("figure-canvas"), ctx = out.getContext("2d");
  const parts = [...state.panels.map((p) => p.canvas), ...(showCurrent() ? [figCanvas] : [])];
  if (!state.panels.length) {
    out.width = figCanvas.width; out.height = figCanvas.height;
    ctx.drawImage(figCanvas, 0, 0);
    return;
  }
  const H = Math.max(...parts.map((c) => c.height));
  const strip = Math.round(H * 0.07), gap = Math.round(H * 0.04);
  const widths = parts.map((c) => Math.round((c.width * H) / c.height));
  out.width = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
  out.height = H + strip;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = "#000000";
  ctx.font = `bold ${Math.round(strip * 0.8)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let x = 0;
  parts.forEach((c, i) => {
    ctx.drawImage(c, x, strip, widths[i], H);
    ctx.fillText(letter(i), x + Math.round(strip * 0.2), Math.round(strip * 0.85));
    x += widths[i] + gap;
  });
}

$("fig-pin").addEventListener("click", () => {
  if (!state.cropImg || !showCurrent()) return;
  const c = document.createElement("canvas");
  c.width = figCanvas.width; c.height = figCanvas.height;
  c.getContext("2d").drawImage(figCanvas, 0, 0);
  // the caption as written (if edited and no panels yet), else as generated
  const caption = state.captionAuto || state.panels.length ? generateCaption() : $("caption").value.trim();
  state.panels.push({ canvas: c, caption, src: state.src });
  state.captionAuto = true;
  log("panel", { panels: state.panels.length });
  $("fig-unpin").hidden = false;
  composeFigure();
  updateCaption();
  $("figure-note").textContent = `Kept as panel ${letter(state.panels.length - 1)}. Load the next image: its figure goes beside it as panel ${letter(state.panels.length)}.`;
});
$("fig-unpin").addEventListener("click", () => {
  state.panels = [];
  log("panel", { panels: 0 });
  $("fig-unpin").hidden = true;
  $("figure-note").textContent = "";
  if (state.cropImg) drawFigure();
  updateCaption();
});

$("fig-download").addEventListener("click", () => {
  log("download", { what: "figure" });
  $("figure-canvas").toBlob((b) => save(b, `${state.src.name}_figure.png`));
});

// The clipboard is asked during the click itself, with a promise of the PNG: browsers
// (Safari especially) refuse clipboard writes that start after the click has finished.
$("fig-copy").addEventListener("click", async () => {
  const png = new Promise((resolve) => $("figure-canvas").toBlob(resolve, "image/png"));
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    $("figure-note").textContent = "Copied to the clipboard.";
    log("copy", { what: "figure", ok: true });
  } catch (err) {
    $("figure-note").textContent = `Couldn't copy (${err.message}); use Download instead.`;
    log("copy", { what: "figure", ok: false, message: err.message });
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

$("dl-log").addEventListener("click", () => {
  save(new Blob([logText()], { type: "text/plain" }), `gel-ed_log_${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
});

$("dl-overlay").addEventListener("click", () => {
  log("download", { what: "overlay" });
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
  const edits = [...GEOMETRY.map((k) => value(k)), state.flip, ...TONE.map((k) => value(k))];
  // marked bands and ladder bands; kind/saturated/snr come from the band found at that row (if any)
  const rows = [["band", "lane", "lane_start_col", "lane_end_col", "row", "col", "kDa", "kDa_uncertainty", "ladder_size_kDa", "found_or_created", "annotation",
                 "kind", "saturated", "snr", "read_from", ...GEOMETRY, "flip", ...TONE, "invert"]];
  const found = (i, y) => state.results[i].bands.find((b) => Math.abs(b.y - y) <= 1);
  const extra = (b) => (b ? [b.kind, b.saturated, b.snr.toFixed(1)] : ["", "", ""]);
  lanePairs().forEach(([s, e], i) => {
    for (const q of state.marks[i]) rows.push(["", i + 1, s, e - 1, q.y, q.x.toFixed(1), q.kda, "", q.kda,
      found(i, q.y) ? "found" : "created", "", ...extra(found(i, q.y)), $("source").value, ...edits, state.invert]);
    for (const q of state.pickMarks[i]) rows.push([q.name, i + 1, s, e - 1, q.y, q.x.toFixed(1),
      q.kda !== null ? q.kda.toFixed(1) : q.label, q.pm !== undefined ? q.pm.toFixed(1) : "", "",
      q.created ? "created" : "found", `"${(q.ref.note ?? "").replace(/"/g, '""')}"`, ...extra(found(i, q.y)),
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
$("source").addEventListener("change", () => { log("source", { value: $("source").value }); state.src && analyse(); });
$("redo").addEventListener("click", () => { log("redo"); state.src && analyse(); });
// sliders: one entry when released, not on every step
for (const id of [...GEOMETRY, ...TONE, ...BANDS]) $(id).addEventListener("change", () => log("setting", { [id]: value(id) }));
$("show-profiles").addEventListener("click", () => { // for debugging: profiles and band kinds
  const on = $("show-profiles").getAttribute("aria-pressed") !== "true";
  log("show-profiles", { on });
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
  log("invert", { on: state.invert });
  $("invert").setAttribute("aria-pressed", String(state.invert));
  applyTone();
});
// Flipping moves everything left-right: the area goes back to the whole image and the
// lanes are found again.
$("flip").addEventListener("click", () => {
  state.flip = !state.flip;
  log("flip", { on: state.flip });
  $("flip").setAttribute("aria-pressed", String(state.flip));
  if (!state.src) return;
  state.flipLanes = state.bounds ? lanePairs().length : 0; // lane count before: lanes are mirrored after counting
  state.cropUser = false;
  state.countLanes = true;
  state.bounds = null;
  applyGeometry();
});
$("reset-edits").addEventListener("click", () => { log("reset-edits"); resetEdits(); });
$("lanes").addEventListener("change", () => {
  log("lanes-set", { n: $("lanes").value }); state.bounds = null; state.laneNote = ""; resetLadders(); analyse(); });
$("find-lanes").addEventListener("click", () => {
  log("find-lanes"); state.countLanes = true; resetLadders(); analyse(); });
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
