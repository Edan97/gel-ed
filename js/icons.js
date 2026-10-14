// Small pictures at each end of the editor sliders showing what that end does.
// Geometry icons put a square through the same transform the editor uses (amounts
// exaggerated so the direction is easy to see): dashed = before, solid = after.

import { matrix, outline } from "./transform.js?v=0ce2184c";

const NS = "http://www.w3.org/2000/svg";
const SIZE = 15;                       // square side in icon units
const GEOMETRY = { rotation: 25, skew: 0.45, distort: 0.45, perspective: 1 };

function svg() {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 28 24");
  el.setAttribute("width", "28");
  el.setAttribute("height", "24");
  return el;
}

function poly(points, cls) {
  const el = document.createElementNS(NS, "polygon");
  el.setAttribute("points", points.map((p) => p.join(",")).join(" "));
  el.setAttribute("class", cls);
  return el;
}

function rect(x, y, w, h, fill) {
  const el = document.createElementNS(NS, "rect");
  Object.entries({ x, y, width: w, height: h, fill }).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function geometryIcon(name, end) {
  const el = svg();
  const shift = ([x, y]) => [x - (SIZE - 1) / 2 + 14, y - (SIZE - 1) / 2 + 12];
  const square = [[0, 0], [SIZE - 1, 0], [SIZE - 1, SIZE - 1], [0, SIZE - 1]];
  el.append(poly(square.map(shift), "before"));
  const m = matrix(SIZE, SIZE, { [name]: GEOMETRY[name] * end });
  el.append(poly(outline(SIZE, SIZE, m).map(shift), "after"));
  return el;
}

function toneIcon(name, end) {
  const el = svg();
  if (name === "brightness") {
    el.append(rect(7, 5, 14, 14, end < 0 ? "#3a3a3a" : "#e4e4e4"));
  } else { // contrast: two halves pulled together (low) or apart (high)
    el.append(rect(7, 5, 7, 14, end < 0 ? "#8a8a8a" : "#111111"));
    el.append(rect(14, 5, 7, 14, end < 0 ? "#a6a6a6" : "#f2f2f2"));
  }
  const frame = rect(7, 5, 14, 14, "none");
  frame.setAttribute("class", "frame");
  el.append(frame);
  return el;
}

export function drawIcons(root = document) {
  root.querySelectorAll(".icon[data-icon]").forEach((span) => {
    const name = span.dataset.icon, end = Number(span.dataset.end);
    span.replaceChildren(name in GEOMETRY ? geometryIcon(name, end) : toneIcon(name, end));
    span.title = `${name}: ${end < 0 ? "slider left" : "slider right"}`;
  });
}
