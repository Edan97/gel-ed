"""Run the web page's pipeline on a folder of gel photos and draw what it found, to check
by eye: the crop on loading (gel_box; DNA photos: gel_slab, read inverted), the lanes
(count_lanes), empty lanes on DNA gels (lane_fill), the ladder lane chosen
automatically and its picked bands (ladder_pick), and a second ladder if one scores
under 1.0. ChemiDoc file names say the channel: "SYBR Safe" = DNA, "Coomassie Blue" =
protein, "Chemiluminescence" = western blot.

Writes contact sheets (12 per sheet) and a CSV with one row per image.

Usage:
    python scoping/lab_survey.py FOLDER OUT_DIR [--protein-ladder novex-sharp-15]
"""

import argparse
import csv
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402
from count_lanes import EMPTY_FILL, count_lanes, lane_fill  # noqa: E402
from gel_slab import gel_box, gel_slab  # noqa: E402
from ladder_pick import ladder, second_ladder  # noqa: E402
from wells import USE_WELLS, find_wells  # noqa: E402
from band_peaks import find_bands  # noqa: E402

LADDERS = {  # as js/ladders.js
    "novex-sharp-15": [260, 160, 110, 80, 60, 50, 40, 30, 20, 15],
    "pageruler-plus": [250, 130, 100, 70, 55, 35, 25, 15, 10],
    "benchmark": [220, 160, 120, 100, 90, 80, 70, 60, 50, 40, 30, 25, 20, 15, 10],
}
KB_PLUS = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]
KB_PLUS_NG = [40, 40, 48, 40, 32, 120, 40, 57, 45, 122, 34, 31, 27, 23, 124, 49, 37, 32, 61]


def kind_of(name):
    return "dna" if "SYBR" in name else "western" if "Chemilum" in name else "protein"


def analyse(path, protein_sizes):
    g = load(path).astype(float) / 65535
    kind = kind_of(path.name)
    dark = np.median(g[::7, ::7]) < 0.5
    if kind == "dna" and dark:
        y0, y1, x0, x1 = gel_slab(g)
        img = 1 - g[y0:y1, x0:x1]
    else:
        y0, y1, x0, x1 = gel_box(g)
        img = g[y0:y1, x0:x1]
        if np.median(img[::7, ::7]) < 0.5:
            img = 1 - img
    sizes, mass = (KB_PLUS, KB_PLUS_NG) if kind == "dna" else (protein_sizes, None)
    hint = None
    if kind == "dna":
        wl = find_wells(img)
        hint = wl["pitch"] if wl and len(wl["xs"]) >= USE_WELLS else None
    p, b = count_lanes(img, hint)
    lanes, lane, picks, scores = ladder(img, "auto", sizes, mass, hint)
    fill = lane_fill(img, b) if kind == "dna" else []
    empty = [i + 1 for i, f in enumerate(fill) if f < EMPTY_FILL]
    found = [find_bands(img[:, s0:e0]) for s0, e0 in lanes]
    sec = second_ladder(img, lanes, found, lane, picks, scores, sizes, mass)
    second = (sec[1], sec[0]) if sec else None
    return dict(grey=g, kind=kind, box=(y0, y1, x0, x1), pitch=p, bounds=b, lane=lane, picks=picks,
                n_sizes=len(sizes), empty=empty, second=second, score=min(scores) if scores else None)


def draw(r, name, size=(320, 250)):
    g = r["grey"]
    y0, y1, x0, x1 = r["box"]
    rgb = Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8)).convert("RGB")
    d = ImageDraw.Draw(rgb, "RGBA")
    lw = max(2, g.shape[1] // 400)
    d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(30, 110, 255), width=lw * 2)
    b = r["bounds"]
    for k in range(len(b) - 1):
        a, c = x0 + b[k], x0 + b[k + 1]
        if k + 1 in r["empty"]:
            d.rectangle([a, y0, c, y1], fill=(255, 200, 0, 60))
        if k + 1 == r["lane"]:
            d.rectangle([a, y0, c, y1], fill=(255, 0, 0, 45))
        if r["second"] and k + 1 == r["second"][1]:
            d.rectangle([a, y0, c, y1], fill=(255, 0, 255, 45))
    for x in b:
        d.line([x0 + x, y0, x0 + x, y1], fill=(0, 200, 255, 200), width=lw)
    a, c = x0 + b[r["lane"] - 1], x0 + b[r["lane"]]
    for row, _ in r["picks"]:
        d.line([a, y0 + row, c, y0 + row], fill=(255, 0, 0, 255), width=lw)
    rgb.thumbnail(size)
    return rgb


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("out")
    ap.add_argument("--protein-ladder", default="novex-sharp-15", choices=sorted(LADDERS))
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(Path(a.folder).glob("*.jpg")) + sorted(Path(a.folder).glob("*.png")) + sorted(Path(a.folder).glob("*.tif"))
    rows, tiles = [], []
    for i, f in enumerate(files):
        r = analyse(f, LADDERS[a.protein_ladder])
        h, w = r["grey"].shape
        y0, y1, x0, x1 = r["box"]
        rows.append([i, f.name, r["kind"], w, h, y0, y1, x0, x1, len(r["bounds"]) - 1, round(r["pitch"], 1), r["lane"],
                     len(r["picks"]), r["n_sizes"], "" if r["score"] is None else round(r["score"], 2),
                     "" if not r["second"] else f"{r['second'][1]}:{r['second'][0]:.2f}", " ".join(map(str, r["empty"]))])
        tiles.append((i, f.name, draw(r, f.name), rows[-1]))
        print(*rows[-1][:3], f"crop {x0}-{x1} x {y0}-{y1} of {w}x{h}", f"{len(r['bounds']) - 1} lanes", f"ladder {r['lane']}",
              f"{len(r['picks'])}/{r['n_sizes']} bands", f"second {rows[-1][15]}", f"empty {rows[-1][16]}", flush=True)
    with open(out / "survey.csv", "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(["i", "file", "kind", "w", "h", "crop_y0", "crop_y1", "crop_x0", "crop_x1", "lanes", "pitch",
                     "ladder_lane", "ladder_bands", "ladder_sizes", "ladder_score", "second_ladder", "empty_lanes"])
        wr.writerows(rows)
    W, H, per = 330, 290, 12
    for s in range(0, len(tiles), per):
        sheet = Image.new("RGB", (W * 4, H * 3), (90, 90, 90))
        d = ImageDraw.Draw(sheet)
        for k, (i, name, im, row) in enumerate(tiles[s:s + per]):
            x, y = (k % 4) * W, (k // 4) * H
            sheet.paste(im, (x + 5, y + 36))
            d.text((x + 5, y + 3), f"{i}: {name[:40]}", fill=(255, 255, 0))
            d.text((x + 5, y + 18), f"{row[9]} lanes  ladder {row[11]} ({row[12]}/{row[13]})  2nd {row[15] or '-'}",
                   fill=(255, 255, 255))
        sheet.save(out / f"survey_{s // per}.png")


if __name__ == "__main__":
    main()
