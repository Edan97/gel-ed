// Ladder band picking and mass calibration.

import { gaussian1d, median } from "./signal.js?v=12a48e35";

// Monotone piecewise-cubic interpolation, scipy.interpolate.PchipInterpolator's formulas
// (the Python mass calibration uses it). xs strictly increasing. Returns f(x); outside
// xs it extrapolates the end pieces (callers decide whether to trust that).
export function pchip(xs, ys) {
  const n = xs.length;
  const h = [], m = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); m.push((ys[i + 1] - ys[i]) / h[i]); }
  const d = new Array(n).fill(0);
  if (n === 2) { d[0] = d[1] = m[0]; } else {
    for (let k = 1; k < n - 1; k++) {
      if (m[k - 1] * m[k] <= 0) continue; // a turning point or a flat piece: slope 0
      const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
      d[k] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k]);
    }
    const edge = (h0, h1, m0, m1) => { // one-sided three-point estimate, kept shape-preserving
      let e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
      if (Math.sign(e) !== Math.sign(m0)) e = 0;
      else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > Math.abs(3 * m0)) e = 3 * m0;
      return e;
    };
    d[0] = edge(h[0], h[1], m[0], m[1]);
    d[n - 1] = edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], hi = h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hi * d[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hi * d[i + 1];
  };
}

// How solid a band is across its width: darkness above each column's background,
// averaged over rows y-2..y+2, smoothed; over the band's span (columns at least half its
// peak) the share that is actually dark. Real ladder bands are uniform strips (0.94-1.00
// on gel_02); a smudge with a bright spot in it scored 0.78.
export function bandSolidity(img, w, h, start, end, y, background) {
  const n = end - start;
  const col = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0, k = 0;
    for (let r = Math.max(0, y - 2); r <= Math.min(h - 1, y + 2); r++) {
      const v = img[r * w + start + x];
      if (!Number.isNaN(v)) { s += 1 - v; k++; }
    }
    col[x] = k ? s / k - background[x] : 0;
  }
  const sm = gaussian1d(col, 2), fine = gaussian1d(col, 1);
  let peak = -Infinity;
  for (const v of sm) peak = Math.max(peak, v);
  if (!(peak > 0)) return 0;
  let l = -1, r = -1;
  for (let x = 0; x < n; x++) if (sm[x] >= peak / 2) { if (l < 0) l = x; r = x; }
  let dark = 0;
  for (let x = l; x <= r; x++) if (fine[x] >= peak / 2) dark++;
  return dark / (r - l + 1);
}

// Each column's background darkness in lane [start, end): its median over all rows.
export function laneBackground(img, w, h, start, end) {
  const bg = new Float64Array(end - start);
  for (let x = start; x < end; x++) {
    const v = [];
    for (let y = 0; y < h; y++) { const q = img[y * w + x]; if (!Number.isNaN(q)) v.push(1 - q); }
    bg[x - start] = v.length ? median(v) : 0;
  }
  return bg;
}

// Pick which detected bands are the ladder's (sizes largest first, e.g. kDa or bp).
// Returns one entry per size: its band, or null where no band fits (placed by estimate
// later). As scoping/ladder_pick.py pick_ladder_bands.
// 1. Solid bands only (solidity 0.85 or more: a smudge with a bright spot scored 0.78
//    on gel_02, real bands 0.94-1.00); shoulders count, at a cost (a DNA ladder's 0.9,
//    0.8 and 0.6 kb bands sit on the flanks of the brighter 1.0 and 0.5 kb ones). Fewer
//    than 3 solid: the most solid, top to bottom.
// 2. spacingFit: which band, if any, each size goes to.
export function pickLadderBands(bands, solidity, sizes, mass = null) {
  const n = sizes.length;
  const ranked = bands.map((b, i) => ({ b, s: solidity[i] }))
    .sort((p, q) => (Math.abs(q.s - p.s) > 0.02 ? q.s - p.s : q.b.snr - p.b.snr));
  const byRow = (a) => a.sort((p, q) => p.y - q.y);
  const solid = byRow(ranked.filter((p) => p.s >= 0.85).map((p) => p.b));
  if (solid.length < 3 || n < 3) {
    const top = byRow(ranked.slice(0, n).map((p) => p.b));
    return sizes.map((_, i) => top[i] ?? null);
  }
  return spacingFit(solid, sizes, mass).map((k) => (k < 0 ? null : solid[k]));
}

const MISS = 3;          // a size with no band (more than leaving out the strongest band, 2)
const SHOULDER = 2;      // picking a shoulder rather than a peak
const GAP = 6;           // at most GAP - 1 sizes missing between two picked bands (a tight crop can lose all
                         // four faint bands between the 1 kb Plus's 1.0 and 0.5 kb)
const MASS_WEIGHT = 0.1; // brightness against the ladder's masses: a tie-break

