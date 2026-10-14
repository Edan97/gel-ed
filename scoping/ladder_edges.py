"""Fit a lane's outline from per-row band edges: a centre-line plus a width, fitted together.

Compared with ladder_centreline.py (one point per band: its intensity centroid), this:
1. Measures every row inside each band, not one point per band. In each row the
   left and right edges are where the (lightly smoothed) signal crosses FRAC of that
   row's peak, interpolated to sub-pixel. FRAC defaults to 0.25, not 0.5: ladder bands
   are unevenly dark across their width, and at half-max a single row often loses
   its fainter side (rows came out 20-30 px wide instead of ~50). Only the band's core is used: rows whose
   peak is at least CORE x the band's strongest row.
2. Fits both edges at once with a shared model,
       left  = c(y) - w(y)/2
       right = c(y) + w(y)/2
   c = centre-line (Legendre, degree DEG_C), w = lane width (Legendre, degree DEG_W).
   Using edges, not intensity, makes the centre follow the lane's shape regardless
   of how the sample is spread across it.
3. Weights each band equally: each row gets 1 / (rows used in its band).

The figure compares this with the band-centroid fit, sharing one row axis:
  original + both centre-lines | straightened (edge fit) | centre residuals | width

Usage:
    python scoping/ladder_edges.py IMAGE [--cols 31 137] [--deg-c 4] [--deg-w 1] [--frac 0.25]
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from numpy.polynomial import Legendre
from numpy.polynomial import legendre as L

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ladder_centreline import (  # noqa: E402
    band_signal, band_windows, edges, extract, fit_centreline, load, measure, moments, straighten,
)


def row_edges(signal, windows, x0, core=0.5, frac=0.25, smooth=5):
    """Per-row edges inside each band's core. Returns a list of dicts, one per row."""
    kernel = np.ones(smooth) / smooth
    points = []
    for band, (lo, hi) in enumerate(windows, 1):
        sm = np.array([np.convolve(signal[r], kernel, mode="same") for r in range(lo, hi + 1)])
        peaks = sm.max(axis=1)
        for r, prof, pk in zip(range(lo, hi + 1), sm, peaks):
            if pk < core * peaks.max():
                continue
            e = edges(prof, x0, frac)
            points.append({"band": band, "y": r, **e})
    return points


def fit_outline(points, deg_c, deg_w, domain=None):
    """Joint least-squares fit of left/right edges. Returns (centre, width) as Legendre series.

    Rows are mapped to -1..1 over domain (default: first..last row used). Pass a shared
    domain to make coefficients comparable between lanes.
    """
    y = np.array([p["y"] for p in points], dtype=float)
    left = np.array([p["left"] for p in points])
    right = np.array([p["right"] for p in points])
    band = np.array([p["band"] for p in points])
    counts = {b: (band == b).sum() for b in np.unique(band)}
    wt = np.sqrt(np.array([1 / counts[b] for b in band]))  # sqrt: lstsq squares the weights

    domain = np.array([y.min(), y.max()] if domain is None else domain, dtype=float)
    t = (2 * y - domain.sum()) / (domain[1] - domain[0])  # rows -> -1..1
    vc, vw = L.legvander(t, deg_c), L.legvander(t, deg_w)
    # unknowns: [c_0..c_degC, w_0..w_degW]
    a = np.vstack([np.hstack([vc, -vw / 2]), np.hstack([vc, vw / 2])]) * np.tile(wt, 2)[:, None]
    b = np.concatenate([left, right]) * np.tile(wt, 2)
    coef, *_ = np.linalg.lstsq(a, b, rcond=None)
    centre = Legendre(coef[: deg_c + 1], domain=domain)
    width = Legendre(coef[deg_c + 1 :], domain=domain)
    return centre, width


def spreads(signal, centre, x0, y_range, windows=None):
    """Max - min of band centroids and of band edge-midpoints after straightening with centre.

    windows: band row windows to measure in (default: found again on the straightened signal).
    Straightening only moves rows sideways, so the same windows stay valid.
    """
    straight = straighten(signal, centre, x0, y_range, fill=0)[0]
    bands = ([moments(straight, lo, hi, x0) for lo, hi in windows] if windows is not None
             else measure(straight, x0))
    xs = np.array([b["x"] for b in bands])
    ms = np.array([b["mid"] for b in bands])
    return xs.max() - xs.min(), ms.max() - ms.min(), bands


