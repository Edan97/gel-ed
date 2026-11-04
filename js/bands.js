// Band finding and lane placement. findBands is a port of scoping/band_peaks.py
// find_bands (checked against it by tests/parity.html). Images are greyscale
// Float64Arrays, 0 = black, 1 = white, row-major; bands are dark on light.

import { findPeaks, gaussian1d, mad, median, minFilter1d, roundHalfEven } from "./signal.js?v=12a48e35";

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
  let noise = mad(prof.map((v, i) => v - smoothCopy[i]));
  if (o.noiseCap !== undefined) noise = Math.min(noise, o.noiseCap); // ladder lanes short of bands: see assignLadders

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

  // position uncertainty (rows), as scoping/band_peaks.py: peaks 1.5 x (FWHM/2.355) / SNR
  // (at least 0.25); saturated peaks at least the saturated run / sqrt(12); shoulders 2
  const satRun = (i) => { let a = i, b = i; while (a > 0 && satNear[a - 1]) a--; while (b < h - 1 && satNear[b + 1]) b++; return b - a + 1; };
  const sigmaPeak = (p) => {
    let sd = Math.max(0.25, (1.5 * (p.width / 2.355)) / (p.prom / noise));
    if (satNear[p.i]) sd = Math.max(sd, satRun(p.i) / Math.sqrt(12));
    return sd;
  };
  const bands = [
    ...peaks.map((p) => ({ y: first + p.i, kind: "peak", height: p.prom, snr: p.prom / noise, saturated: !!satNear[p.i],
                           sigmaY: sigmaPeak(p), fwhm: p.width })),
    ...shoulders.map((c) => ({ y: first + c, kind: "shoulder", sigmaY: 2, fwhm: null, height: prof[c] - localMin[c],
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

// Horizontal middle of a band at row y in lane columns [start, end): darkness per column,
// averaged over rows y-2..y+2 and lightly smoothed, then the outermost columns at least
// halfway from the lane's palest to its darkest column; the band's middle is halfway
// between them (as edges() in scoping/ladder_centreline.py). Falls back to the lane's
// middle if the band has no measurable width.
export function bandCentre(img, w, h, start, end, y) {
  const n = end - start;
  const col = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let s = 0, k = 0;
    for (let r = Math.max(0, y - 2); r <= Math.min(h - 1, y + 2); r++) {
      const v = img[r * w + start + x];
      if (!Number.isNaN(v)) { s += 1 - v; k++; }
    }
    col[x] = k ? s / k : NaN;
  }
  const valid = col.filter((v) => !Number.isNaN(v));
  if (valid.length < 3) return (start + end) / 2;
  const fill = Math.min(...valid);
  const sm = gaussian1d(col.map((v) => (Number.isNaN(v) ? fill : v)), 2);
  const lo = Math.min(...sm), hi = Math.max(...sm);
  if (!(hi > lo)) return (start + end) / 2;
  const half = lo + 0.5 * (hi - lo);
  let left = -1, right = -1;
  for (let x = 0; x < n; x++) if (sm[x] >= half) { if (left < 0) left = x; right = x; }
  return start + (left + right) / 2;
}

// Band content of each column: darkness above the column's own background, averaged
// down the column (blank NaN pixels ignored). The background is a running median down
// the column over about 1/8 of the height, taken every quarter window and interpolated.
// Unlike plain darkness, the gel's uneven background cancels, so a lane with bands
// stands out from an empty one. As scoping/count_lanes.py.
function columnContent(img, w, h) {
  const win = Math.max(15, Math.floor(h / 8)) | 1, half = win >> 1, step = Math.max(1, win >> 2);
  const ys = [];
  for (let y = 0; y < h; y += step) ys.push(y);
  if (ys[ys.length - 1] !== h - 1) ys.push(h - 1);
  const out = new Float64Array(w);
  const buf = [];
  for (let x = 0; x < w; x++) {
    const meds = ys.map((y) => {
      buf.length = 0;
      for (let r = Math.max(0, y - half); r < Math.min(h, y + half + 1); r++) {
        const v = img[r * w + x];
        if (!Number.isNaN(v)) buf.push(1 - v);
      }
      return buf.length ? median(buf) : NaN;
    });
    let sum = 0, cnt = 0, j = 0;
    for (let y = 0; y < h; y++) {
      const v = img[y * w + x];
      if (Number.isNaN(v)) continue;
      while (j < ys.length - 2 && ys[j + 1] <= y) j++;
      const a = meds[j], b = meds[j + 1];
      const t = (y - ys[j]) / (ys[j + 1] - ys[j] || 1);
      const bg = Number.isNaN(a) ? b : Number.isNaN(b) ? a : a + (b - a) * Math.min(1, Math.max(0, t));
      sum += Math.max(0, 1 - v - bg);
      cnt++;
    }
    out[x] = cnt ? sum / cnt : 0;
  }
  return out;
}

// How many lanes, and where? Fits an evenly spaced comb to the column band content:
// for each lane width p and offset, the score is the sum over lanes of (content across
// the lane's middle 40%) minus (content at its darker divider, +-5% of p; with the mean of
// the two, flat-topped lanes on a well straightened gel tie with half their width). Loaded lanes score
// when the dividers fall in the gaps beside them; empty lanes score about nothing, so
// they don't pull the fit (a gel with only a few loaded lanes still gets the right
// width), and halving or doubling the width puts dividers on bands. Lane widths from
// w/40 (at least 8 px) to w/2 in 1% steps, offsets in steps of p/40 (at least 1 px).
// Then each divider moves to the palest column within +-15% of p; empty lanes at either
// edge (middle 40% no darker than 4% of the way from the 5th to the 95th percentile
// column: a lane with one faint band, gel_04's lane 1, is 6-11%; empty edges on the
// samples are at most 2%) are dead space, not lanes (the user can turn them back into lanes); and an
// edge lane narrower than half a lane joins its neighbour. Returns {n, pitch, gaps,
// bounds, dead}: bounds from 0 to w, every divider; dead = indices of the spaces between
// them that aren't lanes; n and gaps count lanes only. On gel_02:
// 13 lanes, dividers within 20 px of the hand-placed ones; on gel_03 (most lanes
// empty): 9 lanes, one per well.
export function countLanes(img, w, h, pitchHint = null) {
  const s = gaussian1d(columnContent(img, w, h), 2);
  const cs = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) cs[x + 1] = cs[x] + s[x];
  const mean = (a, b) => {
    a = Math.max(0, Math.round(a)); b = Math.min(w, Math.round(b));
    return b > a ? (cs[b] - cs[a]) / (b - a) : NaN;
  };
  let best = { score: -Infinity, p: w, x0: 0 };
  // with the wells' spacing (findWells), lane widths within 12% of it only
  const pLo = pitchHint ? Math.max(4, 0.88 * pitchHint) : Math.max(8, w / 40), pHi = pitchHint ? 1.12 * pitchHint : w / 2;
  for (let p = pLo; p <= pHi; p *= 1.01) {
    const dx = Math.max(1, p / 40);
    for (let x0 = 0; x0 < p; x0 += dx) { // x0: one divider
      let score = 0;
      for (let k = Math.floor(-x0 / p); ; k++) {
        const c = x0 + (k + 0.5) * p;
        if (c >= w) break;
        if (c < 0) continue;
        const L = mean(c - 0.2 * p, c + 0.2 * p);
        const ds = [c - p / 2, c + p / 2].filter((b) => b >= 0 && b < w)
          .map((b) => mean(b - 0.05 * p, b + 0.05 * p)).filter((v) => !Number.isNaN(v));
        if (Number.isNaN(L) || !ds.length) continue;
        score += L - Math.max(...ds);
      }
      if (score > best.score) best = { score, p, x0 };
    }
  }
  const { p, x0 } = best;
  const div = [];
  for (let b = x0 % p; b < w; b += p) if (b > 0) div.push(b);
  let bounds = [0, ...div.map((b) => {                              // onto the palest column nearby
    let at = Math.round(b);
    for (let x = Math.max(1, Math.round(b - 0.15 * p)); x <= Math.min(w - 1, Math.round(b + 0.15 * p)); x++) if (s[x] < s[at]) at = x;
    return at;
  }), w];
  const sorted = Float64Array.from(s).sort();
  const lo = sorted[Math.floor(0.05 * (w - 1))], hi = sorted[Math.floor(0.95 * (w - 1))];
  const empty = (a, b) => !(mean(a + 0.3 * (b - a), b - 0.3 * (b - a)) > lo + 0.04 * (hi - lo));
  let first = 0, last = bounds.length - 2; // lanes: spaces first..last; the rest is dead space
  // empty lanes at the edges are margin, unless the wells say they're unloaded wells (lanes,
  // which DNA mode marks empty)
  while (!pitchHint && first < last && empty(bounds[first], bounds[first + 1])) first++;
  while (!pitchHint && last > first && empty(bounds[last], bounds[last + 1])) last--;
  if (last - first >= 2 && first === 0 && bounds[1] < p / 2) { bounds.splice(1, 1); last--; } // thin edge lane
  if (last - first >= 2 && last === bounds.length - 2 && w - bounds[last] < p / 2) { bounds.splice(last, 1); last--; }
  const dead = [];
  for (let i = 0; i < bounds.length - 1; i++) if (i < first || i > last) dead.push(i);
  // fill: each space's middle 40% on the same scale (0 = the 5th percentile column, 1 =
  // the 95th). On Nicole's agarose gels empty wells are at most 0.04, loaded lanes (one
  // band) at least 0.12, a faint smear on nicole_3 0.06; DNA mode calls a lane under
  // EMPTY_FILL empty (click above it to change).
  const fill = bounds.slice(0, -1).map((a, i) => (mean(a + 0.3 * (bounds[i + 1] - a), bounds[i + 1] - 0.3 * (bounds[i + 1] - a)) - lo) / (hi - lo || 1));
  return { n: last - first + 1, pitch: p, gaps: bounds.slice(first + 1, last + 1), bounds, dead, fill };
}
export const EMPTY_FILL = 0.05;

// Lane boundaries for n lanes across an image, chosen together like the teeth of a comb:
// the n-1 dividers sit on the palest columns (least band content: gaps between lanes) they can, while every
// inner lane stays 0.8-1.2x the average lane width and the outer two 0.3-1.6x (ladders
// are often narrower, and there may be margin at the edges). Comb teeth are evenly
// spaced, and a faint lane can be as pale as a gap, so the inner limits are tight
// (on gel_02 every inner lane is 0.9-1.03x). Dynamic programming over columns finds
// the best set. Returns n+1 boundaries from 0 to w.
export function findLanes(img, w, h, n) {
  if (n < 2) return [0, w];
  const pitch = w / n;
  const s = gaussian1d(columnContent(img, w, h), Math.max(2, pitch / 20));
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

// The gel slab in a gel doc photo (a DNA gel glowing on black): rows and columns whose
// median brightness is over halfway from the 5th to the 95th percentile of those
// medians, trimmed by 1.5% to drop the slab's bright rim. grey: 0 black - 1 white.
// Returns {x0, y0, x1, y1} (inclusive). As scoping/gel_slab.py; cropped to the slab,
// countLanes gets Nicole's agarose gels right, where the whole photo misled it.
export function gelSlab(grey, w, h) {
  const range = (prof) => {
    const sorted = [...prof].sort((a, b) => a - b);
    const lo = sorted[Math.floor(0.05 * (sorted.length - 1))], hi = sorted[Math.floor(0.95 * (sorted.length - 1))];
    let a = -1, b = -1;
    prof.forEach((v, i) => { if (v > lo + 0.5 * (hi - lo)) { if (a < 0) a = i; b = i; } });
    if (a < 0) return [0, prof.length - 1];
    const trim = Math.round(0.015 * (b - a + 1));
    return [a + trim, b - trim];
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 400)); // sample for speed
  const rows = [], cols = [];
  for (let y = 0; y < h; y++) {
    const v = [];
    for (let x = 0; x < w; x += step) { const q = grey[y * w + x]; if (!Number.isNaN(q)) v.push(q); }
    rows.push(v.length ? median(v) : 0);
  }
  for (let x = 0; x < w; x++) {
    const v = [];
    for (let y = 0; y < h; y += step) { const q = grey[y * w + x]; if (!Number.isNaN(q)) v.push(q); }
    cols.push(v.length ? median(v) : 0);
  }
  const [y0, y1] = range(rows), [x0, x1] = range(cols);
  // only a slab on a black surround: at least 60% of the photo each way (a dim photo whose
  // gel fills the frame otherwise gives just the strip of bright bands) and 1.3 x brighter
  // than what's outside it (the lab's slabs: 1.46 x on the dimmest, nicole_1, 8-270 x on
  // the rest; gels filling the frame: at most 2 x, and those also fail on size but one at 1.16 x)
  const whole = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  if (y1 - y0 + 1 < 0.6 * h || x1 - x0 + 1 < 0.6 * w) return whole;
  const inner = [], outer = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const q = grey[y * w + x];
    if (Number.isNaN(q)) continue;
    (y >= y0 && y <= y1 && x >= x0 && x <= x1 ? inner : outer).push(q);
  }
  if (outer.length && median(inner) < 1.3 * Math.max(median(outer), 1e-3)) return whole;
  return { x0, y0, x1, y1 };
}

// A gel photographed on a plain tray, light box or bench (lighter or darker than the gel),
// as scoping/gel_slab.py gel_box. On a copy block-averaged to ~400 px on the short side and
// smoothed (sigma 4): the background is a gentle slope, a plane fitted to the outer 3%
// (refitted without outliers); the gel is what differs from it by more than half the gel's
// own level (the 70th percentile of what's clearly different, towards the background, so
// bands don't pull it away and a pale gel still counts). Columns at least 35% gel (of the
// most), then rows at least 35% gel within them, bridging gaps up to 15% (a dark ladder or
// smear); the box must be at least 70% gel (a trimmed scan's bands are scattered: 0.52 on
// gel_02; gels on a tray 0.72-0.99), at least 15% of the image either way, and the gel at
// least 0.06 from the background. A side whose outer strip is half gel or more isn't
// cropped; others get a 1.5% margin, 6% at the top (a pale stacking gel near the wells can
// read as tray). Nothing found: the whole image. Returns {x0, y0, x1, y1} (inclusive).
export function gelBox(grey, w, h) {
  const EDGE = 0.03, MIN_STEP = 0.06, MARGIN = 0.015, TOP_MARGIN = 0.06, MIN_SIZE = 0.15, BRIDGE = 0.15;
  const BLUR = 4, KEEP = 0.35, EDGE_GEL = 0.5, SOLID = 0.7;
  const whole = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const f = Math.max(1, Math.floor(Math.min(h, w) / 400));
  const hs = Math.floor(h / f), ws = Math.floor(w / f);
  let small = new Float64Array(hs * ws);
  for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++) {
    let t = 0, n = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const v = grey[(y * f + dy) * w + x * f + dx];
      if (!Number.isNaN(v)) { t += v; n++; }
    }
    small[y * ws + x] = n ? t / n : 1;
  }
  // separable gaussian blur
  for (let y = 0; y < hs; y++) small.set(gaussian1d(small.subarray(y * ws, (y + 1) * ws), BLUR), y * ws);
  const col = new Float64Array(hs);
  for (let x = 0; x < ws; x++) {
    for (let y = 0; y < hs; y++) col[y] = small[y * ws + x];
    const b = gaussian1d(col, BLUR);
    for (let y = 0; y < hs; y++) small[y * ws + x] = b[y];
  }
  const blur = small;
  const k = Math.max(2, Math.floor(EDGE * Math.min(hs, ws)));
  const ringIdx = [];
  for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++)
    if (y < k || y >= hs - k || x < k || x >= ws - k) ringIdx.push(y * ws + x);
  // plane a + b x/ws + c y/hs, least squares (normal equations), refitted without outliers
  let coef = [median(ringIdx.map((i) => blur[i])), 0, 0], sd = 0.004, use = ringIdx;
  for (let it = 0; it < 3; it++) {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (const i of use) {
      const r = [1, (i % ws) / ws, Math.floor(i / ws) / hs];
      for (let a = 0; a < 3; a++) { v[a] += r[a] * blur[i]; for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; }
    }
    const sol = solve3(M, v);
    if (sol) coef = sol;
    const res = ringIdx.map((i) => blur[i] - (coef[0] + coef[1] * (i % ws) / ws + coef[2] * Math.floor(i / ws) / hs));
    const used = res.filter((_, j) => use.includes(ringIdx[j]));
    const m = median(used);
    sd = Math.max(0.004, 1.4826 * median(used.map((r) => Math.abs(r - m))));
    use = ringIdx.filter((_, j) => Math.abs(res[j]) < 3 * sd);
    if (use.length < 10) break;
  }
  const diff = new Float64Array(hs * ws);
  for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++)
    diff[y * ws + x] = blur[y * ws + x] - (coef[0] + coef[1] * x / ws + coef[2] * y / hs);
  const off = Math.max(0.02, 4 * sd);
  const darker = [], lighter = [];
  for (const d of diff) { if (d < -off) darker.push(d); else if (d > off) lighter.push(d); }
  const sign = darker.length >= lighter.length ? -1 : 1;
  const other = (sign < 0 ? darker : lighter).sort((a, b) => a - b);
  if (other.length < 0.05 * diff.length) return whole;
  const pct = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
  const level = pct(other, sign < 0 ? 0.7 : 0.3);
  if (Math.abs(level) < MIN_STEP) return whole;
  const gel = new Uint8Array(hs * ws);
  let nGel = 0;
  for (let i = 0; i < diff.length; i++) if (diff[i] * sign > Math.abs(level) / 2) { gel[i] = 1; nGel++; }
  if (!nGel || nGel === gel.length) return whole;
  // the longest run of indices with frac >= keep, bridging gaps up to gap: [a, b) or null
  const run = (frac, keep, gap) => {
    let best = null, start = -1, prev = -1;
    frac.forEach((v, i) => {
      if (v < keep) return;
      if (start >= 0 && i - prev <= gap) { prev = i; return; }
      if (start >= 0 && (!best || prev + 1 - start > best[1] - best[0])) best = [start, prev + 1];
      start = prev = i;
    });
    if (start >= 0 && (!best || prev + 1 - start > best[1] - best[0])) best = [start, prev + 1];
    return best;
  };
  const colFrac = new Float64Array(ws);
  for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++) colFrac[x] += gel[y * ws + x] / hs;
  const cols = run(colFrac, KEEP * Math.max(...colFrac), Math.max(2, Math.floor(BRIDGE * ws)));
  if (!cols) return whole;
  const rowFrac = new Float64Array(hs);
  for (let y = 0; y < hs; y++) { let t = 0; for (let x = cols[0]; x < cols[1]; x++) t += gel[y * ws + x]; rowFrac[y] = t / (cols[1] - cols[0]); }
  const rows = run(rowFrac, KEEP, Math.max(2, Math.floor(BRIDGE * hs)));
  if (!rows) return whole;
  let [y0, y1] = rows, [x0, x1] = cols;
  if (y1 - y0 < MIN_SIZE * hs || x1 - x0 < MIN_SIZE * ws) return whole;
  let inBox = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inBox += gel[y * ws + x];
  if (inBox / ((y1 - y0) * (x1 - x0)) < SOLID) return whole;
  // each side: cropped only if the photo's edge there is background, not gel
  const strip = (ya, yb, xa, xb) => { let t = 0; for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) t += gel[y * ws + x]; return t / ((yb - ya) * (xb - xa)); };
  const top = strip(0, k, 0, ws) < EDGE_GEL, bottom = strip(hs - k, hs, 0, ws) < EDGE_GEL;
  const left = strip(0, hs, 0, k) < EDGE_GEL, right = strip(0, hs, ws - k, ws) < EDGE_GEL;
  const my = Math.round(MARGIN * (y1 - y0)), mt = Math.round(TOP_MARGIN * (y1 - y0)), mx = Math.round(MARGIN * (x1 - x0));
  y0 = top ? Math.max(0, y0 - mt) : 0; y1 = bottom ? Math.min(hs, y1 + my) : hs;
  x0 = left ? Math.max(0, x0 - mx) : 0; x1 = right ? Math.min(ws, x1 + mx) : ws;
  return { x0: x0 * f, y0: y0 * f, x1: (x1 < ws ? x1 * f : w) - 1, y1: (y1 < hs ? y1 * f : h) - 1 };
}

