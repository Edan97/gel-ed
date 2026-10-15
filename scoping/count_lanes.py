"""Count lanes and place them: the method the web page uses (countLanes in js/bands.js).

1. Band content per column: darkness above the column's own background, averaged down
   the column. The background is a running median down the column over about 1/8 of
   the height, taken every quarter window and interpolated. The gel's uneven background
   cancels, so a lane with bands stands out from an empty one (plain mean darkness
   doesn't: on a gel with most lanes empty it is mostly background).
2. An evenly spaced comb is fitted to that profile: for each lane width p and offset,
   the score is the sum over lanes of (content across the lane's middle 40%) minus
   (content at its darker divider, +-5% of p). Empty lanes score about nothing, so a gel
   with only a few loaded lanes still gets the right width. The darker divider, not the
   mean of the two: with flat-topped lanes (a well straightened gel) the mean ties half
   the lane width with the true one, as each half-lane's dividers average a gap and the
   lane's own middle; against the darker one a divider on a band cancels the lane.
3. Each divider moves to the palest column within +-15% of p; empty lanes at the edges
   are margin; a remaining edge piece narrower than half a lane joins its neighbour.

Usage:
    python scoping/count_lanes.py IMAGE [--lanes LANES.csv] [--out OUT.csv]

With --lanes, compares the dividers with the hand-placed gaps (midway between
neighbouring lanes in the CSV).
"""

import argparse
import csv
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402
from lanes import read_lanes  # noqa: E402


def column_content(grey):
    """grey: 2-D, 0 = black, 1 = white."""
    h, w = grey.shape
    dark = 1 - grey
    win = max(15, h // 8) | 1
    half, step = win // 2, max(1, win // 4)
    ys = list(range(0, h, step))
    if ys[-1] != h - 1:
        ys.append(h - 1)
    meds = np.array([np.median(dark[max(0, y - half):min(h, y + half + 1)], axis=0) for y in ys])
    rows = np.arange(h)
    bg = np.stack([np.interp(rows, ys, meds[:, x]) for x in range(w)], axis=1)
    return np.clip(dark - bg, 0, None).mean(axis=0)


def count_lanes(grey):
    """Returns (pitch, bounds): bounds from the first lane's left edge to the last's right."""
    s = gaussian_filter1d(column_content(grey), 2)
    w = len(s)
    cs = np.concatenate([[0.0], np.cumsum(s)])

    def mean(a, b):
        a, b = max(0, int(np.floor(a + 0.5))), min(w, int(np.floor(b + 0.5)))  # JS Math.round
        return (cs[b] - cs[a]) / (b - a) if b > a else np.nan

    best = (-np.inf, float(w), 0.0)
    p = max(8.0, w / 40)
    while p <= w / 2:
        dx = max(1.0, p / 40)
        x0 = 0.0
        while x0 < p:
            score = 0.0
            k = int(np.floor(-x0 / p))
            while True:
                c = x0 + (k + 0.5) * p
                k += 1
                if c >= w:
                    break
                if c < 0:
                    continue
                L = mean(c - 0.2 * p, c + 0.2 * p)
                ds = [mean(b - 0.05 * p, b + 0.05 * p) for b in (c - p / 2, c + p / 2) if 0 <= b < w]
                ds = [v for v in ds if not np.isnan(v)]
                if np.isnan(L) or not ds:
                    continue
                score += L - max(ds)
            if score > best[0]:
                best = (score, p, x0)
            x0 += dx
        p *= 1.01
    _, p, x0 = best

    divs = []
    b = x0 % p
    while b < w:
        if b > 0:
            divs.append(b)
        b += p
    bounds = [0]
    for b in divs:
        at = int(np.floor(b + 0.5))
        for x in range(max(1, int(np.floor(b - 0.15 * p + 0.5))), min(w - 1, int(np.floor(b + 0.15 * p + 0.5))) + 1):
            if s[x] < s[at]:
                at = x
        bounds.append(at)
    bounds.append(w)
    srt = np.sort(s)
    lo, hi = srt[int(0.05 * (w - 1))], srt[int(0.95 * (w - 1))]

    def empty(a, b):
        return not mean(a + 0.3 * (b - a), b - 0.3 * (b - a)) > lo + 0.1 * (hi - lo)

    while len(bounds) > 2 and empty(bounds[0], bounds[1]):
        bounds.pop(0)
    while len(bounds) > 2 and empty(bounds[-2], bounds[-1]):
        bounds.pop()
    if len(bounds) > 3 and bounds[0] == 0 and bounds[1] < p / 2:
        bounds.pop(1)
    if len(bounds) > 3 and bounds[-1] == w and w - bounds[-2] < p / 2:
        bounds.pop(-2)
    return p, bounds


def hand_gaps(lanes_csv):
    lanes = sorted(read_lanes(lanes_csv), key=lambda l: l[1])
    return [(a[2] + b[1]) / 2 for a, b in zip(lanes, lanes[1:])]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--lanes", help="hand-placed lane CSV to compare with")
    ap.add_argument("--out", help="CSV of lane bounds")
    a = ap.parse_args()
    grey = load(a.image).astype(float) / 65535
    pitch, bounds = count_lanes(grey)
    print(f"{len(bounds) - 1} lanes, lane width {pitch:.1f} px, bounds {bounds}")
    worst = None
    if a.lanes:
        truth = hand_gaps(a.lanes)
        if len(truth) == len(bounds) - 2:
            worst = max(abs(g - t) for g, t in zip(bounds[1:-1], truth))
            print(f"worst divider vs hand-placed gaps: {worst:.1f} px")
        else:
            print(f"{len(truth) + 1} hand-placed lanes: counts differ")
    if a.out:
        with open(a.out, "w", newline="") as f:
            wr = csv.writer(f)
            wr.writerow(["lane_no", "start", "end", "pitch", "worst_divider_px"])
            for i in range(len(bounds) - 1):
                wr.writerow([i + 1, bounds[i], bounds[i + 1], f"{pitch:.2f}", "" if worst is None else f"{worst:.1f}"])


if __name__ == "__main__":
    main()
