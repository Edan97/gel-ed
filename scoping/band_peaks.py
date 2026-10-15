"""Find bands in a lane by peak picking on its row profile.

Replaces the "keep peaks above 10% of the strongest band" rule, which drops faint
bands whenever a lane has one strong band (gel_02 lanes 5, 7, 11).

1. Profile: mean darkness per row over the central CORE fraction of the lane's
   columns. Using only the centre limits blurring from sloped bands, which otherwise
   merges close bands (lane 11's triplet).
   The profile is raw: no baseline is subtracted, so haze and smear stay in it.
2. Noise: robust spread (MAD) of the profile's wobble around a Gaussian-smoothed copy
   of itself (sigma = NOISE_ROWS / 6). Used only to set thresholds, never subtracted
   from the data. (A running median doesn't work here: on steadily rising or falling
   stretches it equals the profile exactly, so the noise comes out as zero.)
   Thresholds are multiples of it, so they scale with each lane's own noise, not
   with its strongest band.
3. Peaks: local maxima with prominence >= K x noise. Prominence is measured against
   the peak's own surroundings, so a band sitting on smear still counts by how far it
   rises above the smear.
4. Shoulders: bands merged into a neighbour don't form a maximum but still bend the
   profile, so they show up as peaks of the curvature (-d2/dy2). Kept if they rise
   >= K x noise above the lowest point within NOISE_ROWS/2 rows and are more than
   SEP rows from a peak.
5. Saturation: rows where at least SAT_FRAC of the central pixels are near black.
   A saturated band has a flat top; its edges look like shoulders, so shoulders
   touching saturated rows are dropped. Peaks are flagged "saturated".
6. Position uncertainty (sigma_y, rows) for each band:
   - peak: 1.5 x (FWHM / 2.355) / SNR, at least 0.25 rows. The usual precision of a
     peak position: sharper and stronger peaks are located better.
   - saturated peak: the flat top hides where the band's centre is, so sigma_y is at
     least the saturated run length / sqrt(12) (a uniform spread over the run).
   - shoulder: 2 rows. Located from curvature only; a judgement, not derived.

Rows above --row-start are ignored (manual annotation cutoff; see NOTES.md).

Usage:
    python scoping/band_peaks.py IMAGE --lanes FILE.csv [--row-start 140] [--core 0.25] [--k 6]
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from scipy import ndimage
from scipy import signal as ss

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lanes import number_lanes, read_lanes  # noqa: E402
from ladder_centreline import extract, load  # noqa: E402


def find_bands(region, row_start=0, core=0.25, smooth=1.0, noise_rows=61, k=6.0, sep=5,
               sat_level=0.03, sat_frac=0.2, centre=None):
    """Bands in one lane region (rows x columns, 0 black - 1 white).

    centre: optional x(row) in region columns (row = image row). The strip of central
    columns, same width, then follows it row by row (linear interpolation between
    columns, kept inside the region) instead of sitting in the middle of the lane.

    Returns (bands, info). Each band: {"y", "kind": "peak"|"shoulder", "height" (how far
    it rises above its surroundings), "snr" (height / noise), "saturated"}. info holds
    the raw profile, noise and saturated rows (indexed by image row) for plotting.
    """
    n = region.shape[1]
    c0, c1 = int(round(n * (1 - core) / 2)), int(round(n * (1 + core) / 2))
    centre_x = None
    if centre is None:
        centre = region[row_start:, c0:c1]
    else:
        width = c1 - c0
        rows = np.arange(row_start, region.shape[0])
        centre_x = np.clip(np.asarray(centre(rows), dtype=float), (width - 1) / 2, n - 1 - (width - 1) / 2)
        xs = centre_x[:, None] - (width - 1) / 2 + np.arange(width)[None, :]  # sample columns, per row
        x0 = np.clip(np.floor(xs).astype(int), 0, n - 2)
        t = xs - x0
        sub = region[row_start:]
        r = np.arange(sub.shape[0])[:, None]
        centre = sub[r, x0] * (1 - t) + sub[r, x0 + 1] * t
    dark = 1 - centre
    prof = ndimage.gaussian_filter1d(dark.mean(axis=1), smooth)
    wobble = prof - ndimage.gaussian_filter1d(prof, noise_rows / 6)  # for the noise estimate only
    noise = 1.4826 * np.median(np.abs(wobble - np.median(wobble)))
    saturated = (centre <= sat_level).mean(axis=1) >= sat_frac
    sat_near = ndimage.binary_dilation(saturated, iterations=sep)

    peaks, pinfo = ss.find_peaks(prof, prominence=k * noise, width=2)
    local_min = ndimage.minimum_filter1d(prof, size=noise_rows)
    curv = -ndimage.gaussian_filter1d(prof, 2.0, order=2)
    cnoise = 1.4826 * np.median(np.abs(curv - np.median(curv)))
    cpk, _ = ss.find_peaks(curv, prominence=k * cnoise)
    shoulders = [c for c in cpk
                 if prof[c] - local_min[c] > k * noise and not sat_near[c]
                 and (len(peaks) == 0 or np.min(np.abs(peaks - c)) > sep)]

    sat_runs, _ = ndimage.label(sat_near)
    bands = []
    for r, h, fwhm in zip(peaks, pinfo["prominences"], pinfo["widths"]):
        sigma = max(0.25, 1.5 * (fwhm / 2.355) / (h / noise))
        if sat_near[r]:
            sigma = max(sigma, (sat_runs == sat_runs[r]).sum() / np.sqrt(12))
        bands.append({"y": int(r) + row_start, "kind": "peak", "height": h, "snr": h / noise,
                      "saturated": bool(sat_near[r]), "fwhm": float(fwhm), "sigma_y": float(sigma)})
    bands += [{"y": int(r) + row_start, "kind": "shoulder", "height": prof[r] - local_min[r],
               "snr": (prof[r] - local_min[r]) / noise, "saturated": False,
               "fwhm": np.nan, "sigma_y": 2.0} for r in shoulders]
    bands.sort(key=lambda d: d["y"])
    rows = np.arange(row_start, region.shape[0])
    info = {"rows": rows, "profile": prof, "noise": noise,
            "saturated": rows[saturated], "core_cols": (c0, c1), "centre_x": centre_x}
    return bands, info


def plot_profiles(lanes, results, title):
    n = len(lanes)
    fig, axes = plt.subplots(1, n, figsize=(2.0 * n + 1, 10), sharey=True)
    blue, orange, red, grey = "#2a78d6", "#e8730c", "#d62a2a", "#888888"
    for ax, (name, start, end) in zip(axes, lanes):
        bands, info = results[name]
        rows = info["rows"]
        prof = info["profile"] - info["profile"].min()  # display only: lane's palest row at 0
        ax.plot(prof, rows, color=blue, lw=0.9)
        for d in bands:
            i = d["y"] - rows[0]
            if d["kind"] == "peak":
                ax.plot(prof[i], d["y"], "o", ms=5, mfc="none",
                        mec=red if not d["saturated"] else "black")
            else:
                ax.plot(prof[i], d["y"], ">", ms=6, color=orange)
        if len(info["saturated"]):
            ax.plot(np.full(len(info["saturated"]), ax.get_xlim()[0]), info["saturated"], "|",
                    color="black", ms=4)
        # linear near zero, logarithmic for large values: faint and saturated bands both readable
        ax.set_xscale("asinh", linear_width=10 * info["noise"])
        ax.set_title(name.replace(" ", "\n", 1), fontsize=9)
        ax.set_xlabel("darkness above palest row\n(asinh scale)", fontsize=8)
        ax.tick_params(labelsize=7)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
    axes[0].invert_yaxis()
    axes[0].set_ylabel("Row (px)")
    axes[0].plot([], [], color=blue, lw=0.9, label="profile (central columns)")
    axes[0].plot([], [], "o", ms=5, mfc="none", mec=red, label="peak")
    axes[0].plot([], [], "o", ms=5, mfc="none", mec="black", label="peak (saturated)")
    axes[0].plot([], [], ">", ms=6, color=orange, label="shoulder")
    axes[0].legend(fontsize=7, loc="lower left")
    fig.suptitle(title)
    fig.tight_layout()
    return fig


def plot_overlay(img, lanes, results, title, row_start):
    red, orange, blue = "#d62a2a", "#e8730c", "#1f4e8c"
    fig, ax = plt.subplots(figsize=(20, 11))
    ax.imshow(img, cmap="gray", vmin=0, vmax=65535)
    ax.axhline(row_start, color=red, lw=0.8, ls=":")
    for name, start, end in lanes:
        bands, info = results[name]
        c0, c1 = info["core_cols"]
        ax.axvspan(start + c0 - 0.5, start + c1 - 0.5, color=blue, alpha=0.06, lw=0)
        for d in bands:
            if d["kind"] == "peak":
                ax.plot([start, end], [d["y"], d["y"]], color=red if not d["saturated"] else "black",
                        lw=0.8, alpha=0.8)
            else:
                ax.plot([start, end], [d["y"], d["y"]], color=orange, lw=0.8, ls="--")
        no = name.split(" ", 1)[0]
        ax.text((start + end) / 2, row_start + 4, f"{no}\n{len(bands)}", ha="center", va="top",
                fontsize=10, fontweight="bold", color=blue,
                bbox=dict(boxstyle="round,pad=0.25", fc="white", ec=blue, lw=1))
    ax.plot([], [], color=red, lw=0.8, label="peak")
    ax.plot([], [], color="black", lw=0.8, label="peak (saturated)")
    ax.plot([], [], color=orange, lw=0.8, ls="--", label="shoulder")
    ax.legend(loc="lower right", fontsize=8, framealpha=0.9)
    ax.set(title=f"{title}  ·  label: lane number / bands found  ·  shaded = central columns used",
           xlabel="Column (px)", ylabel="Row (px)")
    fig.tight_layout()
    return fig


def plot_profiles_on_gel(img, lanes, results, title, row_start):
    """Each lane's profile drawn inside its own columns on the gel, rows aligned with the image.

    Horizontal position within the lane = darkness on an asinh scale (linear near zero,
    logarithmic for large values), normalised per lane: left edge of the lane = 0,
    90% of the lane width = that lane's darkest row. Nothing else is drawn on the gel:
    no shading, grid or boxes. Lane numbers sit above the image, the legend below it.
    """
    blue, orange, red, grey = "#2a78d6", "#e8730c", "#d62a2a", "#555555"
    fig, ax = plt.subplots(figsize=(24, 13))
    ax.imshow(img, cmap="gray", vmin=0, vmax=65535)
    for name, start, end in lanes:
        bands, info = results[name]
        rows = info["rows"]
        prof = info["profile"] - info["profile"].min()  # display only: lane's palest row at the lane edge
        lw = 10 * info["noise"]
        scale = lambda v: np.arcsinh(np.maximum(v, 0) / lw)  # noqa: E731
        top = scale(prof.max()) or 1
        x = lambda v: start + 0.9 * (end - start) * scale(v) / top  # noqa: E731
        ax.plot(x(prof), rows, color=blue, lw=1.1)
        for d in bands:
            i = d["y"] - rows[0]
            if d["kind"] == "peak":
                ax.plot(x(prof[i]), d["y"], "o", ms=6, mfc="none", mew=1.4,
                        mec="black" if d["saturated"] else red)
            else:
                ax.plot(x(prof[i]), d["y"], ">", ms=7, color=orange)
        no = name.split(" ", 1)[0]
        ax.text((start + end) / 2, -8, no, ha="center", va="bottom", fontsize=13,
                fontweight="bold", color="#1f4e8c", clip_on=False)
    ax.plot([], [], color=blue, lw=1.1, label="profile (central columns)")
    ax.plot([], [], "o", ms=6, mfc="none", mec=red, label="peak")
    ax.plot([], [], "o", ms=6, mfc="none", mec="black", label="peak (saturated)")
    ax.plot([], [], ">", ms=7, color=orange, label="shoulder")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.05), ncol=4, fontsize=9, frameon=False)
    ax.set_yticks(np.arange(0, img.shape[0], 50))
    ax.set_title(f"{title}  ·  profiles drawn in each lane (darker → further right, asinh scale, per-lane)",
                 pad=28)
    ax.set(xlabel="Column (px)", ylabel="Row (px)")
    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--lanes", required=True, help="CSV of lanes (name,start,end)")
    p.add_argument("--row-start", type=int, default=140, help="manual annotation cutoff (default 140)")
    p.add_argument("--core", type=float, default=0.25, help="central fraction of lane columns used (default 0.25)")
    p.add_argument("--k", type=float, default=6.0, help="threshold in multiples of noise (default 6)")
    p.add_argument("--noise-rows", type=int, default=61,
                   help="window (rows) for the noise estimate and shoulder test (default 61)")
    a = p.parse_args()

    img = load(a.image)
    lanes = number_lanes(read_lanes(a.lanes))
    results = {}
    for name, start, end in lanes:
        results[name] = find_bands(extract(img, start, end), a.row_start, core=a.core, k=a.k,
                                   noise_rows=a.noise_rows)

    stem = Path(a.image).stem
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    title = Path(a.image).name
    plot_profiles(lanes, results, f"{title}: lane profiles").savefig(out / f"{stem}_peaks_profiles.png", dpi=110)
    plot_overlay(img, lanes, results, title, a.row_start).savefig(out / f"{stem}_peaks_overlay.png", dpi=110)
    plot_profiles_on_gel(img, lanes, results, title, a.row_start).savefig(
        out / f"{stem}_peaks_gel_profiles.png", dpi=110)

    for name, *_ in lanes:
        bands, info = results[name]
        marks = " ".join(f"{d['y']}{'s' if d['kind'] == 'shoulder' else ''}{'*' if d['saturated'] else ''}"
                         for d in bands)
        print(f"{name:<23} noise {info['noise']:.4f}  {len(bands):2} bands: {marks}")
    print("(s = shoulder, * = saturated)")
    print(out / f"{stem}_peaks_overlay.png")
    print(out / f"{stem}_peaks_profiles.png")
    print(out / f"{stem}_peaks_gel_profiles.png")


if __name__ == "__main__":
    main()
