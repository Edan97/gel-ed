"""Regenerate every scoping output from the sample images, then check key results.

Clears scoping/out/, runs each script in order with this Python, and stops at the
first failure. The checks at the end guard results the report relies on; if one
fails, the code has changed behaviour and the report needs revisiting.

The sample images aren't in the repository (see scoping/samples/README.md); put them
in scoping/samples/ first.

The web app's band finder is checked separately in the browser: after this script,
serve the repository root (python3 -m http.server) and open /tests/parity.html.

Usage (from the repository root):
    python scoping/run_all.py
"""

import csv
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SCOPING = ROOT / "scoping"
OUT = SCOPING / "out"
SAMPLES = SCOPING / "samples"
GEL01 = SAMPLES / "210826_Het_Mut_IVP_Opt_2.tif"
GEL02 = SAMPLES / "gel_02.jpg"
LANES02 = SAMPLES / "gel_02_lanes.csv"
GEL04 = SAMPLES / "gel_04.jpg"
DNA1 = SAMPLES / "dna" / "nicole_1.jpg"  # agarose, 1 kb Plus ladder at both ends; optional
DNA2 = SAMPLES / "dna" / "nicole_2.jpg"  # agarose, ladder in lane 1, every other well loaded
KB_PLUS = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]
KB_PLUS_NG = [40, 40, 48, 40, 32, 120, 40, 57, 45, 122, 34, 31, 27, 23, 124, 49, 37, 32, 61]
BENCHMARK = ["220", "160", "120", "100", "90", "80", "70", "60", "50", "40", "30", "25", "20", "15", "10"]

STEPS = [
    ("Standardise both samples to 16-bit greyscale PNG",
     ["-m", "gel_ed.load", GEL01, OUT / "gel_01_std.png"]),
    ("", ["-m", "gel_ed.load", GEL02, OUT / "gel_02_std.png"]),
    ("Column profiles (first look at the data)",
     ["scoping/column_profiles.py", GEL01, "--out", OUT / "gel_01_columns.png"]),
    ("", ["scoping/column_profiles.py", GEL02]),
    ("", ["scoping/column_profiles.py", GEL02, "--cols", "0", "150"]),
    ("", ["scoping/column_profiles.py", GEL02, "--cols", "31", "137"]),
    ("", ["scoping/column_profiles.py", GEL02, "--cols", "31", "137", "--n", "100",
          "--out", OUT / "gel_02_columns_31-137_n100.png"]),
    ("Ladder centre-line from band centroids",
     ["scoping/ladder_centreline.py", GEL02, "--cols", "31", "137", "--straighten", "4"]),
    ("Ladder outline from per-row edges",
     ["scoping/ladder_edges.py", GEL02, "--cols", "31", "137", "--exclude-rows", "757", "831"]),
    ("Strip profiles (lanes across the gel)", ["scoping/strip_profiles.py", GEL02]),
    ("Centre-lines for all lanes", ["scoping/compare_lanes.py", GEL02, "--lanes", LANES02]),
    ("Band picking", ["scoping/band_peaks.py", GEL02, "--lanes", LANES02]),
    ("Band masses, uncertainties, ~105/109 kDa same-protein tests",
     ["scoping/band_masses.py", GEL02, "--lanes", LANES02, "--same", "103", "107.5", "--same", "107.5", "112",
      "--same-lanes", *map(str, range(2, 14))]),
    ("Profiles along the centre-line vs straight (gel_02 as is, and rotated 3 degrees)",
     ["scoping/follow_centreline.py", GEL02, "--lanes", LANES02]),
    ("", ["scoping/follow_centreline.py", GEL02, "--lanes", LANES02, "--rotate", "3"]),
    ("Auto-straighten: recovering known tilts on gel_02", ["scoping/auto_straighten.py", GEL02]),
    ("Lane counting (as the web page)",
     ["scoping/count_lanes.py", GEL02, "--lanes", LANES02, "--out", OUT / "gel_02_count_lanes.csv"]),
    ("Ladder lane and picking (as the web page): gel_04, BenchMark ladder in the middle lane",
     ["scoping/ladder_pick.py", GEL04, "--lane", "auto", "--kda", *BENCHMARK, "--out", OUT / "gel_04_ladder.csv"]),
    ("", ["scoping/ladder_pick.py", GEL02, "--lane", "auto", "--kda", "220", "120", "100", "80", "60", "50", "40", "30", "20",
          "--out", OUT / "gel_02_ladder_pick.csv"]),
    ("Reference for the browser tests (open tests/parity.html and tests/straighten.html)",
     ["scoping/js_reference.py", GEL02, "--lanes", LANES02]),
]


