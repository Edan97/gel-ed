"""Pick a ladder's bands automatically, as the web page does (js/calibrate.js
pickLadderBands, js/app.js assignLadders). Python twin for run_all's checks.

1. Lanes: count_lanes (as the page on load).
2. Bands in the ladder lane: band_peaks.find_bands. If it finds fewer bands than the
   ladder has sizes, the lane is read again with its noise capped at the gel's median
   lane noise: a ladder is bands from top to bottom, so its own wobble is mostly bands
   and its noise estimate comes out too high (gel_04: 0.065 against 0.006 for the
   other lanes; 7 of 15 bands found).
3. Solidity of each band (share of the band's span across the lane that is actually
   dark; a smudge with a bright spot scores low).
4. Picking: bands less solid than 0.85 go (shoulders stay, at a cost); rows where at
   least 80% of lanes have a peak in the top quarter (wells, the stacking line) go. Then
   spacing_fit assigns each size a band or none: log10(size) changes smoothly down a
   ladder, so for every three consecutive picks the slopes between the first two and
   the last two should be alike (cost: ln of their ratio, squared), plus, for each band
   left out, its strength relative to the median candidate (at most 2), MISS for each
   size with no band, SHOULDER for each shoulder picked and, with ng per band, a light
   brightness-against-mass term. Dynamic programming considers every choice. Leaving
   sizes out keeps a well or smudge above a DNA ladder from pushing every size down one
   (nicole_1, nicole_2).

5. Which lane (--lane auto; the page does this until the user chooses a lane): the lane
   whose picks fit the sizes best: mean over consecutive picks of (ln slope ratio)^2,
   plus 2 x the share of sizes with no solid band, plus 2 x the share given no band (a sample lane with a few evenly
   spaced bands can fit well too; a ladder has a band for most sizes).

Usage:
    python scoping/ladder_pick.py IMAGE --lane 8|auto --kda 220 160 120 ... [--out FILE.csv]
"""

import argparse
import csv
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from band_peaks import find_bands  # noqa: E402
from count_lanes import count_lanes  # noqa: E402
from gel_ed.load import load  # noqa: E402


def solidity(img, start, end, y, background):
    """As js/calibrate.js bandSolidity: rows y-2..y+2 across the lane, background removed."""
    reg = 1 - img[max(0, y - 2):y + 3, start:end]
    col = reg.mean(axis=0) - background
    sm = ndimage.gaussian_filter1d(col, 2, mode="reflect")
    fine = ndimage.gaussian_filter1d(col, 1, mode="reflect")
    peak = sm.max()
    if not peak > 0:
        return 0.0
    span = np.where(sm >= peak / 2)[0]
    return float((fine[span[0]:span[-1] + 1] >= peak / 2).mean())


MISS = 3.0        # cost of a ladder size with no band (more than leaving out the strongest band, 2)
SHOULDER = 2.0    # cost of picking a shoulder rather than a peak (as leaving out a strong band)
GAP = 6           # at most GAP - 1 sizes missing between two picked bands (a tight crop can lose
                  # all four faint bands between the 1 kb Plus's 1.0 and 0.5 kb)
MASS_WEIGHT = 0.1  # weight of (ln brightness mismatch)^2 when the ladder gives masses (a tie-break)


def pick_ladder_bands(bands, solid, sizes, mass=None):
    """For each size (largest first), the index into bands of its band, or None."""
    n = len(sizes)
    ranked = sorted(range(len(bands)), key=lambda i: (-solid[i], -bands[i]["snr"]))
    keep = sorted((i for i in ranked if solid[i] >= 0.85), key=lambda i: bands[i]["y"])
    if len(keep) < 3 or n < 3:  # too little to fit spacing: the most solid, top to bottom
        top = sorted(ranked[:n], key=lambda i: bands[i]["y"])
        return top + [None] * (n - len(top))
    fit = spacing_fit([bands[i] for i in keep], sizes, mass)
    return [None if k is None else keep[k] for k in fit]


def strength(b):
    """A band's brightness for comparing with ladder masses: height x width."""
    w = b.get("fwhm")
    return max(b["height"], 1e-9) * (w if w and np.isfinite(w) else 4.0)


