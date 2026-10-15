"""Auto-straighten: measure how a gel is tilted and set the editor's geometry sliders.

Three things are measured on the band content of the gel (darkness above each column's
own background, as count_lanes.py):

    L0  lane lean at the middle of the gel: columns moved per row (dx/dy)
    L1  how the lean changes across the gel, per column (lanes fanning out: keystone)
    B   band slope: rows moved per column (dy/dx)

Two ways to measure the lean are compared:

  A  correlation (no lanes needed): the column profile of the top half of the gel is
     matched to the bottom half's; the sideways shift between them over the rows
     between their centres is the lean. Done in three overlapping column windows
     (left, middle, right) for L1.
  B  centre-lines (compare_lanes.py): lanes are found (count_lanes.py), a straight
     centre-line is fitted through each lane's clear band centroids, and the leans are
     fitted as L0 + L1 x across lanes (weighted by bands used).

Band slope (both): narrow neighbouring column strips' row profiles are matched; inside
a lane both see the same bands, so the vertical shift over the strip spacing is the
slope. Median over strip pairs that match well.

Sliders (the page's transform, ported here as matrix()/warp(); small-angle effects):
rotation r turns lanes and bands together (L - r, B + r); skew s moves L only; distort
d moves B only; perspective p removes L1. Rotation takes as much as it can, skew and
distort share the rest equally:  r = (L0 - B)/2,  s = d = -(L0 + B)/2,  p from L1.
Each estimate is applied, the image re-measured, and the correction repeated once.

Checks (a good estimator recovers exactly what was added, and leaves nothing behind):
gel_02 (labels whited out) as is and with known extra rotation, skew and perspective.

Usage:
    python scoping/auto_straighten.py IMAGE [--row-start 140]
"""

import argparse
import csv
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from count_lanes import count_lanes  # noqa: E402
from compare_lanes import fit_lane  # noqa: E402
from ladder_centreline import load  # noqa: E402
from PIL import Image  # noqa: E402

WINDOWS = [(103, 107.5), (107.5, 112), (70, 78), (61, 67), (49, 55)]

GEOM = ("rotation", "perspective", "skew", "distort")


# ---------- the page's transform (js/transform.js) ----------

