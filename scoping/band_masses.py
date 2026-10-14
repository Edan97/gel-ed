"""Estimate band masses from a single ladder, correcting for uneven running between lanes.

1. Bands: band_peaks.find_bands on every lane (raw profiles, peaks + shoulders).
2. Ladder: the ladder lane's bands, matched in order to --ladder-kda (top = largest).
   If the count doesn't match, it stops and lists the rows found; pass --ladder-rows
   to choose them by hand.
3. Calibration: log10(kDa) against row, interpolated point-to-point between ladder
   bands (PCHIP: smooth, passes through every ladder band, never doubles back).
   No extrapolation: bands above the top or below the bottom ladder band are reported
   as "> top" / "< bottom".
4. Running correction. With one ladder, every lane would otherwise be read as if it
   ran exactly like the ladder; on gel_02 the same triplet sits 40 rows higher on the
   right of the gel (~7% apparent mass difference). Each lane's rows are mapped onto a
   reference lane (--ref-lane, default: the lane next to the ladder) by a shift and a
   slight stretch, chosen to best match where the two profiles rise and fall. The
   match uses a compressed (asinh) slope of each profile so faint and strong lanes
   compare; that transform is only for matching, never applied to the data.
   ASSUMPTION: the reference lane ran like the ladder. The ladder shares no bands
   with the samples, so this can't be checked on the gel itself.
   Lanes whose match correlation is below --min-corr are flagged as uncertain.
5. Uncertainty, in log10(kDa), from three sources:
   - position: each band's sigma_y (band_peaks.find_bands), scaled by the stretch.
   - running correction: after alignment, each lane's clear peaks are paired with the
     reference lane's (nearest within 10 rows); their leftover mismatch, minus what
     position errors alone explain, is the lane's alignment error (rows). Lanes with
     fewer than 3 pairs get the largest value seen on the gel.
   - calibration: leave-one-out on the ladder (drop an interior ladder band, predict
     its mass from the rest), interpolated by row. Conservative: dropping a band
     doubles the gap the curve has to bridge.
   Rows convert to mass through the local slope of the calibration curve.
   "relative" = position + running correction: use it to compare bands on the same
   gel (the calibration error is shared by every lane, so it can't make them differ).
   "absolute" = relative + calibration: use it for a band's mass on its own.
   Not included (can't be estimated from one gel): the ladder band-to-size assignment
   and the assumption that the reference lane ran like the ladder.
6. Same-protein test (--same LO HI [--same LO HI ...] --same-lanes N ...): for each
   window, in each listed lane, the strongest peak with mass in LO..HI kDa. Reports the
   weighted mean and a chi-squared test of whether they agree within their relative
   uncertainties. Writes <image>_same_protein.csv, one figure per window, and a zoomed
   view of the gel around the picked bands (contrast stretched for display only).
   Lanes whose running correction is flagged (corr < --min-corr) are marked "?": the
   alignment may have paired the wrong bands, which the uncertainty does not cover
   (the leftover mismatch is small under a wrong pairing too). Group membership of
   those lanes is not reliable.

Rows above --row-start are ignored (manual annotation cutoff; see NOTES.md).

Usage:
    python scoping/band_masses.py IMAGE --lanes FILE.csv
        [--ladder-kda 220 120 100 80 60 50 40 30 20] [--ladder-lane 1] [--ref-lane 2]
        [--ladder-rows R ...] [--no-align] [--row-start 140]
        [--same LO HI [--same LO HI ...] --same-lanes N ...]
"""

import argparse
import csv
import sys
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
from scipy import ndimage
from scipy.interpolate import PchipInterpolator
from scipy.stats import chi2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from band_peaks import find_bands  # noqa: E402
from lanes import read_lanes  # noqa: E402
from ladder_centreline import extract, load  # noqa: E402

DEFAULT_KDA = [220, 120, 100, 80, 60, 50, 40, 30, 20]


def match_signal(info):
    """Slope of the asinh-compressed profile: where it rises and falls, at comparable scale."""
    p = info["profile"]
    q = np.arcsinh((p - p.min()) / (10 * info["noise"]))
    return ndimage.gaussian_filter1d(q, 2, order=1)


