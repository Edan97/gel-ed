// Band finding and lane placement. findBands is a port of scoping/band_peaks.py
// find_bands (checked against it by tests/parity.html). Images are greyscale
// Float64Arrays, 0 = black, 1 = white, row-major; bands are dark on light.

import { findPeaks, gaussian1d, mad, minFilter1d, roundHalfEven } from "./signal.js?v=f1b74688";

export const DEFAULTS = { core: 0.25, smooth: 1.0, noiseRows: 61, k: 6, sep: 5, satLevel: 0.03, satFrac: 0.2 };

// Central columns of a lane [start, end): [c0, c1), as in Python (round half to even).
export function coreColumns(start, end, core) {
  const n = end - start;
  const c0 = start + roundHalfEven((n * (1 - core)) / 2);
  const c1 = start + roundHalfEven((n * (1 + core)) / 2);
  return [c0, Math.max(c0 + 1, c1)];
}

// One lane: columns [start, end) of an image w wide and h tall. The profile is the mean
// darkness per row over the lane's central columns.
export function findBands(img, w, h, start, end, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const [c0, c1] = coreColumns(start, end, o.core);
  const nc = c1 - c0;
  const mean = new Float64Array(h), black = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, b = 0;
    for (let x = c0; x < c1; x++) {
      const v = img[y * w + x];
      s += 1 - v;
      if (v <= o.satLevel) b++;
    }
    mean[y] = s / nc;
    black[y] = b / nc;
  }
  return { ...bandsFromProfile(mean, black, o), coreCols: [c0, c1] };
}

// Bands in one lane's raw profile: mean darkness per row (NaN = no pixels in that row)
// and the fraction of near-black pixels per row. Rows before the first and after the
// last row with pixels are left out; gaps inside are filled linearly.
export function bandsFromProfile(meanIn, blackFrac, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const H = meanIn.length;
  let first = 0, last = H - 1;
  while (first < H && Number.isNaN(meanIn[first])) first++;
  while (last >= 0 && Number.isNaN(meanIn[last])) last--;
  const full = new Float64Array(H).fill(NaN);
  if (last - first < 10) return { bands: [], profile: full, noise: 0 };
  const h = last - first + 1;
  const mean = Float64Array.from(meanIn.subarray(first, last + 1));
  for (let i = 0; i < h; i++) { // fill interior gaps linearly
    if (!Number.isNaN(mean[i])) continue;
    let j = i;
    while (Number.isNaN(mean[j])) j++;
    for (let t = i; t < j; t++) mean[t] = mean[i - 1] + ((mean[j] - mean[i - 1]) * (t - i + 1)) / (j - i + 1);
    i = j;
  }

  // 1. raw profile, lightly smoothed
  const prof = gaussian1d(mean, o.smooth);

  // 2. noise from the wobble around a smoothed copy (thresholds only, never subtracted)
  const smoothCopy = gaussian1d(prof, o.noiseRows / 6);
  const noise = mad(prof.map((v, i) => v - smoothCopy[i]));

  // 5. saturated rows (enough near-black pixels), widened by sep
  const satNear = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    if (!(blackFrac[first + y] >= o.satFrac)) continue;
    for (let d = -o.sep; d <= o.sep; d++) if (y + d >= 0 && y + d < h) satNear[y + d] = 1;
  }

  // 3. peaks by prominence
  const peaks = findPeaks(prof, o.k * noise, 2);

  // 4. shoulders from curvature
  const localMin = minFilter1d(prof, o.noiseRows);
  const curv = gaussian1d(prof, 2.0, 2).map((v) => -v);
  const cpk = findPeaks(curv, o.k * mad(curv));
  const peakRows = peaks.map((p) => p.i);
  const shoulders = cpk.map((p) => p.i).filter((c) =>
    prof[c] - localMin[c] > o.k * noise && !satNear[c] &&
    (peakRows.length === 0 || Math.min(...peakRows.map((r) => Math.abs(r - c))) > o.sep));

  const bands = [
    ...peaks.map((p) => ({ y: first + p.i, kind: "peak", height: p.prom, snr: p.prom / noise, saturated: !!satNear[p.i] })),
    ...shoulders.map((c) => ({ y: first + c, kind: "shoulder", height: prof[c] - localMin[c],
                               snr: (prof[c] - localMin[c]) / noise, saturated: false })),
  ].sort((a, b) => a.y - b.y);
  full.set(prof, first);
  return { bands, profile: full, noise };
}

