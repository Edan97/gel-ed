"""Find a lane's centre-line from the moments of its bands, and straighten the lane.

Works on the extracted column data, not the picture: the region is the block of
column profiles from START to END (rows x columns, 0 = black, 1 = white).

1. Signal = darkness above each column's background (its median), so bands are positive.
2. Bands = peaks in the signal summed across the region; each band's row window runs
   out from its peak until the summed signal falls below FLOOR x that band's peak.
3. Each band's moments, with the signal as weights:
     first:  centroid (x, y)
     second: var x, var y, cov xy  ->  width ~ sqrt(12 var x) for a flat-topped band,
                                       slope dy/dx = cov / var x
   Also each band's edges at half its peak (summed over its rows); their midpoint is the
   band's geometric centre, and centroid - midpoint shows lopsided (asymmetric) filling.
4. Fit the centre-line x(y) through the band centroids with Legendre polynomials of several
   degrees, rows rescaled to -1..1 over first..last band. Coefficients: 0 = mean position,
   1 = lean (px over half the band range), 2 = bow, 3 = S-bend, ...
5. Straighten: shift each row so the centre-line sits on one column, then re-measure.
   The background-subtracted signal is what gets shifted. Background is not flat
   across the columns, so subtracting it per column only works in the original frame.

Usage:
    python scoping/ladder_centreline.py IMAGE [--cols 31 137] [--degrees 1 2 3 4 5] [--straighten DEG]
"""

import argparse
import csv
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402


def extract(img, start, end):
    """Column profiles START..END inclusive, as rows x columns, scaled 0 (black) - 1 (white)."""
    return img[:, start : end + 1].astype(np.float64) / 65535


def band_signal(region):
    """Darkness above each column's background. Background = the column's median."""
    dark = 1 - region
    return np.clip(dark - np.median(dark, axis=0), 0, None)


def band_windows(signal, min_frac=0.1, floor=0.1, smooth=5):
    """Row windows (lo, hi) inclusive, one per band.

    A band is a local maximum of the summed signal that reaches min_frac of the
    strongest band. Its window runs out from the peak while the summed signal stays
    above floor x the band's peak and keeps falling (stops at a valley).
    """
    prof = np.convolve(signal.sum(axis=1), np.ones(smooth) / smooth, mode="same")
    is_peak = (prof[1:-1] > prof[:-2]) & (prof[1:-1] >= prof[2:])
    peaks = np.flatnonzero(is_peak) + 1
    peaks = peaks[prof[peaks] >= min_frac * prof.max()]

    windows = []
    for p in peaks:
        cut = floor * prof[p]
        lo = p
        while lo > 0 and prof[lo - 1] > cut and prof[lo - 1] <= prof[lo]:
            lo -= 1
        hi = p
        while hi < len(prof) - 1 and prof[hi + 1] > cut and prof[hi + 1] <= prof[hi]:
            hi += 1
        if windows and p <= windows[-1][1]:  # a shoulder already inside the previous window
            continue
        if windows:
            lo = max(lo, windows[-1][1] + 1)  # neighbours sharing a valley: split at it
        windows.append((lo, hi))
    return windows


def moments(signal, lo, hi, x0=0):
    """First and second moments of signal[lo:hi+1, :]. x is offset by x0 (image columns)."""
    w = signal[lo : hi + 1]
    ys, xs = np.mgrid[lo : hi + 1, 0 : w.shape[1]]
    xs = xs + x0
    total = w.sum()
    mx, my = (w * xs).sum() / total, (w * ys).sum() / total
    vx = (w * (xs - mx) ** 2).sum() / total
    vy = (w * (ys - my) ** 2).sum() / total
    cxy = (w * (xs - mx) * (ys - my)).sum() / total
    return {
        "row_lo": lo, "row_hi": hi, "total": total,
        "x": mx, "y": my, "var_x": vx, "var_y": vy, "cov_xy": cxy,
        "width": np.sqrt(12 * vx), "sd_y": np.sqrt(vy), "slope": cxy / vx,
        **edges(w.sum(axis=0), x0),
    }


