"""The gel in a photo with background round it, as the web page crops to it on loading
(gelSlab and gelBox in js/bands.js).

gel_slab(grey): a gel doc photo of a DNA gel, the slab glowing on black. Rows and columns
whose median brightness is over halfway from the 5th to the 95th percentile of those
medians, trimmed by 1.5% to drop the slab's bright rim; kept only if it covers at least
60% of the photo each way and is at least 1.3 x brighter than what's outside it (else the
gel fills the photo: whole image). On the lab's 14 DNA photos: 9 slabs cropped, 5
full-frame gels left whole. Cropped like this, countLanes gets Nicole's agarose gels
right, where the whole photo made it take lanes 4x too wide.

gel_box(grey): a gel on a plain tray, light box or bench, lighter or darker than the gel
(the lab's ChemiDoc photos of Coomassie gels: a grey gel on a near-white tray, with the
comb's fingers above the wells, a dye front, dust). On a copy block-averaged to ~400 px:
  1. Background: a gentle slope (a tray lit unevenly), a plane fitted to the outer 3%,
     refitted without outliers; each pixel's difference from it.
  2. The gel's level: the 70th percentile (towards the background) of what differs
     clearly from it, so bands don't pull it away and a pale gel still counts; gel pixels
     differ by more than half that, and the level must be at least 0.06.
  3. The box: columns at least 35% gel (of the most), then rows at least 35% gel within
     them, gaps up to 15% bridged (a dark ladder or smear); at least 15% of the image each
     way and at least 70% gel inside (gels on a tray 0.72-0.99; a trimmed scan's bands,
     scattered, 0.52 on gel_02).
  4. A side whose outermost strip is half gel or more isn't cropped; the rest get a 1.5%
     margin, 6% at the top (a pale stacking gel near the wells can read as tray).
On the lab's 39 protein photos every crop keeps all lanes and bands; the trimmed sample
scans keep every lane; padded with plain, noisy, lighter, darker or graded background,
each sample's gel is found within 5% of its edges (run_all.py checks these).

Usage:
    python scoping/gel_slab.py IMAGE [IMAGE ...]
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402

EDGE = 0.03      # outermost share of a profile taken as background
SLAB_SIZE = 0.6  # a DNA slab covers at least this share of the photo each way
SLAB_RATIO = 1.3 # and is at least this many times brighter than what's outside it
MIN_STEP = 0.06  # the gel must differ from the background by this (0-1 scale; a gel's own tint
                 # varies by 0.03 across it, gel_01; a light box or bench differs by 0.1 or more)
MARGIN = 0.015   # the crop stops this share of the gel's size outside its edge
MIN_SIZE = 0.15  # a box under this share of the image either way: no crop
BRIDGE = 0.15    # gaps in the gel this wide (a dark ladder, a smear) are bridged
BLUR = 4         # smoothing (px at ~400 px on the short side): a pale gel comes out solid
KEEP = 0.35      # a row (column) is gel if this share of it is (the comb's fingers are about half)
EDGE_GEL = 0.5   # a side whose outermost strip is at least this share gel isn't cropped
TOP_MARGIN = 0.06  # more room above: a pale stacking gel near the wells can read as tray
SOLID = 0.7      # the box must be at least this share gel (gels on a tray: 0.72-0.99; a trimmed
                 # scan's bands, gel_02: 0.52)


def gel_slab(grey):
    """A DNA gel glowing on black. grey: 2-D, 0 = black. Returns (y0, y1, x0, x1), end-exclusive."""
    h, w = grey.shape
    out = []
    for prof in (np.median(grey, axis=1), np.median(grey, axis=0)):
        lo, hi = np.percentile(prof, 5), np.percentile(prof, 95)
        inside = np.where(prof > lo + 0.5 * (hi - lo))[0]
        a, b = (inside.min(), inside.max() + 1) if len(inside) else (0, len(prof))
        trim = int(round(0.015 * (b - a)))
        out += [a + trim, b - trim]
    y0, y1, x0, x1 = out
    # only a slab on a black surround: slab-sized (a dim photo whose gel fills the frame
    # otherwise gives just the strip of bright bands), and brighter than what's outside it
    # (the lab's slabs: 1.46x on the dimmest, nicole_1, 8-270x on the rest; gels filling
    # the frame: at most 2x, and those also fail on size except one at 1.16x)
    outside = np.ones((h, w), bool)
    outside[y0:y1, x0:x1] = False
    inner = float(np.median(grey[y0:y1, x0:x1]))
    outer = float(np.median(grey[outside])) if outside.any() else inner
    if y1 - y0 < SLAB_SIZE * h or x1 - x0 < SLAB_SIZE * w or inner < SLAB_RATIO * max(outer, 1e-3):
        return 0, h, 0, w
    return y0, y1, x0, x1


def _run(frac, keep, gap):
    """The longest run of indices with frac >= keep, bridging gaps up to gap: (a, b) end-exclusive."""
    on = np.where(frac >= keep)[0]
    if not len(on):
        return None
    best, start, prev = None, on[0], on[0]
    for i in list(on[1:]) + [None]:
        if i is not None and i - prev <= gap:
            prev = i
            continue
        if best is None or prev + 1 - start > best[1] - best[0]:
            best = (start, prev + 1)
        if i is not None:
            start = prev = i
    return best


def gel_box(grey):
    """A gel photographed on a plain tray, light box or bench (lighter or darker than the
    gel). grey: 2-D, 0 = black. Returns (y0, y1, x0, x1), end-exclusive; the whole image
    when there's no clear background round the gel."""
    h, w = grey.shape
    f = max(1, min(h, w) // 400)  # work on a block-averaged copy, ~400 px on the short side
    hs, ws = h // f, w // f
    small = grey[:hs * f, :ws * f].reshape(hs, f, ws, f).mean(axis=(1, 3))
    blur = ndimage.gaussian_filter(small, BLUR)
    k = max(2, int(EDGE * min(hs, ws)))
    # the background as a gentle slope (a tray lit unevenly): a plane fitted to the
    # photo's outer strip, refitted without outliers; then each pixel's difference from it
    yy, xx = np.mgrid[0:hs, 0:ws]
    ring = np.zeros((hs, ws), bool)
    ring[:k] = ring[-k:] = True
    ring[:, :k] = ring[:, -k:] = True
    A = np.column_stack([np.ones(ring.sum()), xx[ring] / ws, yy[ring] / hs])
    z = blur[ring]
    use = np.ones(len(z), bool)
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(A[use], z[use], rcond=None)
        res = z - A @ coef
        sd = max(0.004, 1.4826 * float(np.median(np.abs(res[use] - np.median(res[use])))))
        use = np.abs(res) < 3 * sd
    diff = blur - (coef[0] + coef[1] * xx / ws + coef[2] * yy / hs)
    noise = sd
    # the gel: clearly darker (or lighter) than the background. Its level is taken from
    # its lighter part (70th percentile towards the background: bands would pull a median
    # away and leave a pale gel looking like background); the split is halfway to it
    off = max(0.02, 4 * noise)
    darker, lighter = diff < -off, diff > off
    sign = -1 if darker.sum() >= lighter.sum() else 1
    other = diff[darker] if sign < 0 else diff[lighter]
    if other.size < 0.05 * diff.size:
        return 0, h, 0, w
    level = float(np.percentile(other, 70 if sign < 0 else 30))
    if abs(level) < MIN_STEP:
        return 0, h, 0, w
    gel = diff * sign > abs(level) / 2
    if not gel.any() or gel.all():
        return 0, h, 0, w
    cols = _run(gel.mean(axis=0), KEEP * gel.mean(axis=0).max(), max(2, int(BRIDGE * ws)))
    if cols is None:
        return 0, h, 0, w
    rows = _run(gel[:, cols[0]:cols[1]].mean(axis=1), KEEP, max(2, int(BRIDGE * hs)))
    if rows is None:
        return 0, h, 0, w
    y0, y1, x0, x1 = rows[0], rows[1], cols[0], cols[1]
    if y1 - y0 < MIN_SIZE * hs or x1 - x0 < MIN_SIZE * ws:
        return 0, h, 0, w
    # a gel on a tray is a solid block different from the tray; on a trimmed scan (all
    # gel) the "different" pixels are only its bands, scattered
    if gel[y0:y1, x0:x1].mean() < SOLID:
        return 0, h, 0, w
    # each side: cropped only if the photo's edge there is background, not gel
    out = []
    for lo, hi, size, strip, top in ((y0, y1, hs, (gel[:k], gel[-k:]), TOP_MARGIN), (x0, x1, ws, (gel[:, :k], gel[:, -k:]), MARGIN)):
        m = int(round(MARGIN * (hi - lo)))
        a = max(0, lo - int(round(top * (hi - lo)))) if strip[0].mean() < EDGE_GEL else 0
        b = min(size, hi + m) if strip[1].mean() < EDGE_GEL else size
        out += [a, b]
    y0, y1, x0, x1 = out
    return y0 * f, (y1 * f if y1 < hs else h), x0 * f, (x1 * f if x1 < ws else w)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+")
    a = ap.parse_args()
    for path in a.images:
        g = load(path).astype(float) / 65535
        y0, y1, x0, x1 = gel_box(g)
        print(f"{Path(path).name}: {g.shape[1]} x {g.shape[0]}; gel rows {y0}-{y1}, columns {x0}-{x1}")


if __name__ == "__main__":
    main()
