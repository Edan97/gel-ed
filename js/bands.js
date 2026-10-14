// Band finding and lane placement. findBands is a port of scoping/band_peaks.py
// find_bands (checked against it by tests/parity.html). Images are greyscale
// Float64Arrays, 0 = black, 1 = white, row-major; bands are dark on light.

import { findPeaks, gaussian1d, mad, minFilter1d, roundHalfEven } from "./signal.js?v=eaa84c3f";

export const DEFAULTS = { core: 0.25, smooth: 1.0, noiseRows: 61, k: 6, sep: 5, satLevel: 0.03, satFrac: 0.2 };

// One lane: columns [start, end) of an image w wide and h tall.
export function findBands(img, w, h, start, end, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = end - start;
  const c0 = start + roundHalfEven((n * (1 - o.core)) / 2);
  const c1 = start + roundHalfEven((n * (1 + o.core)) / 2);
  const nc = Math.max(1, c1 - c0);

  // 1. raw profile: mean darkness per row over the central columns
  const mean = new Float64Array(h);
  const saturated = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, black = 0;
    for (let x = c0; x < c0 + nc; x++) {
      const v = img[y * w + x];
      s += 1 - v;
      if (v <= o.satLevel) black++;
    }
    mean[y] = s / nc;
    saturated[y] = black / nc >= o.satFrac ? 1 : 0;
  }
  const prof = gaussian1d(mean, o.smooth);

  // 2. noise from the wobble around a smoothed copy (thresholds only, never subtracted)
  const smoothCopy = gaussian1d(prof, o.noiseRows / 6);
  const noise = mad(prof.map((v, i) => v - smoothCopy[i]));

  // 5. saturated rows, widened by sep
  const satNear = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    if (!saturated[y]) continue;
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
    ...peaks.map((p) => ({ y: p.i, kind: "peak", height: p.prom, snr: p.prom / noise, saturated: !!satNear[p.i] })),
    ...shoulders.map((c) => ({ y: c, kind: "shoulder", height: prof[c] - localMin[c],
                               snr: (prof[c] - localMin[c]) / noise, saturated: false })),
  ].sort((a, b) => a.y - b.y);
  return { bands, profile: prof, noise, coreCols: [c0, c0 + nc] };
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
  const col = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[x] += 1 - img[y * w + x];
  const pitch = w / n;
  const s = gaussian1d(col.map((v) => v / h), Math.max(2, pitch / 20));
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
