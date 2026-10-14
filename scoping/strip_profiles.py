"""Plot horizontal strip profiles of a gel image, staggered: the sideways version of
column_profiles.py, for seeing how lanes show up across the gel.

The image is cut into N horizontal strips of equal height. Each strip becomes one
profile across the columns: the mean darkness (1 - intensity) of its rows, so lanes
are raised plateaus and the gaps between them are dips. Strips are stacked top to
bottom in the same order as on the gel.

No annotation cutoff is applied: labels or marks above the lanes appear as their own
strips. Use --rows to restrict the range by hand while the cutoff is still unsolved
(see NOTES.md).

Usage:
    python scoping/strip_profiles.py IMAGE [--n 15] [--rows START END] [--offset 0.15] [--out PATH.png]
"""

import argparse
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from gel_ed.load import load  # noqa: E402


def strip_profiles(img, n, start=0, end=None):
    """Return (row edges, profiles): n strips from row start to end (inclusive), darkness 0-1."""
    end = img.shape[0] - 1 if end is None else min(end, img.shape[0] - 1)
    edges = np.linspace(start, end + 1, n + 1).round().astype(int)
    dark = 1 - img.astype(np.float64) / 65535
    profiles = np.array([dark[lo:hi].mean(axis=0) for lo, hi in zip(edges[:-1], edges[1:])])
    return edges, profiles


def plot(img, edges, profiles, offset, title):
    fig, (ax_img, ax) = plt.subplots(
        2, 1, figsize=(14, 16), sharex=True, gridspec_kw={"height_ratios": [1, 1.5]}
    )
    blue = "#2a78d6"

    ax_img.imshow(img, cmap="gray", vmin=0, vmax=65535)
    for e in edges:
        ax_img.axhline(e - 0.5, color=blue, lw=0.6, alpha=0.7)
    ax_img.set(title=title, ylabel="Row (px)")

    x = np.arange(profiles.shape[1])
    base = -np.arange(len(profiles)) * offset  # first strip on top, as on the gel
    for b, prof in zip(base, profiles):
        ax.plot(x, prof - np.median(prof) + b, color=blue, lw=0.8)
    ax.set_yticks(base)
    ax.set_yticklabels([f"{lo}–{hi - 1}" for lo, hi in zip(edges[:-1], edges[1:])])
    ax.set(
        title=f"{len(profiles)} strip profiles (mean darkness, each minus its median), staggered by {offset:g}",
        xlabel="Column (px)",
        ylabel="Strip rows (px)  ·  trace = darkness, up = darker",
        xlim=(0, x[-1]),
    )
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.grid(axis="x", color="#e5e5e5", lw=0.5)
    ax.tick_params(labelbottom=True)

    fig.tight_layout()
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image")
    p.add_argument("--n", type=int, default=15, help="number of strips (default 15)")
    p.add_argument("--rows", type=int, nargs=2, metavar=("START", "END"),
                   help="only use rows START to END inclusive (default: whole height)")
    p.add_argument("--offset", type=float, default=0.15, help="vertical step between traces (default 0.15)")
    p.add_argument("--out", help="output PNG (default: scoping/out/<image>_strips.png)")
    a = p.parse_args()

    img = load(a.image)
    edges, profiles = strip_profiles(img, a.n, *(a.rows or (0, None)))
    suffix = f"_{a.rows[0]}-{a.rows[1]}" if a.rows else ""
    out = Path(a.out) if a.out else Path(__file__).parent / "out" / f"{Path(a.image).stem}_strips{suffix}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    plot(img, edges, profiles, a.offset, Path(a.image).name).savefig(out, dpi=130)
    print(f"strip height {edges[1] - edges[0]} rows")
    print(out)


if __name__ == "__main__":
    main()
