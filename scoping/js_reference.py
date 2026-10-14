"""Write the reference for tests/parity.html: each lane's pixels and the bands Python finds.

The web app's band finder (js/bands.js) is a port of band_peaks.find_bands. This writes,
for every lane in a lane CSV, the lane's pixels (8-bit levels, rows from --row-start)
and Python's bands, so the browser test can run the JS version on the same pixels and
compare. Output goes to scoping/out/ (not committed: it contains the gel).

Usage:
    python scoping/js_reference.py IMAGE --lanes FILE.csv [--row-start 140]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from band_peaks import find_bands  # noqa: E402
from lanes import number_lanes, read_lanes  # noqa: E402
from ladder_centreline import extract, load  # noqa: E402


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--lanes", required=True)
    p.add_argument("--row-start", type=int, default=140)
    a = p.parse_args()

    img = load(a.image)
    if not np.all(img % 257 == 0):
        sys.exit("js_reference.py needs an 8-bit image (the browser reads 8-bit levels).")
    lanes = []
    for name, start, end in number_lanes(read_lanes(a.lanes)):
        region = extract(img, start, end)[a.row_start:]  # 0-1, as find_bands sees it
        bands, _ = find_bands(region, 0)
        levels = np.rint(region * 255).astype(int)
        lanes.append({"name": name, "w": region.shape[1], "h": region.shape[0],
                      "levels": levels.ravel().tolist(),
                      "bands": [{"y": d["y"], "kind": d["kind"], "saturated": d["saturated"]} for d in bands]})
    out = Path(__file__).parent / "out" / f"{Path(a.image).stem}_js_reference.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"image": Path(a.image).name, "row_start": a.row_start, "lanes": lanes}))
    print(out)


if __name__ == "__main__":
    main()