def align(sig, ref, rows, shifts=range(-100, 101), stretches=np.arange(0.90, 1.101, 0.01)):
    """Best (shift, stretch, corr) mapping lane row y -> reference row (y - c)*stretch + c + shift."""
    c = rows.mean()
    best = (-np.inf, 0, 1.0)
    for b in stretches:
        for s in shifts:
            yr = (rows - c) * b + c + s
            ok = (yr >= rows[0]) & (yr <= rows[-1])
            if ok.sum() < len(rows) // 2:
                continue
            r = np.corrcoef(sig[ok], np.interp(yr[ok], rows, ref))[0, 1]
            if r > best[0]:
                best = (r, s, b)
    corr, shift, stretch = best
    return {"shift": shift, "stretch": stretch, "corr": corr, "centre": c}


def to_ref(y, a):
    return (y - a["centre"]) * a["stretch"] + a["centre"] + a["shift"]


def alignment_sigma(bands, ref_bands, max_gap=10, min_pairs=3):
    """Leftover row mismatch between a lane's clear peaks (in reference rows) and the
    reference lane's, after removing what position errors explain. (sigma, pairs)."""
    clear = lambda bs: [d for d in bs if d["kind"] == "peak" and not d["saturated"]]  # noqa: E731
    ref = clear(ref_bands)
    if not ref:
        return None, 0
    ref_y = np.array([e["y"] for e in ref], dtype=float)
    diffs, var = [], []
    for d in clear(bands):
        j = int(np.argmin(np.abs(ref_y - d["y_ref"])))
        if abs(ref_y[j] - d["y_ref"]) <= max_gap:
            diffs.append(d["y_ref"] - ref_y[j])
            var.append(d["sigma_y"] ** 2 + ref[j]["sigma_y"] ** 2)
    if len(diffs) < min_pairs:
        return None, len(diffs)
    excess = np.mean(np.square(diffs)) - np.mean(var)
    return float(np.sqrt(max(excess, 0.0))), len(diffs)


def ladder_loo(rows, kda):
    """Leave-one-out error of the ladder curve at each interior ladder band (log10 kDa)."""
    lg = np.log10(kda)
    errs = [abs(PchipInterpolator(np.delete(rows, i), np.delete(lg, i))(rows[i]) - lg[i])
            for i in range(1, len(rows) - 1)]
    return rows[1:-1], np.array(errs)


def pct(sigma_log):
    """log10 uncertainty -> percent of mass."""
    return 100 * (10 ** sigma_log - 1)


def same_protein(results, lanes_no, lo, hi):
    """Strongest peak in lo..hi kDa per lane; weighted mean and chi-squared on relative errors."""
    picks = {}
    for no in lanes_no:
        cand = [d for d in results[no]["bands"] if not np.isnan(d["kda"]) and lo <= d["kda"] <= hi]
        peaks = [d for d in cand if d["kind"] == "peak"] or cand
        if peaks:
            picks[no] = max(peaks, key=lambda d: d["snr"])
    if len(picks) < 2:
        return None
    lg = np.array([np.log10(d["kda"]) for d in picks.values()])
    sd = np.array([d["sig_rel"] for d in picks.values()])
    w = 1 / sd ** 2
    mean = (w * lg).sum() / w.sum()
    sd_mean = 1 / np.sqrt(w.sum())
    stat = (((lg - mean) / sd) ** 2).sum()
    dof = len(lg) - 1
    return {"picks": picks, "mean_kda": 10 ** mean, "sd_mean_log": sd_mean, "chi2": stat, "dof": dof,
            "p": float(chi2.sf(stat, dof)), "z": dict(zip(picks, (lg - mean) / sd)), "lo": lo, "hi": hi}


def plot_same(test, results, cal_at, title):
    fig, ax = plt.subplots(figsize=(8, 4.5))
    nos = list(test["picks"])
    x = np.arange(len(nos))
    m = np.array([test["picks"][n]["kda"] for n in nos])
    rel = np.array([test["picks"][n]["sig_rel"] for n in nos])
    lo_err = m - m / 10 ** rel
    hi_err = m * 10 ** rel - m
    mean = test["mean_kda"]
    band = mean * (10 ** test["sd_mean_log"] - 1)
    ax.axhspan(mean - band, mean + band, color="#2a78d6", alpha=0.12, lw=0)
    ax.axhline(mean, color="#2a78d6", lw=1, label=f"weighted mean {mean:.1f} kDa")
    ax.errorbar(x, m, yerr=[lo_err, hi_err], fmt="o", color="#222222", ms=6, capsize=4, lw=1.2,
                label="band ± relative uncertainty (1σ)")
    ax.set_xticks(x)
    ax.set_xticklabels([f"lane {n}\nrow {test['picks'][n]['y']}" for n in nos], fontsize=8)
    cal = pct(cal_at(np.log10(mean)))
    ax.set(ylabel="kDa", title=f"{title}: same protein? {test['lo']:g}–{test['hi']:g} kDa\n"
                               f"χ² = {test['chi2']:.1f} on {test['dof']} dof, p = {test['p']:.2g}  ·  "
                               f"calibration adds ±{cal:.0f}% to all, equally")
    ax.legend(fontsize=8, loc="best")
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    fig.tight_layout()
    return fig


