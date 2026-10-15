"""Does reading profiles along each lane's fitted centre-line help?

The web page (and band_peaks.py) reads each lane's profile from a straight strip down
the middle CORE fraction of the lane. Lanes lean (gel_02: 1.6-3.2 degrees, i.e. 25-45 px
over the gel, against a 37 px strip), so a straight strip can drift off the bands at
the top or bottom. This compares three ways of placing the strip:

    straight   the lane's middle columns (current)
    centroid   following the centre-line fitted through band centroids (compare_lanes.py)
    edge       following the centre-line fitted to band edges (compare_lanes.py)

Same strip width, same band finding, same masses pipeline (band_masses.py --follow).

Profile quality, per lane: peaks found, and for peaks found by all three (within 3
rows) their median SNR and FWHM. Following should raise SNR and narrow peaks where the
straight strip drifts off the bands.

Masses: same-protein tests (chi-squared of one mass across lanes, on relative
uncertainties) for bands found in most lanes: lower = more consistent; the lane 5 / 11
triplet; running-correction match (correlation) and leftover alignment error; median
uncertainties.

--rotate DEG first rotates the gel by DEG degrees (as an image that wasn't straightened),
with the lanes carried along: each lane keeps its width, centred where its pixels went
(median column), and everything above --row-start in the original (labels) is whited
out so the rotated labels don't count as bands. Then the comparison runs on that.

Writes scoping/out/<image>_follow_compare.csv and _follow_strips.png.

Usage:
    python scoping/follow_centreline.py IMAGE --lanes FILE.csv [--row-start 140] [--rotate DEG]
"""

import argparse
import csv
import subprocess
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from band_masses import lane_centre  # noqa: E402
from band_peaks import find_bands  # noqa: E402
from ladder_centreline import extract, load  # noqa: E402
from lanes import read_lanes  # noqa: E402

MODES = ["straight", "centroid", "edge"]
WINDOWS = [(103, 107.5), (107.5, 112), (70, 78), (61, 67), (49, 55)]


def profile_metrics(img, lanes, row_start):
    per_lane, strips = [], {m: [] for m in MODES}
    for no, (name, start, end) in enumerate(lanes, 1):
        region = extract(img, start, end)
        found = {}
        for m in MODES:
            centre, deg = (None, None) if m == "straight" else lane_centre(img, start, end, row_start, m)
            bands, info = find_bands(region, row_start, centre=centre)
            found[m] = ([b for b in bands if b["kind"] == "peak"], deg)
            cx = info["centre_x"] if info["centre_x"] is not None else \
                np.full(len(info["rows"]), (sum(info["core_cols"]) - 1) / 2)
            strips[m].append((info["rows"], cx + start, info["core_cols"][1] - info["core_cols"][0]))
        common = [b for b in found["straight"][0]
                  if all(any(abs(c["y"] - b["y"]) <= 3 for c in found[m][0]) for m in MODES[1:])]
        row = {"lane_no": no, "lane": name}
        for m in MODES:
            peaks = found[m][0]
            match = [min(peaks, key=lambda c: abs(c["y"] - b["y"])) for b in common]
            row[f"{m}_peaks"] = len(peaks)
            row[f"{m}_snr"] = float(np.median([c["snr"] for c in match])) if match else np.nan
            row[f"{m}_fwhm"] = float(np.median([c["fwhm"] for c in match])) if match else np.nan
            row[f"{m}_height"] = float(np.median([c["height"] for c in match])) if match else np.nan
            if m != "straight":
                row[f"{m}_deg"] = found[m][1]
        rows, cx, _ = strips["straight"][-1]
        row["max_move_px"] = max(float(np.max(np.abs(strips[m][-1][1] - cx))) for m in MODES[1:])
        per_lane.append(row)
    return per_lane, strips