def matrix(w, h, rotation=0.0, skew=0.0, distort=0.0, perspective=0.0, flip=False):
    cx, cy = (w - 1) / 2, (h - 1) / 2
    t = np.radians(rotation)
    p = perspective * 0.6 / max(h - 1, 1)
    steps = [
        [[1, 0, cx], [0, 1, cy], [0, 0, 1]],
        [[1, 0, 0], [0, 1, 0], [0, p, 1]],
        [[1, 0, 0], [distort, 1, 0], [0, 0, 1]],
        [[1, skew, 0], [0, 1, 0], [0, 0, 1]],
        [[np.cos(t), -np.sin(t), 0], [np.sin(t), np.cos(t), 0], [0, 0, 1]],
        [[-1 if flip else 1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [[1, 0, -cx], [0, 1, -cy], [0, 0, 1]],
    ]
    m = np.eye(3)
    for s in steps:
        m = m @ np.array(s, dtype=float)
    return m


def warp(img, m):
    """img: 2-D float. Returns the whole transformed image (NaN outside the original)."""
    h, w = img.shape
    corners = np.array([[0, 0, 1], [w - 1, 0, 1], [w - 1, h - 1, 1], [0, h - 1, 1]], float) @ m.T
    corners = corners[:, :2] / corners[:, 2:]
    x0, y0 = np.floor(corners.min(0) + 1e-9).astype(int)
    x1, y1 = np.ceil(corners.max(0) - 1e-9).astype(int)
    Y, X = np.mgrid[y0:y1 + 1, x0:x1 + 1].astype(float)
    inv = np.linalg.inv(m)
    z = inv[2, 0] * X + inv[2, 1] * Y + inv[2, 2]
    u = (inv[0, 0] * X + inv[0, 1] * Y + inv[0, 2]) / z
    v = (inv[1, 0] * X + inv[1, 1] * Y + inv[1, 2]) / z
    out = ndimage.map_coordinates(img, [np.clip(v, 0, h - 1), np.clip(u, 0, w - 1)], order=1)
    out[~((u >= -0.5) & (v >= -0.5) & (u <= w - 0.5) & (v <= h - 0.5))] = np.nan
    return out


# ---------- measuring ----------

def content(grey):
    """Band content per pixel: darkness above a running median down each column (about
    1/8 of the height), blank (NaN) pixels count as nothing."""
    dark = 1 - np.where(np.isnan(grey), 1.0, grey)
    h = dark.shape[0]
    win = max(15, h // 8) | 1
    bg = ndimage.median_filter(dark, size=(win, 1), mode="nearest")
    return np.clip(dark - bg, 0, None)


def best_shift(a, b, max_shift):
    """Shift (sub-pixel) that best lines b up with a: a[i] ~ b[i + shift]. Also the
    correlation at that shift."""
    a = a - a.mean()
    b = b - b.mean()
    n = len(a)
    shifts = np.arange(-max_shift, max_shift + 1)
    cc = []
    for s in shifts:
        lo, hi = max(0, -s), min(n, n - s)
        x, y = a[lo:hi], b[lo + s:hi + s]
        den = np.sqrt((x * x).sum() * (y * y).sum())
        cc.append((x * y).sum() / den if den > 0 else 0.0)
    cc = np.array(cc)
    k = int(np.argmax(cc))
    off = 0.0
    if 0 < k < len(cc) - 1:
        c0, c1, c2 = cc[k - 1], cc[k], cc[k + 1]
        den = c0 - 2 * c1 + c2
        off = 0.5 * (c0 - c2) / den if den != 0 else 0.0
    return shifts[k] + off, cc[k]


def band_slope(C):
    """Rows per column: matched row profiles of neighbouring narrow column strips."""
    h, w = C.shape
    sw = max(8, w // 40)
    slopes, weights = [], []
    for x in range(0, w - 2 * sw, sw // 2):
        a = ndimage.gaussian_filter1d(C[:, x:x + sw].mean(1), 1.5)
        b = ndimage.gaussian_filter1d(C[:, x + sw:x + 2 * sw].mean(1), 1.5)
        if a.std() == 0 or b.std() == 0:
            continue
        s, c = best_shift(a, b, max(3, int(0.15 * sw)))
        if c >= 0.8:
            slopes.append(s / sw)
            weights.append(a.std() * b.std())
    if not slopes:
        return 0.0
    order = np.argsort(slopes)
    cw = np.cumsum(np.array(weights)[order])
    return float(np.array(slopes)[order][np.searchsorted(cw, cw[-1] / 2)])  # weighted median


def lean_correlation(C):
    """(L0, L1): top half vs bottom half column profiles, in three column windows."""
    h, w = C.shape
    top = ndimage.gaussian_filter1d(C[: h // 2].mean(0), 2)
    bot = ndimage.gaussian_filter1d(C[h // 2:].mean(0), 2)
    dy = h / 2
    xs, leans, wts = [], [], []
    for lo, hi in ((0, w // 2), (w // 4, 3 * w // 4), (w // 2, w)):
        s, c = window_shift(top, bot, lo, hi, w)
        if c > 0.3:
            xs.append((lo + hi) / 2)
            leans.append(s / dy)
            wts.append(c)
    if not leans:
        return 0.0, 0.0
    if len(leans) < 3:
        return float(np.average(leans, weights=wts)), 0.0
    L1, L0c = np.polyfit(np.array(xs) - (w - 1) / 2, leans, 1, w=wts)
    return float(L0c), float(L1)


def window_shift(top, bot, lo, hi, w):
    """Shift of bot against top judged over columns lo..hi of top (bot read beyond the window)."""
    max_shift = max(3, w // 12)
    a = top[lo:hi] - top[lo:hi].mean()
    best = (0.0, -1.0, 0)
    cc = []
    for s in range(-max_shift, max_shift + 1):
        l2, h2 = max(lo, -s), min(hi, len(bot) - s)
        x = top[l2:h2] - top[l2:h2].mean()
        y = bot[l2 + s:h2 + s] - bot[l2 + s:h2 + s].mean()
        den = np.sqrt((x * x).sum() * (y * y).sum())
        cc.append((x * y).sum() / den if den > 0 else 0.0)
    cc = np.array(cc)
    k = int(np.argmax(cc))
    off = 0.0
    if 0 < k < len(cc) - 1:
        den = cc[k - 1] - 2 * cc[k] + cc[k + 1]
        off = 0.5 * (cc[k - 1] - cc[k + 1]) / den if den != 0 else 0.0
    return k - max_shift + off, cc[k]


def lean_centrelines(grey):
    """(L0, L1) from straight centre-lines through each lane's clear band centroids."""
    h, w = grey.shape
    filled = np.where(np.isnan(grey), 1.0, grey)
    _, bounds = count_lanes(filled)
    img16 = (filled * 65535).astype(np.uint16)
    xs, leans, wts = [], [], []
    for s, e in zip(bounds[:-1], bounds[1:]):
        try:
            r = fit_lane(img16, s, e - 1, 0, (0, h - 1), 1, 1)
        except (ValueError, np.linalg.LinAlgError):
            continue
        if len(r["bands"]) < 3:
            continue
        f = r["centroid_fit"].convert(kind=np.polynomial.Polynomial)  # x = a + b y
        coef = list(f.coef) + [0.0]
        xs.append((s + e) / 2)
        leans.append(coef[1])
        wts.append(len(r["bands"]))
    if not leans:
        return 0.0, 0.0
    if len(leans) < 3:
        return float(np.average(leans, weights=wts)), 0.0
    L1, L0c = np.polyfit(np.array(xs) - (w - 1) / 2, leans, 1, w=np.sqrt(wts))
    return float(L0c), float(L1)


def measure(grey, method):
    C = content(grey)
    L0, L1 = lean_correlation(C) if method == "A" else lean_centrelines(grey)
    return L0, L1, band_slope(C)


VARIANTS = ("full", "lanes", "rotation")


def sliders(L0, L1, B, h, variant="full"):
    """Slider values (small angles):
    full      undo lean L0, fanning L1 and band slope B: rotation takes what it can,
              skew and distort share the rest
    lanes     undo lean and fanning only, with skew and perspective (rows don't move)
    rotation  undo lean with rotation, fanning with perspective (as by hand)"""
    p = float(L1 * (h - 1) / 0.6)
    if variant == "lanes":
        return {"rotation": 0.0, "skew": -L0, "distort": 0.0, "perspective": p}
    if variant == "rotation":
        return {"rotation": float(np.degrees(np.arctan(L0))), "skew": 0.0, "distort": 0.0, "perspective": p}
    r = (L0 - B) / 2
    return {"rotation": float(np.degrees(np.arctan(r))), "skew": -(L0 + B) / 2, "distort": -(L0 + B) / 2,
            "perspective": p}


def auto_straighten(grey, method="B", max_rounds=6, variant="full"):
    """Slider settings (relative to grey as given): measure, correct, re-measure until a
    round changes rotation by under 0.05 degrees (and the rest by as little). Returns
    (settings, rounds used)."""
    h, w = grey.shape
    total = dict.fromkeys(GEOM, 0.0)
    for k in range(1, max_rounds + 1):
        cur = warp(grey, matrix(w, h, **total)) if any(total.values()) else grey
        est = sliders(*measure(cur, method), cur.shape[0], variant)
        total = {g: total[g] + est[g] for g in GEOM}
        if abs(est["rotation"]) < 0.05 and abs(est["skew"]) < 0.001 and abs(est["perspective"]) < 0.005:
            break
    return total, k


def masses(grey, tag, out):
    """Whole pipeline on grey (lanes from count_lanes, ladder = lane 1's strongest peaks):
    same-protein chi2 per window, lane 5 / 11 triplets, number of lanes."""
    filled = np.where(np.isnan(grey), 1.0, grey)
    png, lanes_csv = out / f"auto_{tag}.png", out / f"auto_{tag}_lanes.csv"
    Image.fromarray((filled * 65535).astype(np.uint16)).save(png)
    _, bounds = count_lanes(filled)
    with open(lanes_csv, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["name", "start", "end"])
        for k, (s, e) in enumerate(zip(bounds[:-1], bounds[1:]), 1):
            wr.writerow([f"lane{k}", s, e - 1])
    n = len(bounds) - 1
    same = [x for lo, hi in WINDOWS for x in ("--same", str(lo), str(hi))]
    run = subprocess.run([sys.executable, str(Path(__file__).parent / "band_masses.py"), str(png), "--lanes",
                          str(lanes_csv), "--row-start", "0", "--ladder-strongest", *same,
                          "--same-lanes", *map(str, range(2, n + 1))], capture_output=True, text=True)
    if run.returncode != 0:
        return {"lanes": n, "error": (run.stderr or run.stdout).strip().splitlines()[-1]}
    with open(out / f"auto_{tag}_same_protein.csv", newline="") as f:
        same_rows = list(csv.DictReader(f))
    with open(out / f"auto_{tag}_masses.csv", newline="") as f:
        rows = list(csv.DictReader(f))
    trip = lambda lane: sorted((float(r["kDa"]) for r in rows if r["lane_no"] == lane and r["kDa"]  # noqa: E731
                                and 36 <= float(r["kDa"]) <= 42), reverse=True)[:3]
    return {"lanes": n, "chi2": [(r["lo_kDa"], float(r["chi2"]), int(r["dof"])) for r in same_rows],
            "t5": trip("5"), "t11": trip("11")}


def fmt(d):
    return (f"rotation {d['rotation']:+.2f} deg, perspective {d['perspective']:+.3f}, "
            f"skew {d['skew']:+.4f}, distort {d['distort']:+.4f}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--row-start", type=int, default=140, help="rows above are whited out (labels)")
    p.add_argument("--masses", action="store_true",
                   help="also run the masses pipeline before/after auto-straightening (as is and rotated 3 degrees)")
    a = p.parse_args()
    grey = load(a.image).astype(float) / 65535
    grey[: a.row_start] = 1.0
    h, w = grey.shape
    cases = [("as is", {}), ("+3 deg rotation", {"rotation": 3}), ("-2 deg rotation", {"rotation": -2}),
             ("+0.03 skew", {"skew": 0.03}), ("+0.2 perspective", {"perspective": 0.2})]
    if a.masses:
        masses_report(grey)
        return
    for method in ("B",):
        print(f"Method {method} ({'correlation' if method == 'A' else 'centre-lines'}):")
        base = None
        for name, extra in cases:
            img = warp(grey, matrix(w, h, **extra)) if extra else grey
            fix, rounds = auto_straighten(img, method)
            after = warp(img, matrix(img.shape[1], img.shape[0], **fix))
            Lb0, Lb1, B = measure(after, "B")
            if base is None:
                base = fix
            diff = {k: fix[k] - base[k] for k in GEOM}
            print(f"  {name:<18} fix: {fmt(fix)}  ({rounds} rounds)")
            if extra:
                print(f"  {'':<18} vs as-is: {fmt(diff)}  (should undo {extra})")
            print(f"  {'':<18} left after: lean {np.degrees(np.arctan(Lb0)):+.2f} deg, band slope "
                  f"{np.degrees(np.arctan(B)):+.2f} deg, fanning {Lb1 * w:+.4f} across the gel")


def masses_report(grey):
    h, w = grey.shape
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    print("\nMasses, whole pipeline (lanes found automatically), before vs after auto-straightening:")
    for name, extra in (("gel_02", {}), ("gel_02 rotated 3 deg", {"rotation": 3})):
        img = warp(grey, matrix(w, h, **extra)) if extra else grey
        versions = [("before", img)]
        for v in VARIANTS:
            fix, _ = auto_straighten(img, variant=v)
            versions.append((f"after ({v}: {fmt(fix)})", warp(img, matrix(img.shape[1], img.shape[0], **fix))))
        for when, im in versions:
            tag = f"{'rot3' if extra else 'as_is'}_{when.split(' ')[0]}{when.split(' ')[1][1:-1] if ' ' in when else ''}"
            r = masses(im, tag, out)
            if "error" in r:
                print(f"  {name:<22} {when:<6} {r['lanes']} lanes: masses failed ({r['error']})")
                continue
            chi = ", ".join(f"{c:.1f}/{d}" for _, c, d in r["chi2"])
            print(f"  {name:<22} {when}\n      {r['lanes']} lanes; same-protein chi2 (105, 109, 74, 64, 52 kDa): {chi}; "
                  f"triplets lane 5 {r['t5']} lane 11 {r['t11']}")


if __name__ == "__main__":
    main()
