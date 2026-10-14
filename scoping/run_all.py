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

    peaks = read_csv(OUT / "gel_02_lanes_summary.csv")
    lad = [r for r in peaks if r["lane_no"] == "1" and r["method"] == "centroid"][0]
    out.append(("Centre-lines: ladder lean between 2.5 and 3.5 degrees",
                2.5 <= float(lad["lean_deg"]) <= 3.5, f"{lad['lean_deg']} deg"))
    return out


def main():
    missing = [p.name for p in (GEL01, GEL02, LANES02) if not p.exists()]
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
