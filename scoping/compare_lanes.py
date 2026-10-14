"""Fit centre-lines independently on several lanes and compare the coefficients.

Each lane is a hand-picked column range (ranges may overlap). Both methods are run
on each lane: band centroids (ladder_centreline.py) and joint per-row edges with
centre + width (ladder_edges.py). All lanes are fitted over the same row domain, so
their Legendre coefficients mean the same thing:
    c0 = mean position, c1 = lean, c2 = bow, c3 = S-bend, c4 = ...
each in px of sideways movement over half the domain.

Degree is chosen per lane and per method by leave-one-band-out cross-validation
(unless --deg-c fixes it). For each interior band: drop it, fit the rest, measure how
far the fit misses it. The RMS miss is the LOO error. The lowest degree within
max(10%, 0.5 px) of the best is chosen, so near-ties go to the simpler curve. First and
last bands aren't scored: dropping them makes the fit extrapolate, which tests the
ends of the curve rather than its shape. The chosen degree's LOO error is also a
quality score for the lane: how well its centre-line can be predicted at all.

Rows above --row-start are ignored. That is a MANUAL annotation cutoff (lane labels
etc.); detecting it automatically is still open (NOTES.md).

Outputs (scoping/out/):
    <image>_lanes_<name>.png    the 4-panel edge-fit figure for each lane
    <image>_lanes_overlay.png   the whole gel with every lane's fits drawn on it
    <image>_lanes_summary.png   centre-line shapes overlaid + coefficients side by side
    <image>_lanes_summary.csv   all coefficients

Usage:
    python scoping/compare_lanes.py IMAGE [--row-start 140] [--lanes FILE.csv | --lane NAME START END ...]
                                          [--max-deg 4 | --deg-c N]
"""

import argparse
import csv
import re
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ladder_centreline import band_signal, extract, fit_centreline, load, moments, straighten  # noqa: E402
from ladder_edges import fit_outline, plot as plot_lane, row_edges, spreads  # noqa: E402
from band_peaks import find_bands  # noqa: E402
from lanes import number_lanes, read_lanes  # noqa: E402

# gel_02.jpg: the ladder plus three contrasting sample lanes (clean, saturated, faint at the edge)
DEFAULT_LANES = [
    ("ladder", 31, 137),
    ("+CPI AV/AV neat", 275, 430),
    ("Veh AV/+ neat", 1030, 1175),
    ("Veh AV/AV 1 in 50", 1780, 1910),
]
LOO_FLAG_PX = 3.0  # provisional: lanes whose edge-fit LOO error exceeds this are marked unreliable


def lane_colours(n):
    """Lanes are ordered across the gel, so colour them with an ordered (sequential) map."""
    return plt.cm.viridis(np.linspace(0, 0.9, n))


def loo_error(bands, points, method, deg, deg_w, domain):
    """Leave-one-band-out RMS miss (px) over interior bands. NaN if too few bands."""
    misses = []
    for i in range(1, len(bands) - 1):
        if method == "centroid":
            keep = [b for j, b in enumerate(bands) if j != i]
            if len(keep) <= deg:
                return np.nan
            misses.append(bands[i]["x"] - fit_centreline(keep, deg, domain=domain)(bands[i]["y"]))
        else:
            keep = [q for q in points if q["band"] != i + 1]
            test = [q for q in points if q["band"] == i + 1]
            if len({q["band"] for q in keep}) <= max(deg, deg_w) or not test:
                return np.nan
            centre, _ = fit_outline(keep, deg, deg_w, domain=domain)
            misses.append(np.mean([q["mid"] - centre(q["y"]) for q in test]))
    return np.sqrt(np.mean(np.square(misses))) if misses else np.nan


def choose_degree(errors, rel=0.1, abs_px=0.5):
    """Lowest degree whose LOO error is within max(rel x best, abs_px) of the best.
    None if no degree could be scored (fewer than 3 bands)."""
    errors = np.asarray(errors, dtype=float)
    if np.isnan(errors).all():
        return None
    best = np.nanmin(errors)
    return int(np.flatnonzero(errors <= best + max(rel * best, abs_px))[0])