def mass_metrics(image, lanes_csv, row_start, n_lanes):
    out = Path(__file__).parent / "out"
    stem = Path(image).stem
    same = [x for lo, hi in WINDOWS for x in ("--same", str(lo), str(hi))]
    res = {}
    for m in MODES:
        args = [sys.executable, str(Path(__file__).parent / "band_masses.py"), image, "--lanes", lanes_csv,
                "--row-start", str(row_start), "--tag", f"_follow_{m}", *same,
                "--same-lanes", *map(str, range(2, n_lanes + 1)), "--ladder-strongest"]
        if m != "straight":
            args += ["--follow", m]
        run = subprocess.run(args, capture_output=True, text=True)
        if run.returncode != 0:
            res[m] = {"error": (run.stderr or run.stdout).strip().splitlines()[-1]}
            continue
        with open(out / f"{stem}_follow_{m}_masses.csv", newline="") as f:
            masses = list(csv.DictReader(f))
        with open(out / f"{stem}_follow_{m}_same_protein.csv", newline="") as f:
            same_rows = list(csv.DictReader(f))

        def triplet(lane):
            ks = [float(r["kDa"]) for r in masses if r["lane_no"] == lane and r["kDa"] and 36 <= float(r["kDa"]) <= 42]
            return sorted(ks, reverse=True)[:3]
        t5, t11 = triplet("5"), triplet("11")
        lanes_al = {r["lane_no"]: r for r in masses if r["align_corr"] and r["lane_no"] not in ("1", "2")}
        res[m] = {
            "same": {f"{r['lo_kDa']}-{r['hi_kDa']}": (float(r["chi2"]), int(r["dof"]), float(r["p"])) for r in same_rows},
            "triplet_5": t5, "triplet_11": t11,
            "triplet_max_diff": max(abs(a - b) for a, b in zip(t5, t11)) if len(t5) == len(t11) == 3 else np.nan,
            "align_corr_median": float(np.median([float(r["align_corr"]) for r in lanes_al.values()])),
            "align_sigma_median": float(np.median([float(r["align_sigma_rows"]) for r in lanes_al.values()])),
            "flagged": sum(r["align_ok"] == "False" for r in lanes_al.values()),
            "rel_pct_median": float(np.median([float(r["rel_pct"]) for r in masses if r["rel_pct"]])),
            "abs_pct_median": float(np.median([float(r["abs_pct"]) for r in masses if r["abs_pct"]])),
        }
    return res


def plot_strips(img, lanes, strips, row_start, title):
    fig, ax = plt.subplots(figsize=(14, 7.5))
    g = img / 65535
    ax.imshow(g, cmap="gray", vmin=np.percentile(g, 1), vmax=np.percentile(g, 99.5), aspect="auto")
    colours = {"straight": "#d62a2a", "centroid": "#2a78d6", "edge": "#e8730c"}
    for m in MODES:
        for rows, cx, width in strips[m]:
            for side in (-1, 1):
                ax.plot(cx + side * width / 2, rows, color=colours[m], lw=0.9,
                        ls="-" if m != "edge" else "--", label=m if side == 1 and rows is strips[m][0][0] else None)
    ax.axhline(row_start, color="0.5", lw=0.6, ls=":")
    ax.set_title(f"{title}: strip each profile is read from (edges), straight vs following the centre-line")
    ax.legend(loc="lower right")
    fig.tight_layout()
    return fig


