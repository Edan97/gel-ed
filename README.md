# gel-ed

Simple, lightweight band finding for gel and western blot images. Early stage: a web
page for straightening, cropping and reading lane profiles, plus the Python scoping work
behind it.

**Use it:** https://edan97.github.io/gel-ed/ (runs in your browser; images are never uploaded)

## The web page

1. **Load** a PNG, JPEG, BMP, WebP or uncompressed TIFF. Colour is converted to greyscale.
2. **Edit image** (a drop-down card):
   - Brightness and contrast.
   - Invert. Band finding expects dark bands on a light background, so invert
     white-on-black images before reading the results.
   - Rotation, skew, distort and perspective sliders, each starting in the middle (no
     change). A small picture at each end of every slider shows what that end does.
     Skew slides rows sideways (straightens leaning lanes); distort slides columns up and
     down (levels bands that slope across the gel); perspective narrows the top or
     bottom. Double-click a slider to reset it.
   - The whole edited image always stays in view, scaled to fit the display box.
   - The analysed area is set automatically: the largest rectangle with no blank corners
     (everything else is greyed out). It can be dragged smaller, e.g. to leave out labels
     above the lanes, but never past the edge of the original image.
3. **Lanes and bands**: set the number of lanes; they're placed at the clearest gaps
   between lanes, with lane widths kept regular. Drag the dashed dividers to adjust.
   Each lane's profile (mean darkness down its central columns) is drawn on the gel with
   the bands found in it: peaks (red), saturated peaks (black) and shoulders (orange:
   bands merged into a neighbour). Download the overlay, the edited image or a CSV of
   bands.

Band finding settings: threshold (in multiples of each lane's noise), how much of the
lane's centre is used, smoothing, and the noise window. Defaults match the Python version.

## Repository layout

| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | The web page (plain JavaScript, no build step) |
| `js/bands.js` | Band finding (port of `scoping/band_peaks.py`) and lane placement |
| `js/signal.js` | Gaussian smoothing, peak finding etc. with scipy's definitions |
| `js/transform.js` | Rotation/skew/distort/perspective and the crop rule |
| `js/image.js` | File reading, including a small uncompressed-TIFF reader |
| `js/icons.js` | Slider pictures, drawn with the editor's own transform |
| `tests/parity.html` | Checks the browser band finder against Python on the same pixels |
| `gel_ed/load.py` | Python loader: any format to 16-bit greyscale |
| `scoping/` | Python scoping work: band finding, lane centre-lines, masses with uncertainty. Write-up in [`scoping/REPORT.md`](scoping/REPORT.md), running log in [`scoping/NOTES.md`](scoping/NOTES.md) |

## Running locally

ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server
# open http://localhost:8000
```

## Python scoping work

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scoping/run_all.py
```

`run_all.py` regenerates every figure and table from the sample images and checks the
results the report relies on. The sample images are lab data and aren't in the
repository: see [`scoping/samples/README.md`](scoping/samples/README.md). After running
it, open `/tests/parity.html` on the local server to check the browser's band finding
matches Python's (on the current samples, all 13 lanes match exactly).