def plot_same_zoom(img, lane_cols, tests, title, pad=40, flagged=()):
    """The gel around the picked bands, one colour per window. Contrast is stretched to the
    crop's 1st-99th percentile for display only."""
    colours = ["#2a78d6", "#e8730c", "#1a9e5f", "#b03a9c"]
    picks = [(no, d) for t in tests for no, d in t["picks"].items()]
    nos = sorted({no for no, _ in picks})
    c0, c1 = lane_cols[nos[0]][0], lane_cols[nos[-1]][1]
    r0 = max(0, min(d["y"] for _, d in picks) - pad)
    r1 = min(img.shape[0] - 1, max(d["y"] for _, d in picks) + pad)
    crop = img[r0:r1 + 1, c0:c1 + 1].astype(float)
    lo, hi = np.percentile(crop, [1, 99])
    fig, ax = plt.subplots(figsize=(16, 5))
    ax.imshow(crop, cmap="gray", vmin=lo, vmax=hi, extent=(c0 - 0.5, c1 + 0.5, r1 + 0.5, r0 - 0.5),
              aspect="auto")
    halo = [pe.withStroke(linewidth=2.5, foreground="white")]
    for t, colour in zip(tests, colours):
        for no, d in t["picks"].items():
            s, e = lane_cols[no]
            ax.plot([s + 0.1 * (e - s), e - 0.1 * (e - s)], [d["y"], d["y"]], color=colour, lw=1.5)
            ax.text(e - 0.1 * (e - s), d["y"], f" {d['kda']:.1f}", color=colour, fontsize=8,
                    va="center", path_effects=halo)
        ax.plot([], [], color=colour, lw=1.5,
                label=f"{t['lo']:g}–{t['hi']:g} kDa: mean {t['mean_kda']:.1f}, p = {t['p']:.2g}")
    for no in nos:
        s, e = lane_cols[no]
        ax.text((s + e) / 2, r0 - 2, f"{no}{' ?' if no in flagged else ''}", ha="center", va="bottom",
                fontsize=11, fontweight="bold", color="#d62a2a" if no in flagged else "#1f4e8c",
                clip_on=False)
    ax.legend(loc="lower right", fontsize=8, framealpha=0.9)
    ax.set_title(f"{title}: picked bands (contrast stretched for display)  ·  "
                 f"? = running correction uncertain: group membership not reliable", pad=20)
    ax.set(xlabel="Column (px)", ylabel="Row (px)")
    fig.tight_layout()
    return fig


def plot_masses(img, lanes, results, ladder_no, ladder, title):
    red, orange, blue = "#d62a2a", "#e8730c", "#1f4e8c"
    halo = [pe.withStroke(linewidth=2.5, foreground="white")]  # readable on pale gel and black bands
    fig, ax = plt.subplots(figsize=(24, 13))
    ax.imshow(img, cmap="gray", vmin=0, vmax=65535)
    for no, (name, start, end) in enumerate(lanes, 1):
        r = results[no]
        for d in r["bands"]:
            colour = orange if d["kind"] == "shoulder" else ("black" if d["saturated"] else red)
            ax.plot([start + 0.55 * (end - start), end - 4], [d["y"], d["y"]], color=colour, lw=1,
                    path_effects=halo)
            ax.text(start + 0.53 * (end - start), d["y"], d["label"], ha="right", va="center",
                    fontsize=8, color=colour, fontweight="bold", path_effects=halo)
        flag = "" if no == ladder_no or r["align"] is None or r["align"]["ok"] else " ?"
        ax.text((start + end) / 2, -8, f"{no}{flag}", ha="center", va="bottom", fontsize=13,
                fontweight="bold", color=red if flag else blue, clip_on=False)
    ax.plot([], [], color=red, lw=1, label="peak")
    ax.plot([], [], color="black", lw=1, label="peak (saturated)")
    ax.plot([], [], color=orange, lw=1, label="shoulder")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.05), ncol=3, fontsize=9, frameon=False)
    ax.set_yticks(np.arange(0, img.shape[0], 50))
    ax.set_title(f"{title}  ·  estimated kDa (ladder lane {ladder_no}: "
                 f"{', '.join(f'{k:g}' for k in ladder['kda'])})  ·  ? = uncertain running correction",
                 pad=28)
    ax.set(xlabel="Column (px)", ylabel="Row (px)")
    fig.tight_layout()
    return fig