// 3x3 linear system (Cramer's rule); null if singular
function solve3(M, v) {
  const det = (A) => A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
    + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map((c) => det(M.map((row, r) => row.map((x, j) => (j === c ? v[r] : x)))) / d);
}

// Wells: the comb's slots along the top of a gel, loaded or not, which give the lane
// spacing where the bands can't (a DNA gel with a few wells loaded looks, from its bands,
// like one with lanes two or three times as wide). As scoping/wells.py find_wells. img:
// the analysed area, dark bands on light. In the top 35% of rows, each band of rows (2% of
// the height, in steps of half that) is averaged, smoothed (sigma 1.5) and its running
// median over 1/8 of the width taken off; the teeth of gel between wells (dips) or the
// wells (peaks), whichever is regular, are the peaks standing out by 3 x the profile's
// spread (at least 0.003: a dark 8-bit photo is quantised), at least w/80 apart. A row is at
// least 6 regularly spaced (gaps within 20% of their median, the odd double gap allowed);
// the band with the most wins. Returns {pitch, row, n} or null. The lane finder uses a row
// of at least 8 (USE_WELLS): on the lab's gels, 11h30's spacing came out 74-77 px against
// 78 by eye, Nicole's 51-53 against 52.
export const USE_WELLS = 8;
export function findWells(img, w, h) {
  const TOP = 0.35, BAND = 0.02, PROM = 3, NOISE_FLOOR = 0.003, MIN_WELLS = 6, REGULAR = 0.2;
  const band = Math.max(3, Math.floor(BAND * h)), win = Math.max(9, Math.floor(w / 8)) | 1, dist = Math.max(3, Math.floor(w / 80));
  const regular = (xs) => {
    if (xs.length < MIN_WELLS) return null;
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    let med = median(gaps);
    for (let it = 0; it < 2; it++) {
      const one = gaps.filter((g) => Math.abs(g - med) <= REGULAR * med);
      if (one.length < MIN_WELLS - 1) return null;
      med = median(one);
    }
    const ok = gaps.filter((g) => Math.abs(g - med) <= REGULAR * med).length;
    const okOrDouble = gaps.filter((g) => Math.abs(g - med) <= REGULAR * med || Math.abs(g - 2 * med) <= REGULAR * 2 * med).length;
    return okOrDouble >= 0.85 * gaps.length && ok >= 0.6 * gaps.length ? med : null;
  };
  // peaks with prominence >= minProm, then thinned to at least dist apart, tallest first (scipy)
  const peaks = (x, minProm) => {
    const found = findPeaks(x, minProm).sort((a, b) => x[b.i] - x[a.i]);
    const kept = [];
    for (const p of found) if (!kept.some((q) => Math.abs(q - p.i) < dist)) kept.push(p.i);
    return kept.sort((a, b) => a - b);
  };
  let best = null;
  for (let y = 0; y + band < TOP * h; y += Math.max(1, band >> 1)) {
    const prof = new Float64Array(w);
    for (let r = y; r < y + band; r++) for (let x = 0; x < w; x++) { const v = img[r * w + x]; prof[x] += (Number.isNaN(v) ? 1 : v) / band; }
    const sm = gaussian1d(prof, 1.5);
    const hp = new Float64Array(w), buf = [];
    for (let x = 0; x < w; x++) {
      buf.length = 0;
      for (let j = x - (win >> 1); j <= x + (win >> 1); j++) buf.push(sm[Math.min(w - 1, Math.max(0, j))]);
      hp[x] = sm[x] - median(buf);
    }
    const m = median(hp);
    const sd = Math.max(NOISE_FLOOR, 1.4826 * median(Array.from(hp, (v) => Math.abs(v - m))));
    for (const sign of [-1, 1]) {
      const xs = peaks(hp.map((v) => sign * v), PROM * sd);
      const pitch = regular(xs);
      if (pitch !== null && (!best || xs.length > best.n)) best = { pitch, row: y + (band >> 1), n: xs.length };
    }
  }
  return best;
}