def edges(col_profile, x0=0, frac=0.5):
    """Outermost points where the profile crosses frac of its peak, their midpoint and the gap.

    Sub-pixel: each crossing is linearly interpolated between the pixels either side of it.
    """
    p = col_profile
    h = frac * p.max()
    idx = np.flatnonzero(p >= h)
    i0, i1 = idx[0], idx[-1]
    left = i0 - 1 + (h - p[i0 - 1]) / (p[i0] - p[i0 - 1]) if i0 > 0 else float(i0)
    right = i1 + (p[i1] - h) / (p[i1] - p[i1 + 1]) if i1 < len(p) - 1 else float(i1)
    left, right = left + x0, right + x0
    return {"left": left, "right": right, "fwhm": right - left, "mid": (left + right) / 2}


def fit_centreline(bands, degree, domain=None):
    """Legendre polynomial x(y) through the band centroids.

    Rows are mapped to -1..1 over domain (default: first..last band). Pass a shared
    domain to make coefficients comparable between lanes.
    """
    y = np.array([b["y"] for b in bands])
    x = np.array([b["x"] for b in bands])
    return np.polynomial.Legendre.fit(y, x, degree, domain=domain)


def straighten(arr, centre, x0, y_range, fill):
    """Shift each row of arr so the centre-line lands on its mean column.

    Outside y_range (first to last band) the shift is held at its end value: a
    polynomial is not trustworthy beyond the points it was fitted to.
    """
    rows = np.arange(arr.shape[0])
    shift = centre(np.clip(rows, *y_range)) - x0
    target = shift.mean()
    cols = np.arange(arr.shape[1], dtype=np.float64)
    out = np.empty_like(arr)
    for r in rows:
        # value at output column c comes from input column c + (shift - target)
        out[r] = np.interp(cols + shift[r] - target, cols, arr[r], left=fill, right=fill)
    return out, shift - target


def measure(signal, x0):
    return [moments(signal, lo, hi, x0) for lo, hi in band_windows(signal)]


