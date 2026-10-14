"""Load a gel image in any common format and standardise it to a 16-bit greyscale PNG.

The standard form is a 2-D uint16 array (0-65535). Nothing else is changed:
no inversion, cropping, rotation or contrast adjustment. Those belong to later steps.

Usage:
    python -m gel_ed.load INPUT [OUTPUT.png]
"""

import sys
import warnings
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageOps

TIFF_SUFFIXES = {".tif", ".tiff"}


def load(path):
    """Return the image at `path` as a 2-D uint16 greyscale array."""
    path = Path(path)
    if path.suffix.lower() in TIFF_SUFFIXES:
        arr = _read_tiff(path)
    else:
        arr = _read_pillow(path)
    return _to_uint16(_to_grey(arr))


def to_png(src, dst=None):
    """Standardise `src` and write it as a 16-bit greyscale PNG. Returns the output path."""
    src = Path(src)
    dst = Path(dst) if dst else src.with_suffix(".png")
    if dst.resolve() == src.resolve():
        dst = src.with_name(src.stem + "_std.png")
    Image.fromarray(load(src)).save(dst)
    return dst


def _read_tiff(path):
    with tifffile.TiffFile(path) as tif:
        if len(tif.series) > 1 or len(tif.pages) > 1:
            warnings.warn(f"{path.name} has several images; using the first.")
        return tif.series[0].asarray(key=0) if len(tif.pages) > 1 else tif.asarray()


def _read_pillow(path):
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)  # phone photos store rotation in EXIF
        if img.mode == "P":
            img = img.convert("RGBA")
        return np.asarray(img)


def _to_grey(arr):
    """Collapse colour channels to one. Identical channels (grey saved as RGB) are kept exactly."""
    if arr.ndim == 2:
        return arr
    if arr.ndim != 3:
        raise ValueError(f"Unexpected image shape {arr.shape}")
    if arr.shape[0] in (3, 4) and arr.shape[-1] not in (3, 4):  # channels-first TIFF
        arr = np.moveaxis(arr, 0, -1)
    rgb = arr[..., :3]  # drop alpha
    if np.array_equal(rgb[..., 0], rgb[..., 1]) and np.array_equal(rgb[..., 0], rgb[..., 2]):
        return rgb[..., 0]
    # ITU-R 601 luma, the same weights Pillow uses for RGB -> L
    grey = rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    return grey.round().astype(rgb.dtype) if rgb.dtype.kind in "ui" else grey


def _to_uint16(arr):
    """Map onto 0-65535. Integer types scale exactly; floats are stretched to their own min-max."""
    if arr.dtype == np.uint16:
        return arr
    if arr.dtype == np.uint8:
        return arr.astype(np.uint16) * 257  # 0->0, 255->65535 exactly
    if arr.dtype == bool:
        return arr.astype(np.uint16) * 65535
    if arr.dtype.kind == "f":
        lo, hi = np.nanmin(arr), np.nanmax(arr)
        warnings.warn(f"Floating-point image; stretched {lo:g}..{hi:g} to the full range.")
        scaled = (arr - lo) / (hi - lo) if hi > lo else np.zeros_like(arr)
        return np.round(np.nan_to_num(scaled) * 65535).astype(np.uint16)
    if arr.dtype.kind in "ui":
        info = np.iinfo(arr.dtype)
        if arr.min() >= 0 and arr.max() <= 65535:
            return arr.astype(np.uint16)  # e.g. 12-bit data stored in a wider type
        scaled = (arr.astype(np.float64) - info.min) / (info.max - info.min)
        return np.round(scaled * 65535).astype(np.uint16)
    raise ValueError(f"Unsupported pixel type {arr.dtype}")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    print(to_png(*sys.argv[1:]))