def spacing_fit(c, sizes, mass=None):
    """Assign sizes to candidates c (top to bottom), each size to a band or to none.
    Down a ladder log10(size) changes smoothly with row: for three consecutive picks the
    slopes between the first two and the last two should be alike, cost (ln of their
    ratio)^2. Each candidate left out costs its strength relative to the median candidate
    (at most 2), each size with no band MISS. With masses (ng per band, e.g. a DNA
    ladder's brighter reference bands), each pick also costs MASS_WEIGHT x (ln of its
    brightness relative to the rest, minus ln of its mass relative to the rest)^2. Kept
    light, a tie-break: on Nicole's 1 kb Plus gels large bands come out several times
    fainter than their mass, and a heavier weight drops them; at 0.1 it puts the 6 kb
    band (48 ng, brighter than its neighbours) on the right row on nicole_2. A shoulder
    can be picked (the 0.9, 0.8 and 0.6 kb bands sit on the flanks of the 1.0 and 0.5 kb
    ones on nicole_1) at a cost of SHOULDER.
    Dynamic programming over (size, band, size and band picked before it)."""
    m, n = len(c), len(sizes)
    lk = np.log10(sizes)
    y = np.array([b["y"] for b in c], float)
    mid = np.median([b["snr"] for b in c]) or 1
    cum = np.concatenate([[0.0], np.cumsum([min(b["snr"] / mid, 2) for b in c])])
    skip = lambda a, b: cum[b] - cum[a] if b > a else 0.0  # noqa: E731
    # a shoulder (a band on the flank of a bigger one) can be picked, at a cost
    mc = np.tile([SHOULDER if b["kind"] == "shoulder" else 0.0 for b in c], (n, 1))
    if mass is not None and MASS_WEIGHT:
        la = np.log([strength(b) for b in c])
        lm = np.log(np.asarray(mass, float))
        top = np.sort(la)[::-1][:n]  # the strongest candidates stand for the ladder
        off = np.median(top) - np.median(lm)
        mc = mc + MASS_WEIGHT * (la[None, :] - lm[:, None] - off) ** 2
    INF = np.inf
    # C[i, j, g, p]: size i on candidate j, previous pick size i-g on candidate p
    C = np.full((n, m, GAP + 1, m), INF)
    for i in range(n):
        for g in range(1, GAP + 1):
            ip = i - g
            if ip < 0:
                break
            for j in range(m):
                for p in range(j):
                    first = MISS * ip + skip(0, p) + mc[ip, p]
                    best = first
                    if ip > 0:
                        s2 = (lk[i] - lk[ip]) / (y[j] - y[p])
                        for g2 in range(1, GAP + 1):
                            iq = ip - g2
                            if iq < 0:
                                break
                            prev = C[ip, p, g2, :p]
                            ok = np.isfinite(prev)
                            if not ok.any():
                                continue
                            s1 = (lk[ip] - lk[iq]) / (y[p] - y[:p])
                            v = prev + np.log(s2 / s1) ** 2
                            best = min(best, float(np.min(v[ok])))
                    C[i, j, g, p] = best + skip(p + 1, j) + MISS * (g - 1) + mc[i, j]
    # best end, then trace back by recomputation
    best, end = INF, None
    for i in range(n):
        for j in range(m):
            for g in range(1, GAP + 1):
                for p in range(j):
                    v = C[i, j, g, p] + MISS * (n - 1 - i) + skip(j + 1, m)
                    if v < best:
                        best, end = v, (i, j, g, p)
    out = [None] * n
    if end is None:
        return out
    i, j, g, p = end
    while True:
        out[i] = j
        ip = i - g
        out[ip] = p
        target = C[i, j, g, p] - skip(p + 1, j) - MISS * (g - 1) - mc[i, j]
        if abs(target - (MISS * ip + skip(0, p) + mc[ip, p])) < 1e-9:
            break
        s2 = (lk[i] - lk[ip]) / (y[j] - y[p])
        found = None
        for g2 in range(1, GAP + 1):
            iq = ip - g2
            if iq < 0:
                break
            for q in range(p):
                if np.isfinite(C[ip, p, g2, q]):
                    v = C[ip, p, g2, q] + np.log(s2 / ((lk[ip] - lk[iq]) / (y[p] - y[q]))) ** 2
                    if abs(v - target) < 1e-9:
                        found = (g2, q)
                        break
            if found:
                break
        if not found:
            break
        i, j, g, p = ip, p, found[0], found[1]
    return out


def common_rows(found, h):
    """Rows in the top quarter where at least 80% of lanes (and 3) have a peak: wells,
    the stacking line, the gel's top edge, not bands. [(row, tolerance)]."""
    tol = max(4, round(0.01 * h))
    peaks = [[d["y"] for d in bands if d["kind"] == "peak"] for bands, _ in found]
    need = max(3, int(np.ceil(0.8 * len(found))))
    out = []
    for r in sorted({y for ys in peaks for y in ys if y < h / 4}):
        if sum(any(abs(y - r) <= tol for y in ys) for ys in peaks) >= need:
            out.append((r, tol))
    return out


