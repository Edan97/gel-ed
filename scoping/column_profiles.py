"""Plot the intensity profile down evenly spaced columns of a gel image, staggered.

Each column of the image becomes one row of values (intensity from top to bottom).
N columns, evenly spaced across the width, are drawn as offset traces, next to the
gel with the sampled columns marked.

Usage:
    python scoping/column_profiles.py IMAGE [--n 50] [--cols START END] [--offset 0.1] [--out PATH.png]
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402


def column_profiles(img, n, start=0, end=None):
    """Return (column indices, profiles) for n evenly spaced columns from start to end (inclusive).
    Profiles are scaled 0-1."""
    end = img.shape[1] - 1 if end is None else min(end, img.shape[1] - 1)
    cols = np.unique(np.linspace(start, end, n).round().astype(int))
    rows = img.T[cols].astype(np.float64) / 65535  # one row of values per column
    return cols, rows


def plot(img, cols, rows, offset, title):
    fig, (ax_img, ax) = plt.subplots(
        2, 1, figsize=(12, 18), gridspec_kw={"height_ratios": [1, 1.6]}
    )

    ax_img.imshow(img, cmap="gray", vmin=0, vmax=65535)
    for c in cols:
        ax_img.axvline(c, color="#2a78d6", lw=0.5, alpha=0.6)
    ax_img.set(title=title, xlabel="Column (px)", ylabel="Row (px)")

    y = np.arange(rows.shape[1])
    for i, profile in enumerate(rows):
        ax.plot(y, profile + i * offset, color="#2a78d6", lw=0.8)
    every = max(1, len(cols) // 10)
    ax.set_yticks([i * offset + np.median(rows[i]) for i in range(0, len(cols), every)])
    ax.set_yticklabels([str(cols[i]) for i in range(0, len(cols), every)])
    ax.set(
        title=f"{len(cols)} column profiles, staggered by {offset:g}",
        xlabel="Row (px), top of image → bottom",
        ylabel="Column (px)  ·  trace = intensity, 0 (black) – 1 (white)",
        xlim=(0, y[-1]),
    )
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.grid(axis="x", color="#e5e5e5", lw=0.5)

    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--n", type=int, default=50, help="number of columns to plot (default 50)")
    p.add_argument("--cols", type=int, nargs=2, metavar=("START", "END"),
                   help="only sample columns START to END inclusive (default: whole width)")
    p.add_argument("--offset", type=float, default=0.1, help="vertical step between traces (default 0.1)")
    p.add_argument("--out", help="output PNG (default: scoping/out/<image>_columns.png)")
    a = p.parse_args()

    img = load(a.image)
    cols, rows = column_profiles(img, a.n, *(a.cols or (0, None)))
    out = Path(a.out) if a.out else Path(__file__).parent / "out" / f"{Path(a.image).stem}_columns{'_%d-%d' % tuple(a.cols) if a.cols else ''}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    plot(img, cols, rows, a.offset, Path(a.image).name).savefig(out, dpi=150)
    print(out)


if __name__ == "__main__":
    main()