def plot(region, x0, points, centre, width, centroid_fit, centroid_bands, straight, title,
         deg_c, deg_w, y_range=None):
    """y_range: rows the fits are drawn over and held beyond (default: the fit's domain)."""
    y_range = tuple(centre.domain) if y_range is None else y_range
    blue, orange, grey, red = "#2a78d6", "#e8730c", "#888888", "#d62a2a"
    fig, axes = plt.subplots(1, 4, figsize=(19, 9), sharey=True,
                             gridspec_kw={"width_ratios": [1, 1, 1.1, 1.1]})
    extent = (x0 - 0.5, x0 + region.shape[1] - 0.5, region.shape[0] - 0.5, -0.5)
    y = np.array([p["y"] for p in points])
    band = np.array([p["band"] for p in points])
    left = np.array([p["left"] for p in points])
    right = np.array([p["right"] for p in points])
    mid = np.array([p["mid"] for p in points])
    ys = np.linspace(*y_range, 300)

    ax = axes[0]
    ax.imshow(region, cmap="gray", vmin=0, vmax=1, aspect="auto", extent=extent)
    ax.plot(left, y, ".", color=orange, ms=2, alpha=0.6, label="row edges")
    ax.plot(right, y, ".", color=orange, ms=2, alpha=0.6)
    ax.plot(centre(ys) - width(ys) / 2, ys, color=orange, lw=1)
    ax.plot(centre(ys) + width(ys) / 2, ys, color=orange, lw=1)
    ax.plot(centre(ys), ys, color=blue, lw=1.5, label=f"edge fit: centre (deg {centre.degree()})")
    cy = np.array([b["y"] for b in centroid_bands])
    cys = np.linspace(cy.min(), cy.max(), 300)
    ax.plot(centroid_fit(cys), cys, color=red, lw=1.2, ls="--", label=f"centroid fit (deg {centroid_fit.degree()})")
    ax.plot([b["x"] for b in centroid_bands], cy, "o", ms=5, mfc="none", mec=red)
    ax.set(title="Original: edges + both fits", xlabel="Column (px)", ylabel="Row (px)")
    ax.legend(loc="lower left", fontsize=8)

    ax = axes[1]
    ax.imshow(straight, cmap="gray", vmin=0, vmax=1, aspect="auto", extent=extent)
    target = np.mean(centre(np.clip(np.arange(region.shape[0]), *y_range)))
    ax.plot(target - width(ys) / 2, ys, color=orange, lw=1)
    ax.plot(target + width(ys) / 2, ys, color=orange, lw=1)
    ax.axvline(target, color=blue, lw=0.8, alpha=0.6)
    ax.set(title=f"Straightened (edge fit, deg {centre.degree()})", xlabel="Column (px)")

    ax = axes[2]
    ax.plot(mid - centre(y), y, ".", color=grey, ms=2, alpha=0.5, label="row midpoint − centre fit")
    bands = np.unique(band)
    ax.plot([np.mean(mid[band == b] - centre(y[band == b])) for b in bands],
            [np.mean(y[band == b]) for b in bands], "o-", color=blue, ms=5, lw=1,
            label="band mean (edge fit)")
    ax.plot([b["x"] - centroid_fit(b["y"]) for b in centroid_bands], cy, "s-", color=red,
            ms=4, lw=1, mfc="none", label="band centroid − centroid fit")
    ax.axvline(0, color="#999", lw=0.8)
    ax.set(title="Centre residuals (px)", xlabel="Measured − fit (px)", xlim=(-6, 6))
    ax.tick_params(labelleft=True)
    ax.legend(fontsize=8, loc="lower left")

    ax = axes[3]
    ax.plot(right - left, y, ".", color=grey, ms=2, alpha=0.5, label="row width")
    ax.plot([np.mean((right - left)[band == b]) for b in bands],
            [np.mean(y[band == b]) for b in bands], "o", color=orange, ms=5, label="band mean")
    ax.plot(width(ys), ys, color=orange, lw=1.5, label=f"width fit (deg {deg_w})")
    ax.set(title="Lane width (px)", xlabel="Right − left edge (px)")
    ax.tick_params(labelleft=True)
    ax.legend(fontsize=8, loc="lower left")

    for ax in axes[2:]:
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
    fig.suptitle(title)
    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--cols", type=int, nargs=2, default=(31, 137), metavar=("START", "END"))
    p.add_argument("--deg-c", type=int, default=4, help="centre-line degree (default 4)")
    p.add_argument("--deg-w", type=int, default=1, help="width degree (default 1)")
    p.add_argument("--frac", type=float, default=0.25,
                   help="edge = where a row crosses this fraction of its peak (default 0.25)")
    p.add_argument("--core", type=float, default=0.5,
                   help="use rows whose peak is at least this fraction of the band's strongest row")
    p.add_argument("--exclude-rows", type=int, nargs=2, metavar=("LO", "HI"),
                   help="also report spreads without bands centred in rows LO..HI "
                        "(e.g. a damaged ladder band: 757 831 on gel_02)")
    a = p.parse_args()

    start, end = a.cols
    region = extract(load(a.image), start, end)
    signal = band_signal(region)
    windows = band_windows(signal)

    centroid_bands = measure(signal, start)
    centroid_fit = fit_centreline(centroid_bands, a.deg_c)
    cy = [b["y"] for b in centroid_bands]

    points = row_edges(signal, windows, start, core=a.core, frac=a.frac)
    centre, width = fit_outline(points, a.deg_c, a.deg_w)
    y_range = tuple(centre.domain)

    straight, _ = straighten(region, centre, start, y_range, fill=np.nan)

    stem = f"{Path(a.image).stem}_cols{start}-{end}"
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    fig = plot(region, start, points, centre, width, centroid_fit, centroid_bands, straight,
               f"{Path(a.image).name}, columns {start}–{end}: per-row edge fit vs band-centroid fit",
               a.deg_c, a.deg_w)
    fig.savefig(out / f"{stem}_edges.png", dpi=130)

    y = np.array([q["y"] for q in points])
    band = np.array([q["band"] for q in points])
    mid = np.array([q["mid"] for q in points])
    w = np.array([q["right"] - q["left"] for q in points])
    print(f"{len(points)} row points from {len(np.unique(band))} bands "
          f"(rows per band: {[int((band == b).sum()) for b in np.unique(band)]})")
    print(f"centre (Legendre, deg {a.deg_c}): {np.round(centre.coef, 2)}")
    print(f"width  (Legendre, deg {a.deg_w}): {np.round(width.coef, 2)}"
          f"  -> {width(y_range[0]):.1f} px at row {y_range[0]:.0f}, {width(y_range[1]):.1f} px at row {y_range[1]:.0f}")
    r = mid - centre(y)
    band_r = np.array([r[band == b].mean() for b in np.unique(band)])
    print(f"edge fit: row-midpoint RMS residual {np.sqrt((r ** 2).mean()):.2f} px, "
          f"band-mean RMS {np.sqrt((band_r ** 2).mean()):.2f} px")
    rw = w - width(y)
    print(f"width residual RMS {np.sqrt((rw ** 2).mean()):.2f} px")

    print("\nafter straightening (max − min across bands):   centroids   edge midpoints")
    for name, fit, rng in (("band-centroid fit", centroid_fit, (min(cy), max(cy))),
                           ("per-row edge fit", centre, y_range)):
        sx, sm, _ = spreads(signal, fit, start, rng)
        print(f"  {name:<18}                              {sx:6.2f} px   {sm:6.2f} px")
    if a.exclude_rows:
        lo, hi = a.exclude_rows
        print(f"  without bands centred in rows {lo}–{hi}:")
        for name, fit, rng in (("band-centroid fit", centroid_fit, (min(cy), max(cy))),
                               ("per-row edge fit", centre, y_range)):
            _, _, bs = spreads(signal, fit, start, rng)
            keep = [b for b in bs if not (lo <= b["y"] <= hi)]
            xs, ms = [b["x"] for b in keep], [b["mid"] for b in keep]
            print(f"  {name:<18}                              {max(xs) - min(xs):6.2f} px   {max(ms) - min(ms):6.2f} px")
    print(out / f"{stem}_edges.png")


if __name__ == "__main__":
    main()