def windows_from_rows(rows, n_rows, half=12):
    """Row window (lo, hi) around each band row: +-half rows, split at the midpoint
    between neighbouring bands so windows never overlap."""
    rows = sorted(rows)
    out = []
    for i, r in enumerate(rows):
        lo = r - half if i == 0 else max(r - half, (rows[i - 1] + r) // 2 + 1)
        hi = r + half if i == len(rows) - 1 else min(r + half, (r + rows[i + 1]) // 2)
        out.append((max(lo, 0), min(hi, n_rows - 1)))
    return out


def geometry_bands(found, rel=0.5):
    """Peaks clear enough to locate the lane: no shoulders, and prominence at least rel x
    the lane's median peak prominence. Relative to the median, not the strongest band, so
    one dominant band doesn't hide the rest. On gel_02 this beat a noise threshold (the
    noise estimate is inflated on lanes with many sharp or leaning bands, e.g. the ladder)
    and beat using every band: median best LOO 1.3 px vs 1.9 (snr >= 15) and 2.0 (0.3 x)."""
    peaks = [d for d in found if d["kind"] == "peak"]
    if not peaks:
        return []
    med = np.median([d["height"] for d in peaks])
    return [d for d in peaks if d["height"] >= rel * med]


def fit_lane(img, start, end, row_start, domain, deg_c, deg_w, max_deg=4, geom_rel=0.5):
    """Fit one lane with both methods. deg_c=None chooses each method's degree by LOO.

    Bands come from band_peaks.find_bands (noise-relative peak picking); each band's
    moments and per-row edges are measured in a window around its row. Only clear
    peaks are used for geometry (see geometry_bands): faint bands, shoulders and
    background bands that run across lanes find rows well but say little about where
    the lane is (on gel_02, using every band made LOO errors 2-10x worse on most lanes).
    """
    region = extract(img, start, end)
    signal = np.zeros_like(region)
    signal[row_start:] = band_signal(region[row_start:])
    found, _ = find_bands(region, row_start)
    found = geometry_bands(found, geom_rel)
    windows = windows_from_rows([d["y"] for d in found], region.shape[0])
    bands = [moments(signal, lo, hi, start) for lo, hi in windows]
    points = row_edges(signal, windows, start)
    # degree d has d+1 parameters; require at least two spare bands (d <= n - 3), otherwise
    # LOO trains on exactly as many points as parameters and the curve can't be checked
    usable = max(0, min(max_deg, len(bands) - 3))
    loo = {m: [loo_error(bands, points, m, d, deg_w, domain) if d <= usable else np.nan
               for d in range(max_deg + 1)]
           for m in ("centroid", "edge")}
    if not bands:
        raise ValueError("no bands found")
    # too few bands to cross-validate: straight line through 2 bands, fixed position through 1
    fallback = min(1, len(bands) - 1)
    deg = {m: (deg_c if deg_c is not None else choose_degree(loo[m])) for m in loo}
    deg = {m: (fallback if d is None else min(d, len(bands) - 1)) for m, d in deg.items()}
    centroid_fit = fit_centreline(bands, deg["centroid"], domain=domain)
    centre, width = fit_outline(points, deg["edge"], deg_w, domain=domain)
    y_range = (min(b["y"] for b in bands), max(b["y"] for b in bands))

    y = np.array([p["y"] for p in points])
    mid = np.array([p["mid"] for p in points])
    w = np.array([p["right"] - p["left"] for p in points])
    by = np.array([b["y"] for b in bands])
    bx = np.array([b["x"] for b in bands])
    sx_c, sm_c, _ = spreads(signal, centroid_fit, start, y_range, windows)
    sx_e, sm_e, _ = spreads(signal, centre, start, y_range, windows)
    return {
        "region": region, "signal": signal, "bands": bands, "points": points,
        "centroid_fit": centroid_fit, "centre": centre, "width": width, "y_range": y_range,
        "rms_centroid": np.sqrt(((bx - centroid_fit(by)) ** 2).mean()),
        "rms_edge": np.sqrt(((mid - centre(y)) ** 2).mean()),
        "rms_width": np.sqrt(((w - width(y)) ** 2).mean()),
        "spread_before": bx.max() - bx.min(),
        "spread_centroid": (sx_c, sm_c), "spread_edge": (sx_e, sm_e),
        "loo": loo, "deg": deg,
    }


def lean_deg(fit, domain):
    """Legendre c1 (px over half the domain) -> lean angle in degrees. 0 for a degree-0 fit."""
    c1 = fit.coef[1] if len(fit.coef) > 1 else 0.0
    return np.degrees(np.arctan(c1 / ((domain[1] - domain[0]) / 2)))


def summary_plot(results, domain, title, degree_note):
    fig, axes = plt.subplots(1, 6, figsize=(20, max(8, 0.45 * len(results) + 3)),
                             gridspec_kw={"width_ratios": [2, 1, 1, 1, 1, 1]})
    names = list(results)
    ys = np.arange(len(names))[::-1]

    ax = axes[0]
    for (name, r), c in zip(results.items(), lane_colours(len(results))):
        rows = np.linspace(*r["y_range"], 300)
        ax.plot(r["centre"](rows) - r["centre"].coef[0], rows, color=c, lw=2,
                label=f"{name} (deg {r['deg']['edge']} / {r['deg']['centroid']})")
        ax.plot(r["centroid_fit"](rows) - r["centroid_fit"].coef[0], rows, color=c, lw=1, ls="--")
    ax.invert_yaxis()
    ax.axvline(0, color="#bbb", lw=0.8)
    ax.set(title="Centre-line shape (minus c0)\nsolid = edge fit, dashed = centroid fit (degrees edge / centroid)",
           xlabel="Sideways offset from lane's mean position (px)", ylabel="Row (px)")
    ax.legend(fontsize=8, loc="lower left")

    labels = ["c1 lean", "c2 bow", "c3 S-bend"]
    for k, (ax, lab) in enumerate(zip(axes[1:4], labels), start=1):
        for y0, name in zip(ys, names):
            r = results[name]
            # lower-degree fits have fewer coefficients; the two methods may differ
            if k < len(r["centre"].coef):
                ax.plot(r["centre"].coef[k], y0 + 0.12, "o", color="#2a78d6", ms=7)
            if k < len(r["centroid_fit"].coef):
                ax.plot(r["centroid_fit"].coef[k], y0 - 0.12, "s", color="#d62a2a", ms=6, mfc="none")
        ax.axvline(0, color="#bbb", lw=0.8)
        ax.set(title=f"{lab} (px)", ylim=(-0.6, len(names) - 0.4))
        ax.set_yticks(ys)
        ax.set_yticklabels(names if k == 1 else [])
    axes[1].plot([], [], "o", color="#2a78d6", label="edge fit")
    axes[1].plot([], [], "s", color="#d62a2a", mfc="none", label="centroid fit")
    axes[1].legend(fontsize=8, loc="upper right")

    ax = axes[4]
    for y0, name in zip(ys, names):
        r = results[name]
        for method, mk, col, dy in (("edge", "o", "#2a78d6", 0.12), ("centroid", "s", "#d62a2a", -0.12)):
            e = r["loo"][method][r["deg"][method]]
            ax.plot(e, y0 + dy, mk, color=col, ms=6, mfc=col if method == "edge" else "none")
    ax.axvline(LOO_FLAG_PX, color="#999", lw=0.8, ls="--")
    ax.set(title=f"LOO error at chosen degree (px)\n(dashed: {LOO_FLAG_PX:g} px flag)",
           ylim=(-0.6, len(names) - 0.4), xlim=(0, None))
    ax.set_yticks(ys)
    ax.set_yticklabels([])

    ax = axes[5]
    for y0, name in zip(ys, names):
        r = results[name]
        lo, hi = r["y_range"]
        ax.plot([r["width"](lo), r["width"](hi)], [y0, y0], color="#e8730c", lw=2)
        ax.plot(r["width"](hi), y0, ">", color="#e8730c", ms=7)
    ax.set(title="Width (px)\ntop → bottom band", ylim=(-0.6, len(names) - 0.4))
    ax.set_yticks(ys)
    ax.set_yticklabels([])

    for ax in axes[1:]:
        ax.grid(axis="x", color="#e5e5e5", lw=0.5)
    for ax in axes:
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
    fig.suptitle(f"{title}  ·  all fits over rows {domain[0]}–{domain[1]}  ·  {degree_note}")
    fig.tight_layout()
    return fig


def overlay_plot(img, lanes, results, title, row_start):
    """The whole gel with every lane's selection, fitted edges, centre-line and bands."""
    blue, orange, red = "#2a78d6", "#e8730c", "#d62a2a"
    fig, ax = plt.subplots(figsize=(20, 11))
    ax.imshow(img, cmap="gray", vmin=0, vmax=65535)
    ax.axhline(row_start, color=red, lw=0.8, ls=":")
    ax.text(img.shape[1] - 5, row_start - 4, "manual annotation cutoff", color=red, fontsize=8,
            ha="right", va="bottom")
    for i, (name, start, end) in enumerate(lanes):
        r = results[name]
        rows = np.linspace(*r["y_range"], 300)
        c, w = r["centre"](rows), r["width"](rows)
        ax.axvspan(start - 0.5, end + 0.5, ymin=0, ymax=1, color=blue, alpha=0.05 + 0.04 * (i % 2), lw=0)
        ax.plot(c - w / 2, rows, color=orange, lw=1)
        ax.plot(c + w / 2, rows, color=orange, lw=1)
        ax.plot(c, rows, color=blue, lw=1.6)
        ax.plot(r["centroid_fit"](rows), rows, color=red, lw=1, ls="--")
        ax.plot([b["x"] for b in r["bands"]], [b["y"] for b in r["bands"]], "o", ms=4, mfc="none", mec=red)
        loo = r["loo"]["edge"][r["deg"]["edge"]]
        flag = not loo <= LOO_FLAG_PX  # NaN (too few bands to score) counts as flagged
        ax.text((start + end) / 2, row_start + 4, name.split(" ", 1)[0], ha="center", va="top",
                fontsize=15, fontweight="bold", color="#1f4e8c",
                bbox=dict(boxstyle="circle,pad=0.25", fc="white", ec="#1f4e8c", lw=1.2))
        ax.text((start + end) / 2, row_start + 52,
                f"deg {r['deg']['edge']}/{r['deg']['centroid']}\nLOO {loo:.1f}" + (" ?" if flag else ""),
                ha="center", va="top", fontsize=8, color=red if flag else "black",
                bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="none", alpha=0.8))
    ax.plot([], [], color=blue, lw=1.6, label="centre-line (edge fit)")
    ax.plot([], [], color=orange, lw=1, label="lane edges (edge fit)")
    ax.plot([], [], color=red, lw=1, ls="--", label="centre-line (centroid fit)")
    ax.plot([], [], "o", ms=4, mfc="none", mec=red, label="band centroids")
    ax.legend(loc="lower right", fontsize=8, framealpha=0.9)
    ax.set(title=f"{title}  ·  label: degree edge/centroid, edge-fit LOO error (px); "
                 f"? = LOO > {LOO_FLAG_PX:g} px  ·  shaded = column selection",
           xlabel="Column (px)", ylabel="Row (px)")
    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--row-start", type=int, default=140,
                   help="ignore rows above this (manual annotation cutoff; default 140 for gel_02)")
    p.add_argument("--lanes", help="CSV of lanes (name,start,end), e.g. scoping/samples/gel_02_lanes.csv")
    p.add_argument("--lane", nargs=3, action="append", metavar=("NAME", "START", "END"),
                   help="lane name and column range; repeat for each lane (default: gel_02 set)")
    p.add_argument("--deg-c", type=int, help="fix the centre-line degree (default: choose per lane by LOO)")
    p.add_argument("--max-deg", type=int, default=4, help="highest degree LOO considers (default 4)")
    p.add_argument("--deg-w", type=int, default=1)
    p.add_argument("--geom-rel", type=float, default=0.5,
                   help="centre-lines use peaks with prominence >= this x the lane's median peak (default 0.5)")
    a = p.parse_args()

    img = load(a.image)
    lanes = (read_lanes(a.lanes) if a.lanes else
             [(n, int(s), int(e)) for n, s, e in a.lane] if a.lane else DEFAULT_LANES)
    lanes = number_lanes(lanes)  # "1 ladder", "2 ...": numbered left to right so lanes can be referred to
    domain = (a.row_start, img.shape[0] - 1)
    stem = Path(a.image).stem
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)

    results = {}
    for name, start, end in lanes:
        r = fit_lane(img, start, end, a.row_start, domain, a.deg_c, a.deg_w, a.max_deg, a.geom_rel)
        results[name] = r
        straight, _ = straighten(r["region"], r["centre"], start, r["y_range"], fill=np.nan)
        fig = plot_lane(r["region"], start, r["points"], r["centre"], r["width"], r["centroid_fit"],
                        r["bands"], straight, f"{Path(a.image).name}: {name}, columns {start}–{end}",
                        a.deg_c, a.deg_w, y_range=r["y_range"])
        no, label = name.split(" ", 1)
        slug = f"{int(no):02d}_" + re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        fig.savefig(out / f"{stem}_lanes_{slug}.png", dpi=110)
        plt.close(fig)

    note = (f"centre degree fixed at {a.deg_c}" if a.deg_c is not None
            else f"centre degree chosen by LOO (max {a.max_deg})") + f", degree-{a.deg_w} width"
    ncoef = (a.deg_c if a.deg_c is not None else a.max_deg) + 1
    overlay_plot(img, lanes, results, Path(a.image).name, a.row_start).savefig(
        out / f"{stem}_lanes_overlay.png", dpi=110)
    summary_plot(results, domain, Path(a.image).name, note).savefig(out / f"{stem}_lanes_summary.png", dpi=120)

    with open(out / f"{stem}_lanes_summary.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["lane_no", "lane", "start", "end", "method", "n_bands", "rows_lo", "rows_hi", "degree",
                    *(f"loo_deg{d}" for d in range(len(next(iter(results.values()))["loo"]["edge"]))),
                    *(f"c{k}" for k in range(ncoef)), "lean_deg", "rms_px",
                    *(f"w{k}" for k in range(a.deg_w + 1)), "width_top", "width_bottom", "rms_width_px",
                    "spread_before", "spread_after_centroids", "spread_after_midpoints"])
        for (name, start, end) in lanes:
            r = results[name]
            for method, fit, rms, spread in (("centroid", r["centroid_fit"], r["rms_centroid"], r["spread_centroid"]),
                                             ("edge", r["centre"], r["rms_edge"], r["spread_edge"])):
                edge = method == "edge"
                no, label = name.split(" ", 1)
                w.writerow([no, label, start, end, method, len(r["bands"]), round(r["y_range"][0]), round(r["y_range"][1]),
                            r["deg"][method], *(round(e, 3) for e in r["loo"][method]),
                            *np.round(fit.coef, 3), *[""] * (ncoef - len(fit.coef)),
                            round(lean_deg(fit, domain), 2), round(rms, 3),
                            *(np.round(r["width"].coef, 3) if edge else [""] * (a.deg_w + 1)),
                            *((round(r["width"](r["y_range"][0]), 1), round(r["width"](r["y_range"][1]), 1),
                               round(r["rms_width"], 2)) if edge else ("", "", "")),
                            round(r["spread_before"], 2), round(spread[0], 2), round(spread[1], 2)])

    print(f"domain rows {domain[0]}–{domain[1]}; coefficients in px over half the domain "
          f"({(domain[1] - domain[0]) / 2:.0f} rows)\n")
    nloo = len(next(iter(results.values()))["loo"]["edge"])
    print("LOO error (px) by degree, interior bands; * = chosen")
    print(f"{'lane':<23} {'method':<9}" + "".join(f"{'deg' + str(d):>8}" for d in range(nloo)))
    for name, *_ in lanes:
        r = results[name]
        for method in ("centroid", "edge"):
            print(f"{name:<23} {method:<9}" + "".join(
                f"{e:7.2f}{'*' if d == r['deg'][method] else ' '}" for d, e in enumerate(r["loo"][method])))
    print()
    hdr = f"{'lane':<23} {'method':<9} {'bands':>5} {'rows':>9} {'deg':>3}  " + " ".join(f"{'c' + str(k):>7}" for k in range(ncoef))
    print(hdr + f" {'lean°':>6} {'RMS':>5}  {'spread before→after':>20}")
    for name, start, end in lanes:
        r = results[name]
        for method, fit, rms, spread in (("centroid", r["centroid_fit"], r["rms_centroid"], r["spread_centroid"]),
                                         ("edge", r["centre"], r["rms_edge"], r["spread_edge"])):
            print(f"{name:<23} {method:<9} {len(r['bands']):>5} {r['y_range'][0]:>4.0f}-{r['y_range'][1]:<4.0f} "
                  f"{r['deg'][method]:>3}  "
                  + " ".join(f"{c:7.2f}" for c in fit.coef) + " " * 8 * (ncoef - len(fit.coef))
                  + f" {lean_deg(fit, domain):6.2f} {rms:5.2f}  "
                  f"{r['spread_before']:7.1f} → {spread[0]:5.1f} / {spread[1]:5.1f}")
    print("\n(spread after = band centroids / band edge-midpoints, max − min across bands)")
    print(f"\n{'lane':<23} {'width top':>9} {'bottom':>7} {'width RMS':>9}")
    for name, *_ in lanes:
        r = results[name]
        print(f"{name:<23} {r['width'](r['y_range'][0]):9.1f} {r['width'](r['y_range'][1]):7.1f} {r['rms_width']:9.2f}")
    print()
    for name, r in results.items():
        print(f"{name}: bands at rows {[round(b['y']) for b in r['bands']]}")
    print(f"\n{out}/{stem}_lanes_summary.png  (+ per-lane figures, summary CSV)")


if __name__ == "__main__":
    main()