def lane_picks(img, lanes, found, i, sizes, mass=None):
    """Picked bands [(row, kDa)] in lane i (0-based) and how many solid peaks it has."""
    s, e = lanes[i]
    bands, info = found[i]
    gel_noise = float(np.median([f[1]["noise"] for f in found]))
    if len(bands) < len(sizes) and info["noise"] > gel_noise:
        capped, _ = find_bands(img[:, s:e], noise_cap=gel_noise)
        if len(capped) > len(bands):
            bands = capped
    common = common_rows(found, img.shape[0])
    bands = [d for d in bands if not any(abs(d["y"] - r) <= tol for r, tol in common)]
    bg = np.median(1 - img[:, s:e], axis=0)
    solid = [solidity(img, s, e, d["y"], bg) for d in bands]
    picked = pick_ladder_bands(bands, solid, sizes, mass)
    n_solid = sum(1 for d, x in zip(bands, solid) if x >= 0.85 and d["kind"] == "peak")
    return [(bands[i]["y"], k) for i, k in zip(picked, sizes) if i is not None], n_solid


def lane_score(picks, n_solid, sizes):
    if len(picks) < 3:
        return np.inf
    lk = np.log10([k for _, k in picks])
    y = [r for r, _ in picks]
    c = [np.log(((lk[k] - lk[k - 1]) / (y[k] - y[k - 1])) / ((lk[k - 1] - lk[k - 2]) / (y[k - 1] - y[k - 2]))) ** 2
         for k in range(2, len(picks))]
    return float(np.mean(c)) + 2 * (1 - min(n_solid, len(sizes)) / len(sizes)) + 2 * (1 - len(picks) / len(sizes))


SECOND_SCORE = 1.0   # a second ladder's lane must score under this
SECOND_SHARE = 0.6   # and give a band for at least this share of the sizes the first ladder has
SECOND_RMS = 0.01    # whose rows match the first ladder's, after a straight-line fit (tilt,
                     # stretch), to within this share of the gel's height (RMS)


def second_ladder(img, lanes, found, first, picks, scores, sizes, mass=None):
    """A second ladder of the same kind (often at the other end of a gel), or None: the
    best-scoring other lane whose bands line up with the first ladder's. A sample lane
    full of bands can score like a ladder (a lysate: 23 of the lab's 39 protein gels had
    one under 1.0), but its bands don't fall where the ladder's do."""
    rows = {k: r for r, k in picks}
    for score, i in sorted((v, i) for i, v in enumerate(scores) if i + 1 != first and np.isfinite(v)):
        if score >= SECOND_SCORE:
            break
        cand, _ = lane_picks(img, lanes, found, i, sizes, mass)
        pairs = [(rows[k], r) for r, k in cand if k in rows]
        if len(pairs) < max(3, SECOND_SHARE * len(rows)):
            continue
        x, y = np.array(pairs, float).T
        b, a = np.polyfit(x, y, 1)
        rms = float(np.sqrt(np.mean((y - (a + b * x)) ** 2)))
        if 0.85 <= b <= 1.15 and rms <= SECOND_RMS * img.shape[0]:
            return i + 1, score, rms
    return None


def ladder(img, lane, sizes, mass=None, pitch_hint=None):
    """Lanes, the ladder lane (1-based; lane="auto" finds it), its picks [(row, kDa)] and
    every lane's score (auto only). pitch_hint: the wells' spacing, if known."""
    _, b = count_lanes(img, pitch_hint)
    lanes = [(int(b[i]), int(b[i + 1])) for i in range(len(b) - 1)]
    found = [find_bands(img[:, s:e]) for s, e in lanes]
    scores = []
    if lane == "auto":
        res = [lane_picks(img, lanes, found, i, sizes, mass) for i in range(len(lanes))]
        scores = [lane_score(p, n, sizes) for p, n in res]
        lane = int(np.argmin(scores)) + 1
    picks, _ = lane_picks(img, lanes, found, lane - 1, sizes, mass)
    return lanes, lane, picks, scores


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--lane", required=True, help="ladder lane, 1-based, as counted by count_lanes, or auto")
    ap.add_argument("--kda", type=float, nargs="+", required=True, help="ladder sizes, largest first")
    ap.add_argument("--out", help="CSV of row,kDa")
    a = ap.parse_args()
    img = load(a.image).astype(float) / 65535
    lanes, lane, picks, scores = ladder(img, a.lane if a.lane == "auto" else int(a.lane), sorted(a.kda, reverse=True))
    print(f"{len(lanes)} lanes; ladder lane {lane} columns {lanes[lane - 1]}"
          + (" (found automatically; scores " + " ".join(f"{k + 1}:{v:.2f}" for k, v in enumerate(scores)) + ")" if scores else ""))
    for row, k in picks:
        print(f"  row {row}: {k:g} kDa")
    if a.out:
        with open(a.out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["lane", "row", "kDa"])
            w.writerows([(lane, r, k) for r, k in picks])


if __name__ == "__main__":
    main()
