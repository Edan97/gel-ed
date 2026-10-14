// gel-ed web app: load → edit (tone, geometry) → lanes → bands → overlay.
// Profiles are read from the original pixels through the edit's transform (or, to
// compare, from the resampled edited image): see profilesFromOriginal in bands.js.

import { readImage } from "./image.js?v=181cadd8";
import { matrix, warp, frame, cropValid, clampCrop } from "./transform.js?v=181cadd8";
import { bandsFromProfile, coreColumns, countLanes, findLanes, profilesFromOriginal, DEFAULTS } from "./bands.js?v=181cadd8";
import { greyToImageData, drawOverlay, drawDividers } from "./draw.js?v=181cadd8";
import { median } from "./signal.js?v=181cadd8";
import { LADDERS } from "./ladders.js?v=181cadd8";
import { drawIcons } from "./icons.js?v=181cadd8";

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
  ladders: [],      // one {type} per ladder card; type is a key of LADDERS
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
  drawOverlay(ctx, lanePairs(), state.results, top, px, $("show-profiles").getAttribute("aria-pressed") === "true");
  const counts = state.results.map((r) => r.bands.length);
  const from = $("source").value === "original" ? "original pixels" : "edited image";
  $("summary").textContent = state.laneNote + `${counts.length} lanes, ${counts.reduce((a, b) => a + b, 0)} bands ` +
    `(per lane: ${counts.join(", ")}), read from the ${from}. Rows and columns are in the analysed area.`;
}

overlayCanvas.addEventListener("pointerdown", (e) => {
  if (!state.bounds) return;
  const p = canvasPoint(overlayCanvas, e);
  let best = -1, dist = 8 * p.px;
  state.bounds.forEach((b, i) => { if (Math.abs(b - p.x) <= dist) { best = i; dist = Math.abs(b - p.x); } });
  if (best < 0) return;
  laneDrag = best;
  overlayCanvas.setPointerCapture(e.pointerId);
});

overlayCanvas.addEventListener("pointermove", (e) => {
  const p = canvasPoint(overlayCanvas, e);
  if (laneDrag === null) {
    const near = state.bounds && state.bounds.some((b) => Math.abs(b - p.x) <= 8 * p.px);
    overlayCanvas.style.cursor = near ? "ew-resize" : "default";
    return;
  }
  const b = state.bounds, i = laneDrag, gap = 4;
  const lo = i === 0 ? 0 : b[i - 1] + gap, hi = i === b.length - 1 ? state.cropImg.w : b[i + 1] - gap;
  b[i] = Math.round(Math.min(Math.max(p.x, lo), hi));
  computeBands();
  drawResults(i);
});

overlayCanvas.addEventListener("pointerup", () => {
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
    const sizes = () => { card.querySelector(".ladder-sizes").textContent = `${LADDERS[ladder.type].kda.join(", ")} kDa`; };
    sizes();
    select.addEventListener("change", () => { ladder.type = select.value; sizes(); });
    card.querySelector(".ladder-remove").addEventListener("click", () => {
      state.ladders.splice(i, 1);
      drawLadderCards();
    });
    list.append(card);
  });
}

$("add-ladder").addEventListener("click", () => {
  state.ladders.push({ type: Object.keys(LADDERS)[0] });
  drawLadderCards();
});
state.ladders.push({ type: Object.keys(LADDERS)[0] }); // most gels have one ladder
drawLadderCards();

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
  const rows = [["lane", "lane_start_col", "lane_end_col", "row", "kind", "saturated", "snr", "read_from",
                 ...GEOMETRY, ...TONE, "invert"]];
  lanePairs().forEach(([s, e], i) => state.results[i].bands.forEach((b) =>
    rows.push([i + 1, s, e - 1, b.y, b.kind, b.saturated, b.snr.toFixed(1), $("source").value,
               ...edits, state.invert])));
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
$("lanes").addEventListener("change", () => { state.bounds = null; state.laneNote = ""; analyse(); });
$("find-lanes").addEventListener("click", () => { state.countLanes = true; analyse(); });
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
