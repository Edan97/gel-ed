// Ladder band picking and mass calibration.

import { gaussian1d, median } from "./signal.js?v=cecb406a";

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

// Pick which detected bands are the ladder's (sizes in kDa, largest first), returned top
// to bottom. Fewer candidates than sizes: all of them.
// 1. Solid peaks only: shoulders and bands less solid than 0.85 go (a smudge with a bright
//    spot: 0.78 on gel_02; real bands 0.94-1.00), as long as at least as many remain as
//    there are sizes. If too few remain: the most solid (ties: the stronger), as before.
// 2. Still too many (gel_04: a well bottom and 15 real bands for 15 sizes): the set whose
//    spacing fits the sizes best. Down a ladder log10(kDa) changes smoothly with row, so
//    for each three consecutive picks the slope between the first two and the last two
//    should be alike: cost (ln of their ratio)^2, plus, for each band left out, its
//    strength relative to the median candidate (at most 2), so strong bands aren't
//    skipped to make the spacing look tidier. Dynamic programming over (size, band,
//    band picked for the size above), so every choice is considered.
export function pickLadderBands(bands, solidity, sizes) {
  const n = sizes.length;
  const ranked = bands.map((b, i) => ({ b, s: solidity[i] }))
    .sort((p, q) => (Math.abs(q.s - p.s) > 0.02 ? q.s - p.s : q.b.snr - p.b.snr));
  const solid = ranked.filter((p) => p.s >= 0.85 && p.b.kind === "peak").map((p) => p.b);
  const byRow = (a) => a.sort((p, q) => p.y - q.y);
  if (solid.length < n) return byRow(ranked.slice(0, n).map((p) => p.b));
  const c = byRow(solid);
  return n < 3 || c.length === n ? c.slice(0, n) : spacingFit(c, sizes);
}

function spacingFit(c, sizes) {
  const m = c.length, n = sizes.length;
  const lk = sizes.map((k) => Math.log10(k));
  const mid = median(c.map((b) => b.snr)) || 1;
  const cum = [0];
  for (const b of c) cum.push(cum[cum.length - 1] + Math.min(b.snr / mid, 2));
  const skip = (a, b) => cum[b] - cum[a]; // leaving out candidates a..b-1
  // cost[i][j][p]: sizes 0..i placed, size i on candidate j, size i-1 on candidate p
  const idx = (j, p) => j * m + p;
  let cost = new Float64Array(m * m).fill(Infinity);
  const back = [];
  for (let j = 1; j < m; j++) for (let p = 0; p < j; p++) cost[idx(j, p)] = skip(0, p) + skip(p + 1, j);
  for (let i = 2; i < n; i++) {
    const next = new Float64Array(m * m).fill(Infinity), from = new Int32Array(m * m).fill(-1);
    for (let j = i; j < m - (n - 1 - i); j++) {
      for (let p = i - 1; p < j; p++) {
        const s2 = (lk[i] - lk[i - 1]) / (c[j].y - c[p].y);
        for (let q = i - 2; q < p; q++) {
          const prev = cost[idx(p, q)];
          if (prev === Infinity) continue;
          const s1 = (lk[i - 1] - lk[i - 2]) / (c[p].y - c[q].y);
          const v = prev + Math.log(s2 / s1) ** 2 + skip(p + 1, j);
          if (v < next[idx(j, p)]) { next[idx(j, p)] = v; from[idx(j, p)] = q; }
        }
      }
    }
    cost = next;
    back.push(from);
  }
  let best = Infinity, bj = -1, bp = -1;
  for (let j = 1; j < m; j++) for (let p = 0; p < j; p++) {
    const v = cost[idx(j, p)] + skip(j + 1, m);
    if (v < best) { best = v; bj = j; bp = p; }
  }
  const out = [bj, bp];
  for (let i = n - 1; i >= 2; i--) {
    const q = back[i - 2][idx(bj, bp)];
    out.push(q);
    bj = bp; bp = q;
  }
  return out.reverse().map((k) => c[k]);
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