def plot(region, x0, bands, fits, straight, straight_deg, bands_straight, title):
    fig, axes = plt.subplots(1, 3, figsize=(15, 9), sharey=True, gridspec_kw={"width_ratios": [1, 1, 1.3]})
    extent = (x0 - 0.5, x0 + region.shape[1] - 0.5, region.shape[0] - 0.5, -0.5)
    y = np.array([b["y"] for b in bands])
    ys = np.linspace(y.min(), y.max(), 200)
    colours = ["#2a78d6", "#e8730c", "#1a9e5f", "#b03a9c", "#8c6d1f", "#555555"]

    ax = axes[0]
    ax.imshow(region, cmap="gray", vmin=0, vmax=1, aspect="auto", extent=extent)
    for b in bands:
        ax.axhspan(b["row_lo"], b["row_hi"], color="#e8730c", alpha=0.12, lw=0)
    ax.plot([b["x"] for b in bands], y, "o", ms=5, mfc="none", mec="#d62a2a", label="band centroid")
    for (deg, poly), c in zip(fits.items(), colours):
        ax.plot(poly(ys), ys, color=c, lw=1.2, label=f"degree {deg}")
    ax.set(title="Original: centroids + fits", xlabel="Column (px)", ylabel="Row (px)")
    ax.legend(loc="lower left", fontsize=8)

    ax = axes[1]
    ax.imshow(straight, cmap="gray", vmin=0, vmax=1, aspect="auto", extent=extent)
    ax.plot([b["x"] for b in bands_straight], [b["y"] for b in bands_straight],
            "o", ms=5, mfc="none", mec="#d62a2a")
    ax.set(title=f"Straightened (degree {straight_deg})", xlabel="Column (px)")

    ax = axes[2]
    for (deg, poly), c in zip(fits.items(), colours):
        ax.plot(np.array([b["x"] for b in bands]) - poly(y), y, "o-", color=c, ms=4, lw=1,
                label=f"degree {deg}")
    ax.plot([b["x"] - np.mean([q["x"] for q in bands_straight]) for b in bands_straight],
            [b["y"] for b in bands_straight], "s", color="#555", ms=4, mfc="none",
            label="after straightening\n(centroid − mean)")
    ax.axvline(0, color="#999", lw=0.8)
    ax.set(title="Centroid residuals (px)", xlabel="Centroid − fit (px)")
    ax.tick_params(labelleft=True)
    ax.legend(fontsize=8)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)

    fig.suptitle(title)
    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--cols", type=int, nargs=2, default=(31, 137), metavar=("START", "END"))
    p.add_argument("--degrees", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    p.add_argument("--straighten", type=int, help="degree used to straighten (default: highest of --degrees)")
    a = p.parse_args()

    start, end = a.cols
    region = extract(load(a.image), start, end)
    signal = band_signal(region)
    bands = measure(signal, start)
    fits = {d: fit_centreline(bands, d) for d in sorted(a.degrees)}

    y = [b["y"] for b in bands]
    straight_deg = a.straighten or max(fits)
    if straight_deg not in fits:
        fits[straight_deg] = fit_centreline(bands, straight_deg)
        fits = dict(sorted(fits.items()))
    centre, y_range = fits[straight_deg], (min(y), max(y))
    straight, _ = straighten(region, centre, start, y_range, fill=np.nan)  # for display
    bands_straight = measure(straighten(signal, centre, start, y_range, fill=0)[0], start)

    stem = f"{Path(a.image).stem}_cols{start}-{end}"
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)

    with open(out / f"{stem}_bands.csv", "w", newline="") as f:
        cols = ["row_lo", "row_hi", "total", "x", "y", "var_x", "var_y", "cov_xy", "width", "sd_y", "slope",
                "left", "right", "fwhm", "mid"]
        w = csv.writer(f)
        w.writerow(["band", *cols, *(f"resid_deg{d}" for d in fits)])
        for i, b in enumerate(bands, 1):
            w.writerow([i, *(round(b[c], 4) for c in cols),
                        *(round(b["x"] - fits[d](b["y"]), 3) for d in fits)])

    fig = plot(region, start, bands, fits, straight, straight_deg, bands_straight,
               f"{Path(a.image).name}, columns {start}–{end}")
    fig.savefig(out / f"{stem}_centreline.png", dpi=130)

    print(f"{len(bands)} bands")
    print(f"{'band':>4} {'rows':>9} {'x':>7} {'y':>7} {'mid':>6} {'x-mid':>6} {'fwhm':>4} {'sd_y':>5} {'slope':>7}  "
          + "  ".join(f"res{d:>2}" for d in fits))
    for i, b in enumerate(bands, 1):
        print(f"{i:>4} {b['row_lo']:>4}-{b['row_hi']:<4} {b['x']:7.2f} {b['y']:7.2f} {b['mid']:6.1f} "
              f"{b['x'] - b['mid']:6.2f} {b['fwhm']:4.1f} "
              f"{b['sd_y']:5.2f} {b['slope']:7.3f}  "
              + "  ".join(f"{b['x'] - fits[d](b['y']):5.2f}" for d in fits))
    print(f"before straightening: centroid x spread (max − min) "
          f"{max(b['x'] for b in bands) - min(b['x'] for b in bands):.2f} px")
    for d, poly in fits.items():
        r = np.array([b["x"] - poly(b["y"]) for b in bands])
        xs = np.array([b["x"] for b in measure(straighten(signal, poly, start, y_range, fill=0)[0], start)])
        print(f"degree {d}: RMS residual {np.sqrt((r ** 2).mean()):.2f} px, "
              f"spread after straightening {xs.max() - xs.min():.2f} px"
              + ("   <- plotted" if d == straight_deg else ""))
        print(f"          Legendre coefficients: {np.round(poly.coef, 2)}")
    print(out / f"{stem}_bands.csv")
    print(out / f"{stem}_centreline.png")


if __name__ == "__main__":
    main()
