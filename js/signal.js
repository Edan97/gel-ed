// 1-D signal tools, ported from the scipy functions the Python band finder uses, with the
// same definitions so the browser and Python find the same bands:
//   gaussian1d      scipy.ndimage.gaussian_filter1d (mode "reflect", truncate 4)
//   minFilter1d     scipy.ndimage.minimum_filter1d  (mode "reflect")
//   findPeaks       scipy.signal.find_peaks with prominence and width
//   median, mad     numpy.median and the scaled median absolute deviation

// scipy "reflect": (d c b a | a b c d | d c b a)
function reflect(i, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  i = ((i % period) + period) % period;
  return i < n ? i : period - i - 1;
}

function gaussianKernel(sigma, order) {
  const radius = Math.floor(4 * sigma + 0.5);
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let x = -radius; x <= radius; x++) {
    k[x + radius] = Math.exp((-0.5 / (sigma * sigma)) * x * x);
    sum += k[x + radius];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  if (order === 1) {
    // d/dx of the Gaussian: phi(x) * (-x / sigma^2)
    for (let x = -radius; x <= radius; x++) k[x + radius] *= -x / (sigma * sigma);
  } else if (order === 2) {
    // d2/dx2 of the Gaussian: phi(x) * (x^2/sigma^4 - 1/sigma^2)
    const s2 = sigma * sigma;
    for (let x = -radius; x <= radius; x++) k[x + radius] *= x * x / (s2 * s2) - 1 / s2;
  } else if (order !== 0) {
    throw new Error("gaussian1d: only orders 0, 1 and 2 are implemented");
  }
  return { k, radius };
}

export function gaussian1d(a, sigma, order = 0) {
  const { k, radius } = gaussianKernel(sigma, order);
  const n = a.length;
  const out = new Float64Array(n);
  // scipy correlates with the reversed kernel (matters for order 1, which is odd)
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -radius; j <= radius; j++) s += k[radius - j] * a[reflect(i + j, n)];
    out[i] = s;
  }
  return out;
}

export function minFilter1d(a, size) {
  const n = a.length;
  const half = Math.floor(size / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = i - half; j <= i - half + size - 1; j++) m = Math.min(m, a[reflect(j, n)]);
    out[i] = m;
  }
  return out;
}

export function median(a) {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// robust standard deviation: 1.4826 x median absolute deviation
export function mad(a) {
  const m = median(a);
  return 1.4826 * median(Array.from(a, (v) => Math.abs(v - m)));
}

// scipy.signal._peak_finding_utils._local_maxima_1d: flat tops give their middle sample
function localMaxima(x) {
  const peaks = [];
  const n = x.length;
  let i = 1;
  while (i < n - 1) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < n - 1 && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push(Math.floor((i + ahead - 1) / 2));
        i = ahead;
      }
    }
    i++;
  }
  return peaks;
}

function prominence(x, p) {
  let leftMin = x[p], leftBase = p;
  for (let i = p; i >= 0 && x[i] <= x[p]; i--) if (x[i] < leftMin) { leftMin = x[i]; leftBase = i; }
  let rightMin = x[p], rightBase = p;
  for (let i = p; i < x.length && x[i] <= x[p]; i++) if (x[i] < rightMin) { rightMin = x[i]; rightBase = i; }
  return { prom: x[p] - Math.max(leftMin, rightMin), leftBase, rightBase };
}

// width at half prominence, interpolated (scipy peak_widths, rel_height 0.5)
function width(x, p, { prom, leftBase, rightBase }) {
  const h = x[p] - prom * 0.5;
  let i = p;
  while (leftBase < i && h < x[i]) i--;
  let left = i;
  if (x[i] < h) left += (h - x[i]) / (x[i + 1] - x[i]);
  i = p;
  while (i < rightBase && h < x[i]) i++;
  let right = i;
  if (x[i] < h) right -= (h - x[i]) / (x[i - 1] - x[i]);
  return right - left;
}

// find_peaks(x, prominence=minProm, width=minWidth): [{i, prom, width}]
export function findPeaks(x, minProm, minWidth = null) {
  const out = [];
  for (const p of localMaxima(x)) {
    const pr = prominence(x, p);
    if (pr.prom < minProm) continue;
    const w = width(x, p, pr);
    if (minWidth !== null && w < minWidth) continue;
    out.push({ i: p, prom: pr.prom, width: w });
  }
  return out;
}

// Python's round(): halves go to the even neighbour
export function roundHalfEven(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
