// Correction for lanes running differently (port of scoping/band_masses.py). With one
// ladder, every lane would otherwise be read as if it ran exactly like the ladder; on
// gel_02 the same band sits up to ~60 rows higher on the right of the gel. Each lane's
// rows are mapped onto a reference lane (the one next to its ladder) by a shift and a
// slight stretch, chosen to best match where the two profiles rise and fall:
//     reference row = (row - c) * stretch + c + shift,   c = middle row
// The match uses the slope of an asinh-compressed profile so faint and strong lanes
// compare; that transform is for matching only. ASSUMPTION: the reference lane ran like
// the ladder (the ladder shares no bands with the samples, so this can't be checked).

import { gaussian1d } from "./signal.js?v=c2cf0cc8";

// where a profile rises and falls, at a scale where faint and strong lanes compare
export function matchSignal(profile, noise) {
  let min = Infinity;
  for (const v of profile) if (!Number.isNaN(v)) min = Math.min(min, v);
  const lw = 10 * noise || 1e-6;
  return gaussian1d(profile.map((v) => (Number.isNaN(v) ? 0 : Math.asinh((v - min) / lw))), 2, 1);
}

function corrAt(sig, ref, c, stretch, shift) {
  const n = sig.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, k = 0;
  for (let y = 0; y < n; y++) {
    const yr = (y - c) * stretch + c + shift;
    if (yr < 0 || yr > n - 1) continue;
    const i = Math.min(Math.floor(yr), n - 2), f = yr - i;
    const r = ref[i] * (1 - f) + ref[i + 1] * f, x = sig[y];
    sx += x; sy += r; sxx += x * x; syy += r * r; sxy += x * r; k++;
  }
  if (k < n / 2) return -Infinity; // must overlap at least half the lane
  const cov = sxy - (sx * sy) / k, vx = sxx - (sx * sx) / k, vy = syy - (sy * sy) / k;
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : -Infinity;
}

// Best shift (rows, -100..100) and stretch (0.90..1.10): a coarse grid, then a fine one
// around its best (Python searches the fine grid everywhere; same answer, ~10x faster).
export function align(sig, ref) {
  const c = (sig.length - 1) / 2;
  let best = { corr: -Infinity, shift: 0, stretch: 1 };
  const tryAt = (stretch, shift) => {
    const r = corrAt(sig, ref, c, stretch, shift);
    if (r > best.corr) best = { corr: r, shift, stretch };
  };
  for (let b = 0.90; b <= 1.1001; b += 0.02) for (let s = -100; s <= 100; s += 4) tryAt(+b.toFixed(2), s);
  const { shift: s0, stretch: b0 } = best;
  for (let b = b0 - 0.02; b <= b0 + 0.0201; b += 0.01) for (let s = s0 - 4; s <= s0 + 4; s++) tryAt(+b.toFixed(2), s);
  return { ...best, centre: c };
}

export const toRef = (y, a) => (y - a.centre) * a.stretch + a.centre + a.shift;

// Leftover row mismatch after matching: a lane's clear peaks (in reference rows) paired
// with the reference lane's nearest within 10 rows, minus what band positions explain.
// null with fewer than 3 pairs.
export function alignmentSigma(bands, refBands, a) {
  const clear = (bs) => bs.filter((d) => d.kind === "peak" && !d.saturated);
  const ref = clear(refBands);
  if (!ref.length) return null;
  const diffs = [], vars = [];
  for (const d of clear(bands)) {
    const yr = toRef(d.y, a);
    const r = ref.reduce((p, q) => (Math.abs(q.y - yr) < Math.abs(p.y - yr) ? q : p));
    if (Math.abs(r.y - yr) <= 10) { diffs.push(yr - r.y); vars.push(d.sigmaY ** 2 + r.sigmaY ** 2); }
  }
  if (diffs.length < 3) return null;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(Math.max(mean(diffs.map((x) => x * x)) - mean(vars), 0));
}
