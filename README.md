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
   - The whole image is analysed; blank corners left by rotating contribute nothing. Drag
     the rectangle's corners and edges to leave something out (e.g. labels above the
     lanes); everything outside it is greyed out.
3. **Lanes and bands**: set the number of lanes; they're placed at the clearest gaps
   between lanes, with lane widths kept regular. Drag the dashed dividers to adjust.
   **Redo analysis** re-reads the profiles and finds bands again, keeping the lanes.
   Profiles are read from the **original pixels** by default: each pixel of the loaded
   image is placed through the edits and counted once, never blended, so straightening
   doesn't smooth the data. Switch to *edited image* to compare with reading the
   resampled picture. The edit settings are written into every row of the bands CSV.
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
| `tests/straighten.html` | Straightens a 3°-rotated copy of the sample and compares reading original pixels with reading the edited image |
| `tools/stamp_version.py` | Version stamps and counter for the web page (run before committing web changes) |
| `gel_ed/load.py` | Python loader: any format to 16-bit greyscale |
| `scoping/` | Python scoping work: band finding, lane centre-lines, masses with uncertainty. Write-up in [`scoping/REPORT.md`](scoping/REPORT.md), running log in [`scoping/NOTES.md`](scoping/NOTES.md) |

## Running locally

ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server
# open http://localhost:8000
```

## Updating the web page

Run `python tools/stamp_version.py` before committing changes to `index.html`, `css/` or
`js/`. It adds a content-based version to every file reference, so browsers load the new
files instead of cached ones, and counts the version shown next to the title
(`tools/version.json`). If an old version still shows, a hard refresh (Cmd+Shift+R)
fetches everything again.

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