def rotated_copy(image, lanes_csv, deg, row_start, out):
    """Rotated 16-bit PNG (labels whited out) and its lanes CSV; returns their paths."""
    img = load(image).astype(float)
    h, w = img.shape
    rot = ndimage.rotate(img, deg, reshape=True, order=1, cval=65535)
    src_row = ndimage.rotate(np.repeat(np.arange(h, dtype=float)[:, None], w, axis=1), deg, reshape=True,
                             order=0, cval=-1)
    rot[(src_row < row_start)] = 65535  # labels (and blank corners) white
    stem = Path(image).stem + f"_rot{deg:g}_masked"
    png = out / f"{stem}.png"
    Image.fromarray(np.clip(rot, 0, 65535).astype(np.uint16)).save(png)
    lanes = sorted(read_lanes(lanes_csv), key=lambda l: l[1])
    label = np.zeros((h, w))
    for k, (_, s, e) in enumerate(lanes, 1):
        label[row_start:, s:e + 1] = k
    rlab = ndimage.rotate(label, deg, reshape=True, order=0, cval=0)
    new_csv = out / f"{stem}_lanes.csv"
    with open(new_csv, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["name", "start", "end"])
        for k, (name, s, e) in enumerate(lanes, 1):
            mid = float(np.median(np.nonzero(rlab == k)[1]))
            half = (e - s) / 2
            wr.writerow([name, int(round(mid - half)), int(round(mid + half))])
    return str(png), str(new_csv)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--lanes", required=True)
    p.add_argument("--row-start", type=int, default=140)
    p.add_argument("--rotate", type=float, help="rotate the gel by this many degrees first")
    a = p.parse_args()
    if a.rotate:
        a.image, a.lanes = rotated_copy(a.image, a.lanes, a.rotate, a.row_start, Path(__file__).parent / "out")
        a.row_start = 0
        print(f"rotated by {a.rotate:g} degrees: {a.image}, lanes {a.lanes}\n")
    img = load(a.image)
    lanes = sorted(read_lanes(a.lanes), key=lambda l: (l[1] + l[2]) / 2)
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    stem = Path(a.image).stem

    per_lane, strips = profile_metrics(img, lanes, a.row_start)
    plot_strips(img, lanes, strips, a.row_start, Path(a.image).name).savefig(out / f"{stem}_follow_strips.png", dpi=110)
    with open(out / f"{stem}_follow_compare.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(per_lane[0].keys()))
        w.writeheader()
        w.writerows(per_lane)

    print("Profile quality (peaks found; median SNR / FWHM of peaks found by all three):")
    print(f"{'lane':>4} {'moved':>6}  " + "  ".join(f"{m:>22}" for m in MODES))
    for r in per_lane:
        cells = [f"{r[m + '_peaks']:>3} pk {r[m + '_snr']:6.1f} {r[m + '_fwhm']:5.1f}r"
                 + (f" d{r[m + '_deg']}" if m != "straight" and r.get(m + "_deg") is not None else "   ")
                 for m in MODES]
        print(f"{r['lane_no']:>4} {r['max_move_px']:5.1f}px  " + "  ".join(f"{c:>22}" for c in cells))
    for m in MODES:
        snr = np.nanmedian([r[m + "_snr"] for r in per_lane])
        fw = np.nanmedian([r[m + "_fwhm"] for r in per_lane])
        ratio = np.nanmedian([r[m + "_height"] / r["straight_height"] for r in per_lane])
        print(f"  {m:>9}: {sum(r[m + '_peaks'] for r in per_lane)} peaks, median SNR {snr:.1f}, median FWHM {fw:.2f} rows, "
              f"peak height x{ratio:.3f} of straight (median over lanes)")

    res = mass_metrics(a.image, a.lanes, a.row_start, len(lanes))
    print("\nMasses:")
    for m in MODES:
        r = res[m]
        if "error" in r:
            print(f"  {m:>9}: failed ({r['error']})")
            continue
        same = "  ".join(f"{k} kDa chi2 {c:.1f}/{d}" for k, (c, d, _) in r["same"].items())
        print(f"  {m:>9}: {same}")
        print(f"  {'':>9}  triplet 5 {r['triplet_5']} vs 11 {r['triplet_11']} (max diff {r['triplet_max_diff']:.1f} kDa); "
              f"running-correction corr median {r['align_corr_median']:.2f}, {r['flagged']} flagged, "
              f"leftover ±{r['align_sigma_median']:.1f} rows; uncertainty median ±{r['rel_pct_median']:.1f}% rel, "
              f"±{r['abs_pct_median']:.1f}% abs")
    print(out / f"{stem}_follow_compare.csv")
    print(out / f"{stem}_follow_strips.png")


if __name__ == "__main__":
    main()