def run(args):
    cmd = [sys.executable, *map(str, args)]
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        sys.exit(f"FAILED: {' '.join(map(str, args))}")
    return result.stdout


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def checks():
    """Results the report depends on. Each returns (description, passed, detail)."""
    from PIL import Image
    sys.path.insert(0, str(ROOT))
    from gel_ed.load import load
    import tifffile

    out = []
    src = tifffile.imread(GEL01)
    png = np.asarray(Image.open(OUT / "gel_01_std.png"))
    out.append(("Loader: gel_01 PNG is 16-bit and matches the source exactly",
                png.dtype == np.uint16 and np.array_equal(png, src[..., 0].astype(np.uint16) * 257), ""))
    out.append(("Loader: load() and the written PNG agree",
                np.array_equal(load(GEL02), np.asarray(Image.open(OUT / "gel_02_std.png"))), ""))

    masses = read_csv(OUT / "gel_02_masses.csv")
    ladder = [r for r in masses if r["lane_no"] == "1"]
    out.append(("Masses: ladder lane has 9 bands, one per size", len(ladder) == 9, f"{len(ladder)} found"))

    def triplet(lane):
        rows = [r for r in masses if r["lane_no"] == lane and r["kDa"] and 36 <= float(r["kDa"]) <= 42]
        return sorted((float(r["kDa"]) for r in rows), reverse=True)[:3]
    t5, t11 = triplet("5"), triplet("11")
    ok = len(t5) == 3 and len(t11) == 3 and max(abs(a - b) for a, b in zip(t5, t11)) <= 2.0
    out.append(("Masses: lane 5 and 11 triplets agree within 2 kDa after running correction", ok,
                f"lane 5 {t5}, lane 11 {t11}"))

    has_unc = all(r["abs_pct"] and r["rel_pct"] for r in masses if r["kDa"])
    out.append(("Masses: every band with a mass has relative and absolute uncertainty", has_unc, ""))

    same = read_csv(OUT / "gel_02_same_protein.csv")
    both = [set(t["lanes"].split()) for t in same]
    ok = len(same) == 2 and {"4", "10"} <= both[0] and {"4", "10"} <= both[1]
    out.append(("Same-protein: lanes 4 and 10 each hold both the ~105 and ~109 kDa band (no alignment needed)",
                ok, "; ".join(f"{t['mean_kDa']} kDa: lanes {t['lanes']}" for t in same)))

    sys.path.insert(0, str(SCOPING))
    from auto_straighten import matrix, warp
    from count_lanes import count_lanes
    g = load(GEL02).astype(float) / 65535
    upright = warp(g, matrix(g.shape[1], g.shape[0], skew=-0.044))  # lanes made vertical, rows untouched
    _, b = count_lanes(np.where(np.isnan(upright), 1.0, upright))
    out.append(("Lane counting: gel_02 with its lanes made vertical still has 13 lanes (not half-width ones)",
                len(b) - 1 == 13, f"{len(b) - 1} lanes"))

    counted = read_csv(OUT / "gel_02_count_lanes.csv")
    worst = float(counted[0]["worst_divider_px"] or "inf")
    out.append(("Lane counting: gel_02 has 13 lanes, dividers within 20 px of the hand-placed gaps",
                len(counted) == 13 and worst <= 20, f"{len(counted)} lanes, worst divider {worst:.0f} px"))

    g4 = load(GEL04).astype(float) / 65535
    _, b = count_lanes(g4[38:695, 38:949])  # the area a user trimmed to (x 38-948, y 38-694)
    out.append(("Lane counting: gel_04 trimmed still has 15 lanes (the faint first lane, one band, isn't margin)",
                len(b) - 1 == 15, f"{len(b) - 1} lanes"))

    rows = read_csv(OUT / "gel_04_ladder.csv")
    picks = [(int(r["row"]), float(r["kDa"])) for r in rows]
    out.append(("Ladder lane: found automatically on gel_04 (lane 8 of 15, the middle)",
                rows[0]["lane"] == "8", f"lane {rows[0]['lane']}"))
    expect = [126, 152, 181, 204, 219, 237, 260, 288, 329, 379, 441, 498, 518, 572, 633]  # read off the image
    out.append(("Ladder picking: gel_04 gets all 15 BenchMark bands on the right rows (noise cap, then spacing)",
                [r for r, _ in picks] == expect, " ".join(f"{r}:{k:g}" for r, k in picks)))
    rows = read_csv(OUT / "gel_02_ladder_pick.csv")
    picks = [int(r["row"]) for r in rows]
    out.append(("Ladder lane: found automatically on gel_02 (lane 1)", rows[0]["lane"] == "1", f"lane {rows[0]['lane']}"))
    out.append(("Ladder picking: gel_02 still leaves out the smudge at row 789 (solidity 0.78)",
                len(picks) == 9 and 789 not in picks, " ".join(map(str, picks))))

    # Cropping to the gel on loading (gel_box): the samples are trimmed scans, left whole or
    # cropped without losing a lane (gel_04 has real tray along its bottom and right);
    # padded with background (light box, dark noisy bench, grey, a gradient), the gel is
    # found again, never more than 5% inside its edges
    from gel_slab import gel_box
    whole, padded = [], []
    rng = np.random.default_rng(1)
    for path in (GEL01, GEL02, GEL04, SAMPLES / "gel_03.png", SAMPLES / "inna_250926_frozen_blood_opt_3.jpg"):
        if not path.exists():
            continue
        g = load(path).astype(float) / 65535
        h, w = g.shape
        y0, y1, x0, x1 = gel_box(g)
        whole.append((path.name, len(count_lanes(g[y0:y1, x0:x1])[1]) == len(count_lanes(g)[1])))
        for bg, noise, grad in ((0.97, 0, 0), (0.25, 0.03, 0), (0.55, 0.02, 0), (0.95, 0, 0.04)):
            t, b, l, r = 120, 160, 200, 90
            H, W = h + t + b, w + l + r
            img = np.clip(bg + grad * (np.arange(W)[None, :] / W - 0.5) + noise * rng.standard_normal((H, W)), 0, 1)
            img[t:t + h, l:l + w] = g
            y0, y1, x0, x1 = gel_box(img)
            th, tw = 0.05 * h, 0.05 * w
            padded.append(y0 <= t + th and y1 >= t + h - th and x0 <= l + tw and x1 >= l + w - tw
                          and (y0, y1, x0, x1) != (0, H, 0, W))
    out.append(("Gel crop: the protein samples (trimmed scans) keep every lane",
                all(ok for _, ok in whole), " ".join(f"{n}:{'ok' if ok else 'LANES LOST'}" for n, ok in whole)))
    out.append(("Gel crop: padded with background, every sample's gel is found, cut by at most 5% of it",
                all(padded), f"{sum(padded)} of {len(padded)}"))

    # The lab's own photos (references/, optional; ChemiDoc: "Coomassie Blue" = protein,
    # "SYBR Safe" = DNA): no protein gel gets a second ladder from a lane full of bands;
    # DNA gels with a few wells loaded get lanes one well wide (the wells' spacing)
    lab = ROOT / "references"
    if lab.exists() and any(lab.glob("*SYBR*.jpg")):
        import lab_survey
        protein = sorted(lab.glob("*Coomassie*.jpg"))
        seconds = [f.name for f in protein if lab_survey.analyse(f, lab_survey.LADDERS["novex-sharp-15"])["second"]]
        out.append(("Lab photos: no protein gel gets a second ladder from a busy sample lane",
                    not seconds, f"{len(protein)} gels; with a second ladder: {', '.join(seconds) or 'none'}"))
        for name, want_lane, want_second in (("biologics 2026-10-27 16h16m23s(SYBR Safe).jpg", 14, 4),
                                             ("biologics 2026-10-21 11h30m18s(SYBR Safe).jpg", 4, None)):
            f = lab / name
            if not f.exists():
                continue
            r = lab_survey.analyse(f, KB_PLUS)
            sec = r["second"][1] if r["second"] else None
            ok = r["lane"] == want_lane and sec == want_second and 70 <= r["pitch"] <= 82
            out.append((f"Lab photos: {name[:30]}: ladder in lane {want_lane}" + (f", second in {want_second}" if want_second else "")
                        + ", lanes one well wide (70-82 px)", ok,
                        f"ladder {r['lane']}, second {sec}, {len(r['bounds']) - 1} lanes {r['pitch']:.0f} px"))

    if DNA1.exists() and DNA2.exists():  # DNA gels: light bands on black, cropped to the slab
        from gel_slab import gel_slab
        from ladder_pick import ladder, second_ladder
        from wells import USE_WELLS, find_wells
        for path, lane, want, label in (
            (DNA1, 32, [530, 542, 560, 571, 587, 613, 651, 684, 711, 732, 745, 756, 770, 788, 810, 832, 856, 884, 914],
             "all 19 bands on the rows read off the image (0.9, 0.8, 0.6 kb as shoulders)"),
            (DNA2, 4, {6000: 312, 3000: 348, 1000: 442, 500: 508, 100: 635},  # one lane per well: the ladder's well is the 4th
             "the brighter 6, 3, 1.0 and 0.5 kb bands and 0.1 kb on their rows, wells left out")):
            g = load(path).astype(float) / 65535
            y0, y1, x0, x1 = gel_slab(g)
            img = 1 - g[y0:y1, x0:x1]
            wl = find_wells(img)  # as the page: the wells' spacing sets the lane width, if a row shows
            hint = wl["pitch"] if wl and len(wl["xs"]) >= USE_WELLS else None
            lanes, found_lane, picks, scores = ladder(img, "auto", KB_PLUS, KB_PLUS_NG, hint)
            picks = [(r + y0, k) for r, k in picks]
            from band_peaks import find_bands
            sec = second_ladder(img, lanes, [find_bands(img[:, a:b]) for a, b in lanes], found_lane, picks, scores,
                                KB_PLUS, KB_PLUS_NG)
            two = path == DNA1  # nicole_1 has a second ladder in lane 4; nicole_2 has one ladder
            out.append((f"DNA second ladder: {path.name} " + ("has one in lane 4, lining up with the first" if two
                        else "has none"),
                        (sec is not None and sec[0] == 4) if two else sec is None,
                        f"lane {sec[0]}: score {sec[1]:.2f}, rows within {sec[2]:.1f} px" if sec else "none"))
            if two:
                # cropped tight (as a user did: rows 235-1063, columns 352-2081), the left ladder
                # loses the faint bands between 1.0 and 0.5 kb; the picker must leave those four
                # sizes out rather than slide 0.5 kb onto 0.7 (and 0.1 kb off the bottom)
                tight = 1 - g[235:1064, 352:2082]
                _, tl, tp, _ = ladder(tight, 1, KB_PLUS, KB_PLUS_NG)
                ok = any(abs(r + 235 - 782) <= 4 and k == 500 for r, k in tp) and any(abs(r + 235 - 891) <= 4 and k == 100 for r, k in tp)
                out.append(("DNA ladder picking: nicole_1 cropped tight, the left ladder keeps 0.5 and 0.1 kb on their bands",
                            ok, " ".join(f"{r + 235}:{k / 1000:g}" for r, k in tp)))
                from count_lanes import EMPTY_FILL, count_lanes as cl, lane_fill
                _, b = cl(img)
                empty = [i + 1 for i, f in enumerate(lane_fill(img, b)) if f < EMPTY_FILL]
                want_empty = [1, 2, 3, 6, 11, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33]  # read off the image
                out.append(("DNA empty lanes: nicole_1's unloaded wells are marked empty, loaded lanes aren't",
                            empty == want_empty, " ".join(map(str, empty))))
            out.append((f"DNA ladder lane: found automatically on {path.name} (lane {lane} of {len(lanes)})",
                        found_lane == lane, f"lane {found_lane}"))
            ok = [r for r, _ in picks] == want if isinstance(want, list) else all(
                any(abs(r - row) <= 4 and k == size for r, k in picks) for size, row in want.items())  # within 4 rows
            out.append((f"DNA ladder picking: {path.name} gets {label}", ok,
                        " ".join(f"{r}:{k / 1000:g}" for r, k in picks)))

    peaks = read_csv(OUT / "gel_02_lanes_summary.csv")
    lad = [r for r in peaks if r["lane_no"] == "1" and r["method"] == "centroid"][0]
    out.append(("Centre-lines: ladder lean between 2.5 and 3.5 degrees",
                2.5 <= float(lad["lean_deg"]) <= 3.5, f"{lad['lean_deg']} deg"))
    return out


def main():
    missing = [p.name for p in (GEL01, GEL02, LANES02, GEL04) if not p.exists()]
    if missing:
        sys.exit(f"Missing sample files in {SAMPLES.relative_to(ROOT)}/: {', '.join(missing)} "
                 f"(see scoping/samples/README.md)")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for title, args in STEPS:
        if title:
            print(f"- {title}")
        run(args)
    print(f"\n{len(list(OUT.iterdir()))} files written to {OUT.relative_to(ROOT)}/\n")

    failed = 0
    for desc, passed, detail in checks():
        print(f"[{'ok' if passed else 'FAIL'}] {desc}" + (f"  ({detail})" if detail else ""))
        failed += not passed
    if failed:
        sys.exit(f"{failed} check(s) failed")


if __name__ == "__main__":
    main()