// Profiles read from the ORIGINAL pixels, using the edit's transform instead of the
// resampled image. Every original pixel is sent through the transform m to its position
// in the edited view, then (if it lands inside the analysed rectangle and in a lane's
// central columns) added to that lane at its nearest edited row. Each pixel counts once
// and none is blended, so resampling can't smooth the noise or invent values.
//   src, w, h   original image          m, box    transform and edited frame (transform.js)
//   rect        analysed area, edited-frame pixels {x0, y0, x1, y1} (inclusive)
//   bounds      lane boundaries, columns of the analysed area     tone  value -> value
// Returns one {mean, black} per lane, indexed by row of the analysed area (NaN = empty).
export function profilesFromOriginal(src, w, h, m, box, rect, bounds, core, satLevel, tone) {
  const W = rect.x1 - rect.x0 + 1, H = rect.y1 - rect.y0 + 1;
  const n = bounds.length - 1;
  const cols = bounds.slice(0, -1).map((b, i) => coreColumns(Math.round(b), Math.round(bounds[i + 1]), core));
  const lane = new Int32Array(W).fill(-1); // analysed-area column -> lane whose centre it's in
  cols.forEach(([c0, c1], i) => { for (let x = Math.max(c0, 0); x < Math.min(c1, W); x++) lane[x] = i; });
  const sum = Array.from({ length: n }, () => new Float64Array(H));
  const cnt = Array.from({ length: n }, () => new Float64Array(H));
  const blk = Array.from({ length: n }, () => new Float64Array(H));
  const [[a, b, c], [d, e, f], [g, k, l]] = m;
  const ox = box.x0 + rect.x0, oy = box.y0 + rect.y0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const z = g * u + k * v + l;
      const x = Math.round((a * u + b * v + c) / z - ox), y = Math.round((d * u + e * v + f) / z - oy);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const i = lane[x];
      if (i < 0) continue;
      const val = tone(src[v * w + u]);
      sum[i][y] += 1 - val;
      cnt[i][y] += 1;
      if (val <= satLevel) blk[i][y] += 1;
    }
  }
  return sum.map((s, i) => ({
    mean: s.map((t, y) => (cnt[i][y] ? t / cnt[i][y] : NaN)),
    black: blk[i].map((t, y) => (cnt[i][y] ? t / cnt[i][y] : 0)),
  }));
}

// Lane boundaries for n lanes across an image, chosen together like the teeth of a comb:
// the n-1 dividers sit on the palest columns (gaps between lanes) they can, while every
// inner lane stays 0.8-1.2x the average lane width and the outer two 0.3-1.6x (ladders
// are often narrower, and there may be margin at the edges). Comb teeth are evenly
// spaced, and a faint lane can be as pale as a gap, so the inner limits are tight
// (on gel_02 every inner lane is 0.9-1.03x). Dynamic programming over columns finds
// the best set. Returns n+1 boundaries from 0 to w.
export function findLanes(img, w, h, n) {
  if (n < 2) return [0, w];
  const col = new Float64Array(w), cnt = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      if (Number.isNaN(v)) continue; // blank: outside the original image
      col[x] += 1 - v;
      cnt[x]++;
    }
  }
  const pitch = w / n;
  let pale = Infinity;
  for (let x = 0; x < w; x++) if (cnt[x]) pale = Math.min(pale, col[x] / cnt[x]);
  const s = gaussian1d(col.map((v, x) => (cnt[x] ? v / cnt[x] : pale)), Math.max(2, pitch / 20));
  let lo = Infinity, hi = -Infinity;
  for (const v of s) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const gap = s.map((v) => (hi - v) / (hi - lo || 1)); // 1 = palest column, 0 = darkest
  const inner = [Math.ceil(0.8 * pitch), Math.floor(1.2 * pitch)];
  const outer = [Math.ceil(0.3 * pitch), Math.floor(1.6 * pitch)];

  // best[k][x]: best total gap score with divider k (1..n-1) at column x
  const best = [], from = [];
  for (let k = 1; k < n; k++) {
    const b = new Float64Array(w).fill(-Infinity), f = new Int32Array(w).fill(-1);
    for (let x = 1; x < w; x++) {
      if (k === 1) {
        if (x >= outer[0] && x <= outer[1]) b[x] = gap[x];
        continue;
      }
      for (let d = inner[0]; d <= inner[1] && x - d >= 1; d++) {
        const v = best[k - 2][x - d] + gap[x];
        if (v > b[x]) { b[x] = v; f[x] = x - d; }
      }
    }
    best.push(b);
    from.push(f);
  }
  let end = -1, top = -Infinity;
  for (let x = 1; x < w; x++) {
    const last = w - x;
    if (last >= outer[0] && last <= outer[1] && best[n - 2][x] > top) { top = best[n - 2][x]; end = x; }
  }
  if (end < 0) return Array.from({ length: n + 1 }, (_, i) => Math.round((i * w) / n)); // can't fit: even spacing
  const div = [end];
  for (let k = n - 2; k >= 1; k--) div.unshift(from[k][div[0]]);
  return [0, ...div, w];
}