def plot_calibration(ladder, results, lanes, ladder_no, title):
    fig, ax = plt.subplots(figsize=(8, 6))
    y, k = ladder["rows"], ladder["kda"]
    ys = np.linspace(y.min(), y.max(), 300)
    ax.plot(ys, 10 ** ladder["curve"](ys), color="#2a78d6", lw=1.5, label="point-to-point (PCHIP)")
    cubic = np.polynomial.Polynomial.fit(y, np.log10(k), 3)
    ax.plot(ys, 10 ** cubic(ys), color="#888888", lw=1, ls="--", label="cubic (for comparison)")
    ax.plot(y, k, "o", color="black", ms=6, label="ladder bands")
    for no in results:
        if no == ladder_no:
            continue
        for d in results[no]["bands"]:
            if not np.isnan(d["kda"]):
                ax.plot(d["y_ref"], d["kda"], "|", color="#e8730c", ms=8, alpha=0.6)
    ax.plot([], [], "|", color="#e8730c", ms=8, label="sample bands (aligned rows)")
    ax.set_yscale("log")
    ax.set_yticks(k)
    ax.set_yticklabels([f"{v:g}" for v in k])
    ax.minorticks_off()
    ax.set(xlabel="Row (px, reference frame)", ylabel="kDa", title=f"{title}: ladder calibration")
    ax.legend(fontsize=8)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--lanes", required=True, help="CSV of lanes (name,start,end)")
    p.add_argument("--ladder-kda", type=float, nargs="+", default=DEFAULT_KDA,
                   help="ladder sizes, top of gel first (default: 220 120 100 80 60 50 40 30 20)")
    p.add_argument("--ladder-lane", type=int, default=1, help="ladder lane number (default 1)")
    p.add_argument("--ladder-rows", type=float, nargs="+",
                   help="ladder band rows to use, top first (default: as found)")
    p.add_argument("--ref-lane", type=int, help="lane assumed to have run like the ladder "
                                                "(default: the lane next to the ladder)")
    p.add_argument("--no-align", action="store_true", help="skip the running correction")
    p.add_argument("--min-corr", type=float, default=0.5, help="flag alignments below this (default 0.5)")
    p.add_argument("--row-start", type=int, default=140, help="manual annotation cutoff (default 140)")
    p.add_argument("--same", type=float, nargs=2, metavar=("LO", "HI"), action="append",
                   help="same-protein test: kDa window (repeat for several windows)")
    p.add_argument("--same-lanes", type=int, nargs="+", help="lanes for the same-protein test")
    a = p.parse_args()
    if bool(a.same) != bool(a.same_lanes):
        p.error("--same and --same-lanes go together")

    img = load(a.image)
    lanes = sorted(read_lanes(a.lanes), key=lambda l: (l[1] + l[2]) / 2)
    results = {}
    for no, (name, start, end) in enumerate(lanes, 1):
        bands, info = find_bands(extract(img, start, end), a.row_start)
        results[no] = {"name": name, "bands": bands, "info": info, "align": None}

    # ladder
    kda = np.array(a.ladder_kda, dtype=float)
    lad_rows = (np.array(a.ladder_rows, dtype=float) if a.ladder_rows else
                np.array([d["y"] for d in results[a.ladder_lane]["bands"]], dtype=float))
    if len(lad_rows) != len(kda):
        sys.exit(f"Ladder lane {a.ladder_lane}: found {len(lad_rows)} bands at rows "
                 f"{[int(r) for r in lad_rows]} but {len(kda)} sizes were given.\n"
                 f"Choose rows with --ladder-rows (top first), one per size.")
    ladder = {"rows": lad_rows, "kda": kda, "curve": PchipInterpolator(lad_rows, np.log10(kda))}

    # running correction
    ref_no = a.ref_lane or (a.ladder_lane + 1 if a.ladder_lane < len(lanes) else a.ladder_lane - 1)
    rows = results[ref_no]["info"]["rows"]
    ref_sig = match_signal(results[ref_no]["info"])
    for no, r in results.items():
        if no == a.ladder_lane or a.no_align:
            continue
        al = align(match_signal(r["info"]), ref_sig, rows) if no != ref_no else \
            {"shift": 0, "stretch": 1.0, "corr": 1.0, "centre": rows.mean()}
        al["ok"] = al["corr"] >= a.min_corr
        r["align"] = al

    # masses
    lo, hi = lad_rows.min(), lad_rows.max()
    for no, r in results.items():
        for d in r["bands"]:
            d["y_ref"] = to_ref(d["y"], r["align"]) if r["align"] else float(d["y"])
            inside = lo <= d["y_ref"] <= hi
            d["kda"] = float(10 ** ladder["curve"](d["y_ref"])) if inside else np.nan
            d["kda_unaligned"] = float(10 ** ladder["curve"](d["y"])) if lo <= d["y"] <= hi else np.nan
            # in/out of range is decided by row, not by the interpolated mass (avoids rounding at the ends)
            if inside:
                d["label"] = f"{d['kda']:.0f}"
            else:
                d["label"] = f">{kda.max():g}" if d["y_ref"] < lo else f"<{kda.min():g}"

    # uncertainty
    for no, r in results.items():
        if r["align"] and no != ref_no:
            r["sig_align"], r["align_pairs"] = alignment_sigma(r["bands"], results[ref_no]["bands"])
        else:
            r["sig_align"], r["align_pairs"] = 0.0, None
    seen = [r["sig_align"] for r in results.values() if r["sig_align"] is not None]
    worst = max(seen) if seen else 0.0
    for r in results.values():
        r["sig_align_fallback"] = r["sig_align"] is None
        if r["sig_align"] is None:
            r["sig_align"] = worst
    loo_rows, loo_err = ladder_loo(lad_rows, kda)
    cal_rows = lambda y: np.interp(y, loo_rows, loo_err)  # noqa: E731  (log10, by reference row)
    slope = ladder["curve"].derivative()
    for no, r in results.items():
        stretch = r["align"]["stretch"] if r["align"] else 1.0
        for d in r["bands"]:
            if np.isnan(d["kda"]):
                d["sig_rel"] = d["sig_abs"] = np.nan
                continue
            rows_sd = np.hypot(d["sigma_y"] * stretch, r["sig_align"])
            d["sig_rel"] = float(abs(slope(d["y_ref"])) * rows_sd)
            d["sig_abs"] = float(np.hypot(d["sig_rel"], cal_rows(d["y_ref"])))
            d["label"] = f"{d['kda']:.0f}±{d['kda'] * (10 ** d['sig_abs'] - 1):.0f}"
    # calibration error as a function of log10(kDa), for the same-protein figure
    cal_at = lambda lgm: np.interp(lgm, np.log10(kda[1:-1])[::-1], loo_err[::-1])  # noqa: E731

    stem = Path(a.image).stem
    out = Path(__file__).parent / "out"
    out.mkdir(exist_ok=True)
    title = Path(a.image).name
    plot_masses(img, [(r["name"], *l[1:]) for r, l in zip(results.values(), lanes)], results,
                a.ladder_lane, ladder, title).savefig(out / f"{stem}_masses.png", dpi=110)
    plot_calibration(ladder, results, lanes, a.ladder_lane, title).savefig(
        out / f"{stem}_calibration.png", dpi=120)

    with open(out / f"{stem}_masses.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["lane_no", "lane", "row", "kind", "saturated", "snr", "sigma_row", "row_ref", "kDa",
                    "rel_pct", "abs_pct", "label", "kDa_uncorrected", "align_shift", "align_stretch",
                    "align_corr", "align_ok", "align_sigma_rows", "align_pairs"])
        for no, r in results.items():
            al = r["align"] or {}
            for d in r["bands"]:
                has = not np.isnan(d["kda"])
                w.writerow([no, r["name"], d["y"], d["kind"], d["saturated"], round(d["snr"], 1),
                            round(d["sigma_y"], 2), round(d["y_ref"], 1), round(d["kda"], 1) if has else "",
                            round(pct(d["sig_rel"]), 1) if has else "", round(pct(d["sig_abs"]), 1) if has else "",
                            d["label"], "" if np.isnan(d["kda_unaligned"]) else round(d["kda_unaligned"], 1),
                            al.get("shift", ""), round(al["stretch"], 2) if al else "",
                            round(al["corr"], 2) if al else "", al.get("ok", ""),
                            round(r["sig_align"], 2), r["align_pairs"] if r["align_pairs"] is not None else ""])

    print(f"ladder lane {a.ladder_lane}: " + ", ".join(f"row {int(y)} = {k:g}" for y, k in zip(lad_rows, kda)))
    print(f"running correction: reference lane {ref_no} (assumed to have run like the ladder)\n")
    for no, r in results.items():
        al = r["align"]
        head = f"{no:>2} {r['name']:<20}"
        if al:
            head += f" shift {al['shift']:+4d} stretch {al['stretch']:.2f} corr {al['corr']:.2f}{'' if al['ok'] else ' ?'}"
            head += (f"  align ±{r['sig_align']:.1f} rows"
                     + (" (too few pairs: gel's largest used)" if r["sig_align_fallback"] else
                        f" ({r['align_pairs']} pairs)" if r["align_pairs"] else ""))
        print(head)
        print("     " + "  ".join(f"{d['y']}{'s' if d['kind'] == 'shoulder' else ''}{'*' if d['saturated'] else ''}"
                                 f"→{d['label']}" for d in r["bands"]))
    print("\n(row→kDa±absolute; s = shoulder, * = saturated, ? = uncertain running correction)")
    print("calibration (ladder leave-one-out): " +
          ", ".join(f"{k:g} kDa ±{pct(e):.0f}%" for k, e in zip(kda[1:-1], loo_err)))

    if a.same:
        tests = []
        for lo_kda, hi_kda in a.same:
            test = same_protein(results, a.same_lanes, lo_kda, hi_kda)
            if test is None:
                print(f"\nsame-protein test: fewer than 2 lanes have a band in {lo_kda:g}–{hi_kda:g} kDa")
                continue
            tests.append(test)
            print(f"\nsame-protein test, {lo_kda:g}–{hi_kda:g} kDa, lanes {a.same_lanes}:")
            for no, d in test["picks"].items():
                flagged = results[no]["align"] is not None and not results[no]["align"]["ok"]
                test.setdefault("flagged", []).append(no) if flagged else None
                print(f"  lane {no:>2} row {d['y']:>4}: {d['kda']:6.1f} kDa ±{pct(d['sig_rel']):.2f}% rel"
                      f"  (z = {test['z'][no]:+.1f})" + ("  ? alignment uncertain" if flagged else ""))
            test["abs_pct"] = pct(np.hypot(test["sd_mean_log"], cal_at(np.log10(test["mean_kda"]))))
            print(f"  weighted mean {test['mean_kda']:.1f} kDa ±{pct(test['sd_mean_log']):.2f}% rel, "
                  f"±{test['abs_pct']:.0f}% abs")
            print(f"  chi² = {test['chi2']:.1f} on {test['dof']} dof, p = {test['p']:.2g}  "
                  f"({'consistent with one mass' if test['p'] >= 0.05 else 'NOT consistent with one mass'} at 5%)")
            fig = plot_same(test, results, cal_at, title)
            fig.savefig(out / f"{stem}_same_protein_{lo_kda:g}-{hi_kda:g}.png", dpi=130)
            plt.close(fig)
        if tests:
            with open(out / f"{stem}_same_protein.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["lo_kDa", "hi_kDa", "lanes", "rows", "kDa", "mean_kDa", "rel_pct_mean",
                            "abs_pct_mean", "chi2", "dof", "p", "flagged_lanes"])
                for t in tests:
                    w.writerow([t["lo"], t["hi"], " ".join(map(str, t["picks"])),
                                " ".join(str(d["y"]) for d in t["picks"].values()),
                                " ".join(f"{d['kda']:.1f}" for d in t["picks"].values()),
                                round(t["mean_kda"], 2), round(pct(t["sd_mean_log"]), 3),
                                round(t["abs_pct"], 1), round(t["chi2"], 2), t["dof"], f"{t['p']:.3g}",
                                " ".join(map(str, t.get("flagged", [])))])
            lane_cols = {no: l[1:] for no, l in enumerate(lanes, 1)}
            flagged = {no for no, r in results.items() if r["align"] is not None and not r["align"]["ok"]}
            plot_same_zoom(img, lane_cols, tests, title, flagged=flagged).savefig(out / f"{stem}_same_protein_zoom.png", dpi=130)
            print(out / f"{stem}_same_protein.csv")
            print(out / f"{stem}_same_protein_zoom.png")
    print(out / f"{stem}_masses.png")
    print(out / f"{stem}_calibration.png")
    print(out / f"{stem}_masses.csv")


if __name__ == "__main__":
    main()