// Down a ladder log10(size) changes smoothly with row: for three consecutive picks the
// slopes between the first two and the last two should be alike, cost (ln of their
// ratio)^2. Each candidate left out costs its strength relative to the median candidate
// (at most 2), so strong bands aren't skipped to make the spacing tidier; each size with
// no band MISS (a well or smudge above the ladder no longer pushes every size down one).
// With masses (ng per band, e.g. the 1 kb Plus ladder's brighter 3.0, 1.0 and 0.5 kb
// bands), each pick also costs MASS_WEIGHT x (ln of its brightness, height x width,
// relative to the rest minus ln of its mass relative to the rest)^2: light, since large
// DNA bands came out several times fainter than their mass. Dynamic programming over
// (size, band, size and band picked before it). Returns, per size, a candidate index or -1.
function spacingFit(c, sizes, mass) {
  const m = c.length, n = sizes.length;
  const lk = sizes.map((k) => Math.log10(k));
  const mid = median(c.map((b) => b.snr)) || 1;
  const cum = [0];
  for (const b of c) cum.push(cum[cum.length - 1] + Math.min(b.snr / mid, 2));
  const skip = (a, b) => (b > a ? cum[b] - cum[a] : 0); // leaving out candidates a..b-1
  const mc = (i, j) => (c[j].kind === "shoulder" ? SHOULDER : 0) + (massCost ? massCost[i * m + j] : 0);
  let massCost = null;
  if (mass && mass.length === n) {
    const la = c.map((b) => Math.log(Math.max(b.height, 1e-9) * (b.fwhm || 4)));
    const lm = mass.map((v) => Math.log(v));
    const top = [...la].sort((a, b) => b - a).slice(0, n);
    const off = median(top) - median(lm);
    massCost = new Float64Array(n * m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) massCost[i * m + j] = MASS_WEIGHT * (la[j] - lm[i] - off) ** 2;
  }
  // C[i][j][g][p]: size i on candidate j, the pick before it size i-g on candidate p
  const G = GAP + 1;
  const at = (i, j, g, p) => ((i * m + j) * G + g) * m + p;
  const C = new Float64Array(n * m * G * m).fill(Infinity);
  const B = new Int32Array(n * m * G * m).fill(-1); // best (g2 * m + q) before it, -1 = first pick
  for (let i = 0; i < n; i++) {
    for (let g = 1; g <= GAP && i - g >= 0; g++) {
      const ip = i - g;
      for (let j = 0; j < m; j++) {
        for (let p = 0; p < j; p++) {
          let best = MISS * ip + skip(0, p) + mc(ip, p), from = -1;
          if (ip > 0) {
            const s2 = (lk[i] - lk[ip]) / (c[j].y - c[p].y);
            for (let g2 = 1; g2 <= GAP && ip - g2 >= 0; g2++) {
              const iq = ip - g2;
              for (let q = 0; q < p; q++) {
                const prev = C[at(ip, p, g2, q)];
                if (prev === Infinity) continue;
                const s1 = (lk[ip] - lk[iq]) / (c[p].y - c[q].y);
                const v = prev + Math.log(s2 / s1) ** 2;
                if (v < best) { best = v; from = g2 * m + q; }
              }
            }
          }
          C[at(i, j, g, p)] = best + skip(p + 1, j) + MISS * (g - 1) + mc(i, j);
          B[at(i, j, g, p)] = from;
        }
      }
    }
  }
  let best = Infinity, end = null;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) for (let g = 1; g <= GAP; g++) for (let p = 0; p < j; p++) {
    const v = C[at(i, j, g, p)] + MISS * (n - 1 - i) + skip(j + 1, m);
    if (v < best) { best = v; end = [i, j, g, p]; }
  }
  const out = new Array(n).fill(-1);
  if (!end) return out;
  let [i, j, g, p] = end;
  for (;;) {
    out[i] = j;
    out[i - g] = p;
    const from = B[at(i, j, g, p)];
    if (from < 0) break;
    [i, j, g, p] = [i - g, p, Math.floor(from / m), from % m];
  }
  return out;
}

// Rows in the top quarter where at least 80% of lanes (and 3) have a peak: wells, the
// stacking line, the gel's top edge, not ladder bands. [{y, tol}]. As ladder_pick.py.
export function commonRows(laneBands, h) {
  const tol = Math.max(4, Math.round(0.01 * h));
  const peaks = laneBands.map((bs) => bs.filter((b) => b.kind === "peak").map((b) => b.y));
  const need = Math.max(3, Math.ceil(0.8 * laneBands.length));
  const rows = [...new Set(peaks.flat().filter((y) => y < h / 4))].sort((a, b) => a - b);
  return rows.filter((r) => peaks.filter((ys) => ys.some((y) => Math.abs(y - r) <= tol)).length >= need)
    .map((y) => ({ y, tol }));
}

// Calibration uncertainty, as scoping/band_masses.py: leave each interior ladder band out,
// predict its log10(kDa) from the rest; the miss, interpolated by row (held flat beyond
// the outer interior bands). Conservative: leaving a band out doubles the gap bridged.
// Returns f(row) -> log10 uncertainty, or null with fewer than 4 ladder bands.
export function ladderLoo(rows, logk) {
  if (rows.length < 4) return null;
  const at = [], err = [];
  for (let i = 1; i < rows.length - 1; i++) {
    const f = pchip(rows.filter((_, j) => j !== i), logk.filter((_, j) => j !== i));
    at.push(rows[i]);
    err.push(Math.abs(f(rows[i]) - logk[i]));
  }
  return (y) => {
    if (y <= at[0]) return err[0];
    if (y >= at[at.length - 1]) return err[err.length - 1];
    let i = 0;
    while (y > at[i + 1]) i++;
    return err[i] + ((err[i + 1] - err[i]) * (y - at[i])) / (at[i + 1] - at[i]);
  };
}
