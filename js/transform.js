// Geometric edits as one 3x3 projective transform about the image centre, applied by
// inverse mapping with bilinear sampling. The output is the bounding box of the whole
// transformed image (frame), so nothing is cut off; pixels that come from outside the
// original image are NaN. Coordinates are pixel centres: the image spans 0..w-1, 0..h-1.
//
// Sliders (all 0 = no change):
//   rotation     degrees
//   skew         horizontal shear: x moves with y (straightens leaning lanes)
//   distort      vertical shear: y moves with x (levels bands that slope across the gel)
//   perspective  keystone: positive makes the bottom narrower than the top

const mul = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((s, _, k) => s + a[i][k] * b[k][j], 0)));

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

export function apply(m, x, y) {
  const w = m[2][0] * x + m[2][1] * y + m[2][2];
  return [(m[0][0] * x + m[0][1] * y + m[0][2]) / w, (m[1][0] * x + m[1][1] * y + m[1][2]) / w];
}

export function matrix(w, h, { rotation = 0, skew = 0, distort = 0, perspective = 0 }) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const t = (rotation * Math.PI) / 180;
  const p = (perspective * 0.6) / Math.max(h - 1, 1); // |p * h/2| <= 0.3 keeps every row in front
  const steps = [
    [[1, 0, cx], [0, 1, cy], [0, 0, 1]],
    [[1, 0, 0], [0, 1, 0], [0, p, 1]],
    [[1, 0, 0], [distort, 1, 0], [0, 0, 1]],
    [[1, skew, 0], [0, 1, 0], [0, 0, 1]],
    [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]],
    [[1, 0, -cx], [0, 1, -cy], [0, 0, 1]],
  ];
  return steps.reduce(mul);
}

// Bounding box of the transformed image: output pixel (x, y) is transformed point
// (x + x0, y + y0).
export function frame(w, h, m) {
  const pts = outline(w, h, m);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs) + 1e-9), y0 = Math.floor(Math.min(...ys) + 1e-9);
  return { x0, y0, W: Math.ceil(Math.max(...xs) - 1e-9) - x0 + 1, H: Math.ceil(Math.max(...ys) - 1e-9) - y0 + 1 };
}

export function warp(src, w, h, m, box = { x0: 0, y0: 0, W: w, H: h }) {
  const [[a, b, c], [d, e, f], [g, k, l]] = invert3(m);
  const { W, H } = box;
  const out = new Float64Array(W * H);
  const xmax = Math.max(w - 2, 0), ymax = Math.max(h - 2, 0);
  const r = w > 1 ? 1 : 0, dn = h > 1 ? w : 0;
  for (let y = 0; y < H; y++) {
    const Y = y + box.y0;
    for (let x = 0; x < W; x++) {
      const X = x + box.x0;
      const z = g * X + k * Y + l;
      const u = (a * X + b * Y + c) / z, v = (d * X + e * Y + f) / z;
      if (!(u >= -0.5 && v >= -0.5 && u <= w - 0.5 && v <= h - 0.5)) { out[y * W + x] = NaN; continue; }
      const uc = Math.min(Math.max(u, 0), w - 1), vc = Math.min(Math.max(v, 0), h - 1);
      const x0 = Math.min(Math.floor(uc), xmax), y0 = Math.min(Math.floor(vc), ymax);
      const fx = uc - x0, fy = vc - y0, i = y0 * w + x0;
      out[y * W + x] = (src[i] * (1 - fx) + src[i + r] * fx) * (1 - fy)
                     + (src[i + dn] * (1 - fx) + src[i + dn + r] * fx) * fy;
    }
  }
  return out;
}

// the original image's outline after the transform (convex: a projective image of a rectangle)
export function outline(w, h, m) {
  return [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]].map(([x, y]) => apply(m, x, y));
}

function insideConvex(poly, x, y, eps = 1e-6) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (Math.abs(cross) < eps) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

// A crop {x0, y0, x1, y1} is allowed only if every pixel in it comes from the image:
// all four corners inside the transformed outline (and inside the canvas).
export function cropValid(r, poly, w, h) {
  if (r.x0 < 0 || r.y0 < 0 || r.x1 > w - 1 || r.y1 > h - 1 || r.x1 - r.x0 < 4 || r.y1 - r.y0 < 4) return false;
  return [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].every(([x, y]) => insideConvex(poly, x, y));
}

// Largest allowed crop centred on (cx, cy) (the image centre, which the transform keeps
// fixed): grow with the original's proportions (half-sizes hw0, hh0), then widen, then
// heighten. w, h: canvas size.
export function largestCrop(poly, w, h, cx = (w - 1) / 2, cy = (h - 1) / 2, hw0 = cx, hh0 = cy) {
  const rect = (hw, hh) => ({ x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh });
  const grow = (f, lo, hi) => {
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (f(mid)) lo = mid; else hi = mid; }
    return lo;
  };
  const s = grow((s) => cropValid(rect(s * hw0, s * hh0), poly, w, h), 0, 1);
  const hw = grow((v) => cropValid(rect(v, s * hh0), poly, w, h), s * hw0, w);
  const hh = grow((v) => cropValid(rect(hw, v), poly, w, h), s * hh0, h);
  const r = rect(hw, hh);
  return { x0: Math.ceil(r.x0), y0: Math.ceil(r.y0), x1: Math.floor(r.x1), y1: Math.floor(r.y1) };
}

// Move from an allowed crop towards a requested one, stopping at the last allowed point.
export function clampCrop(from, to, poly, w, h) {
  if (cropValid(to, poly, w, h)) return to;
  const at = (t) => ({
    x0: from.x0 + (to.x0 - from.x0) * t, y0: from.y0 + (to.y0 - from.y0) * t,
    x1: from.x1 + (to.x1 - from.x1) * t, y1: from.y1 + (to.y1 - from.y1) * t,
  });
  let lo = 0, hi = 1;
  for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (cropValid(at(mid), poly, w, h)) lo = mid; else hi = mid; }
  return at(lo);
}
