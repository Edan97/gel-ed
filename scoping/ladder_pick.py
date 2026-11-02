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
4. Picking: shoulders and bands less solid than 0.85 go, as long as at least as many
   remain as there are sizes (otherwise the most solid, ties to the stronger). If there
   are still more than sizes, the set whose spacing fits the sizes best: log10(kDa)
   changes smoothly down a ladder, so for every three consecutive picks the slopes
   between the first two and the last two should be alike (cost: ln of their ratio,
   squared), plus, for each band left out, its strength relative to the median
   candidate (at most 2). Dynamic programming considers every choice.

5. Which lane (--lane auto; the page does this until the user chooses a lane): the lane
   whose picks fit the sizes best: mean over consecutive picks of (ln slope ratio)^2,
   plus 2 x the share of sizes with no solid band (a sample lane with a few evenly
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


def pick_ladder_bands(bands, solid, sizes):
    """Indices into bands (top to bottom) of the ladder's bands, one per size (or fewer)."""
    n = len(sizes)
    ranked = sorted(range(len(bands)), key=lambda i: (-solid[i], -bands[i]["snr"]))
    # JS sorts with "solidity differs by more than 0.02, else stronger first"; ties are rare
    keep = sorted(i for i in ranked if solid[i] >= 0.85 and bands[i]["kind"] == "peak")
    if len(keep) < n:
        return sorted(ranked[:n], key=lambda i: bands[i]["y"])
    keep.sort(key=lambda i: bands[i]["y"])
    if n < 3 or len(keep) == n:
        return keep[:n]
    return [keep[k] for k in spacing_fit([bands[i] for i in keep], sizes)]


def spacing_fit(c, sizes):
    m, n = len(c), len(sizes)
    lk = np.log10(sizes)
    y = [b["y"] for b in c]
    mid = np.median([b["snr"] for b in c]) or 1
    cum = np.concatenate([[0.0], np.cumsum([min(b["snr"] / mid, 2) for b in c])])

    def skip(a, b):
        return cum[b] - cum[a]

    cost = np.full((m, m), np.inf)  # [j, p]: size i on candidate j, size i-1 on p
    for j in range(1, m):
        for p in range(j):
            cost[j, p] = skip(0, p) + skip(p + 1, j)
    back = []
    for i in range(2, n):
        nxt, frm = np.full((m, m), np.inf), np.full((m, m), -1)
        for j in range(i, m - (n - 1 - i)):
            for p in range(i - 1, j):
                s2 = (lk[i] - lk[i - 1]) / (y[j] - y[p])
                for q in range(i - 2, p):
                    if cost[p, q] == np.inf:
                        continue
                    s1 = (lk[i - 1] - lk[i - 2]) / (y[p] - y[q])
                    v = cost[p, q] + np.log(s2 / s1) ** 2 + skip(p + 1, j)
                    if v < nxt[j, p]:
                        nxt[j, p], frm[j, p] = v, q
        cost = nxt
        back.append(frm)
    best, bj, bp = np.inf, -1, -1
    for j in range(1, m):
        for p in range(j):
            v = cost[j, p] + skip(j + 1, m)
            if v < best:
                best, bj, bp = v, j, p
    out = [bj, bp]
    for i in range(n - 1, 1, -1):
        q = int(back[i - 2][bj, bp])
        out.append(q)
        bj, bp = bp, q
    return out[::-1]


def lane_picks(img, lanes, found, i, sizes):
    """Picked bands [(row, kDa)] in lane i (0-based) and how many solid peaks it has."""
    s, e = lanes[i]
    bands, info = found[i]
    gel_noise = float(np.median([f[1]["noise"] for f in found]))
    if len(bands) < len(sizes) and info["noise"] > gel_noise:
        capped, _ = find_bands(img[:, s:e], noise_cap=gel_noise)
        if len(capped) > len(bands):
            bands = capped
    bg = np.median(1 - img[:, s:e], axis=0)
    solid = [solidity(img, s, e, d["y"], bg) for d in bands]
    picked = pick_ladder_bands(bands, solid, sizes)
    n_solid = sum(1 for d, x in zip(bands, solid) if x >= 0.85 and d["kind"] == "peak")
    return [(bands[i]["y"], k) for i, k in zip(picked, sizes)], n_solid


def lane_score(picks, n_solid, sizes):
    if len(picks) < 3:
        return np.inf
    lk = np.log10([k for _, k in picks])
    y = [r for r, _ in picks]
    c = [np.log(((lk[k] - lk[k - 1]) / (y[k] - y[k - 1])) / ((lk[k - 1] - lk[k - 2]) / (y[k - 1] - y[k - 2]))) ** 2
         for k in range(2, len(picks))]
    return float(np.mean(c)) + 2 * (1 - min(n_solid, len(sizes)) / len(sizes))


def ladder(img, lane, sizes):
    """Lanes, the ladder lane (1-based; lane="auto" finds it), its picks [(row, kDa)] and
    every lane's score (auto only)."""
    _, b = count_lanes(img)
    lanes = [(int(b[i]), int(b[i + 1])) for i in range(len(b) - 1)]
    found = [find_bands(img[:, s:e]) for s, e in lanes]
    scores = []
    if lane == "auto":
        res = [lane_picks(img, lanes, found, i, sizes) for i in range(len(lanes))]
        scores = [lane_score(p, n, sizes) for p, n in res]
        lane = int(np.argmin(scores)) + 1
    picks, _ = lane_picks(img, lanes, found, lane - 1, sizes)
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
