// gel-ed web app: load → edit (tone, geometry; crop set automatically) → lanes → bands → overlay.

import { readImage } from "./image.js?v=eaa84c3f";
import { matrix, warp, frame, outline, cropValid, largestCrop, clampCrop } from "./transform.js?v=eaa84c3f";
import { findBands, findLanes } from "./bands.js?v=eaa84c3f";
import { greyToImageData, drawOverlay, drawDividers } from "./draw.js?v=eaa84c3f";
import { median } from "./signal.js?v=eaa84c3f";
import { drawIcons } from "./icons.js?v=eaa84c3f";

const $ = (id) => document.getElementById(id);
const GEOMETRY = ["rotation", "skew", "distort", "perspective"];
const TONE = ["brightness", "contrast"];
const BANDS = ["k", "core", "smooth", "noiseRows"];
const LABEL_SPACE = 26; // screen px above the overlay for lane numbers

const state = {
  src: null,        // {grey, w, h, name}
  box: null,        // frame of the edited image: {x0, y0, W, H} (whole transformed image)
  warped: null,     // geometry applied, W x H
  edited: null,     // geometry + tone
  poly: null,       // original image outline after geometry, in edited-image pixels
  crop: null,       // {x0, y0, x1, y1} in edited-image pixels (inclusive); automatic, draggable
  invert: false,
  bounds: null,     // lane boundaries in crop columns
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
  state.box = null;
  showValues();
  if (rerun) applyGeometry();
}

function applyGeometry() {
  const { grey, w, h } = state.src;
  const m = matrix(w, h, geometry());
  const box = frame(w, h, m);
  if (state.crop && state.box) { // keep the crop on the same part of the image as the frame moves
    const dx = state.box.x0 - box.x0, dy = state.box.y0 - box.y0;
    state.crop = { x0: state.crop.x0 + dx, x1: state.crop.x1 + dx, y0: state.crop.y0 + dy, y1: state.crop.y1 + dy };
  }
  state.box = box;
  state.warped = warp(grey, w, h, m, box);
  state.poly = outline(w, h, m).map(([x, y]) => [x - box.x0, y - box.y0]);
  if (!state.crop || !cropValid(state.crop, state.poly, box.W, box.H)) {
    const cx = (w - 1) / 2 - box.x0, cy = (h - 1) / 2 - box.y0;
    state.crop = largestCrop(state.poly, box.W, box.H, cx, cy, (w - 1) / 2, (h - 1) / 2);
  }
  applyTone();
}

function applyTone() {
  const b = value("brightness");
  const f = Math.tan(((value("contrast") + 1) * Math.PI) / 4); // 0 → ×1; ±0.9 → ×0.08 / ×12.7
  const inv = state.invert;
  state.edited = state.warped.map((v) => {
    if (Number.isNaN(v)) return v;
    const t = Math.min(Math.max((v - 0.5) * f + 0.5 + b, 0), 1);
    return inv ? 1 - t : t;
  });
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
  const next = clampCrop(state.crop, want, state.poly, w, h);
  state.crop = { x0: Math.ceil(next.x0), y0: Math.ceil(next.y0), x1: Math.floor(next.x1), y1: Math.floor(next.y1) };
  if (!cropValid(state.crop, state.poly, w, h)) state.crop = drag.crop;
  drawEditor();
});

editCanvas.addEventListener("pointerup", () => {
  if (!drag) return;
  drag = null;
  state.bounds = null; // crop changed: place lanes again
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

let pending = false;
function analyse() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    state.cropImg = cropImage();
    const { grey, w, h } = state.cropImg;
    const n = Math.max(1, Math.min(60, parseInt($("lanes").value, 10) || 1));
    if (!state.bounds || state.bounds.length !== n + 1 || state.bounds[n] !== w) state.bounds = findLanes(grey, w, h, n);
    const opts = bandOptions();
    state.results = lanePairs().map(([s, e]) => findBands(grey, w, h, s, e, opts));
    drawResults();
  });
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
  drawOverlay(ctx, lanePairs(), state.results, top, px);
  const counts = state.results.map((r) => r.bands.length);
  $("summary").textContent = `${counts.length} lanes, ${counts.reduce((a, b) => a + b, 0)} bands ` +
    `(per lane: ${counts.join(", ")}). Rows and columns are in the cropped image.`;
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
  const { grey, w, h } = state.cropImg;
  const opts = bandOptions();
  state.results = lanePairs().map(([s, e]) => findBands(grey, w, h, s, e, opts));
  drawResults(i);
});

overlayCanvas.addEventListener("pointerup", () => {
  if (laneDrag === null) return;
  laneDrag = null;
  drawResults();
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
  const rows = [["lane", "lane_start_col", "lane_end_col", "row", "kind", "saturated", "snr"]];
  lanePairs().forEach(([s, e], i) => state.results[i].bands.forEach((b) =>
    rows.push([i + 1, s, e - 1, b.y, b.kind, b.saturated, b.snr.toFixed(1)])));
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
for (const id of [...GEOMETRY, ...TONE]) {
  $(id).addEventListener("dblclick", () => { $(id).value = 0; $(id).dispatchEvent(new Event("input")); });
}
$("invert").addEventListener("click", () => {
  state.invert = !state.invert;
  $("invert").setAttribute("aria-pressed", String(state.invert));
  applyTone();
});
$("reset-edits").addEventListener("click", () => resetEdits());
$("lanes").addEventListener("change", () => { state.bounds = null; analyse(); });
$("find-lanes").addEventListener("click", () => { state.bounds = null; analyse(); });
window.addEventListener("resize", () => { if (state.src) { drawEditor(); drawResults(); } });

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
