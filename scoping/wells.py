"""Wells: the comb's slots along the top of a gel, loaded or not, so they give the lane
spacing where the bands can't (a DNA gel with a few wells loaded looks, from its bands
alone, like one with lanes two or three times as wide).

find_wells(grey): grey is the analysed area, dark bands on light (a DNA photo inverted),
so wells, which hold no gel, show as light slots. In the top 35% of rows, each band of
rows (2% of the height, in steps of half that) is averaged into a profile across the
columns and smoothed a little; its background (a running median over 1/8 of the width)
is taken off, and the teeth of gel between wells (or the wells themselves, whichever
gives a regular row) are the peaks that stand out by at least 3 x the profile's noise
(at least 0.003: a dark 8-bit photo is quantised). A row of wells is at least 6 slots with regular spacing: the gaps between
neighbouring slots, apart from the odd one twice the typical gap (a well full of DNA, or
one too faint to show), within 20% of their median. The band of rows with the most slots
wins. Returns {pitch, row, xs} (xs: the slots' centres) or None. Gaps are between
neighbours, so a missing well can't double the pitch, as it would an autocorrelation.

Usage:
    python scoping/wells.py IMAGE [IMAGE ...]   (DNA photos; inverted and cropped as the page does)
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.signal import find_peaks

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402

TOP = 0.35       # wells are in this top share of the gel
BAND = 0.02      # rows averaged together (share of the height)
PROM = 3.0       # a tooth (well) stands out from the background by this many x the noise
NOISE_FLOOR = 0.003
MIN_WELLS = 6
USE_WELLS = 8    # the lane finder only uses a row of at least this many (6 gave 200 px on one gel)
REGULAR = 0.2    # gaps within this share of their median


def _regular(xs):
    """Median gap if the slots are regularly spaced (allowing the odd double gap), else None."""
    if len(xs) < MIN_WELLS:
        return None
    gaps = np.diff(xs)
    med = np.median(gaps)
    for _ in range(2):  # refine: the median of the gaps that are about one pitch
        one = gaps[np.abs(gaps - med) <= REGULAR * med]
        if len(one) < MIN_WELLS - 1:
            return None
        med = float(np.median(one))
    ok = np.abs(gaps - med) <= REGULAR * med
    double = np.abs(gaps - 2 * med) <= REGULAR * 2 * med
    return med if (ok | double).mean() >= 0.85 and ok.mean() >= 0.6 else None


def find_wells(grey):
    h, w = grey.shape
    band = max(3, int(BAND * h))
    win = max(9, w // 8) | 1
    best = None
    for y in range(0, int(TOP * h) - band, max(1, band // 2)):
        prof = ndimage.gaussian_filter1d(grey[y:y + band].mean(axis=0), 1.5)
        hp = prof - ndimage.median_filter(prof, win, mode="nearest")
        # noise: the profile's own robust spread, with a floor (a dark 8-bit photo is
        # quantised: neighbouring pixels are often equal, and that would make it 0)
        sd = max(NOISE_FLOOR, 1.4826 * float(np.median(np.abs(hp - np.median(hp)))))
        # the teeth of gel between wells (narrow) or the wells (wide): whichever is regular
        for sign in (-1, 1):
            xs, _ = find_peaks(sign * hp, prominence=PROM * sd, distance=max(3, w // 80))
            pitch = _regular(xs)
            if pitch is not None and (best is None or len(xs) > len(best["xs"])):
                best = {"pitch": pitch, "row": y + band // 2, "xs": [int(x) for x in xs],
                        "teeth": sign < 0, "hp": hp}
    if best is not None:
        del best["hp"]
    return best


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from gel_slab import gel_slab
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+")
    a = ap.parse_args()
    for path in a.images:
        g = load(path).astype(float) / 65535
        y0, y1, x0, x1 = gel_slab(g)
        r = find_wells(1 - g[y0:y1, x0:x1])
        print(f"{Path(path).name}: " + ("no row of wells" if not r else
              f"pitch {r['pitch']:.1f} px, {len(r['xs'])} slots at row {r['row'] + y0}, x {r['xs'][0] + x0}-{r['xs'][-1] + x0}"))


if __name__ == "__main__":
    main()
