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
3. **Lanes and bands**: lanes are numbered 1, 2, 3, …; bands are named by lane number
   and a letter counted from the top of the lane: 1.A, 1.B, … (AA, AB, … after Z), in
   the "band" column of the bands CSV.
   The number of lanes is estimated when an image loads and when
   you press **Find lanes**: it finds the pale gaps between lanes and counts them.
   Straighten the gel first; tilted lanes blur the gaps. Typing a number places exactly
   that many. Lanes are placed at the clearest gaps with widths kept regular; drag the
   dashed dividers to adjust.
   **Redo analysis** re-reads the profiles and finds bands again, keeping the lanes.
   **Click a band to mark it**: the nearest band found in that lane gets a hollow red
   circle at its middle (halfway between its edges, measured at half its darkness),
   labelled with its name; if no band was found there, one is created where you clicked.
   Drag a marked band to move it (it stays in its lane and snaps to the nearest band
   found); right-click it to delete it. The bands CSV lists marked and ladder bands with
   masses;
   **Show profiles** (off by default,
   for debugging) draws each lane's profile instead, with peaks, saturated peaks and
   shoulders marked. Profiles are read from the **edited image** by default; *original
   pixels* places each pixel of the loaded image through the edits and counts it once,
   never blended. The edit settings are written into every row of the bands CSV.
   **Ladders**: one card per ladder on the gel (add or remove cards); each card says
   which ladder it is and which lane it's in. The ladder's bands are picked
   automatically: as many as the ladder has sizes, keeping the most solid bands (a
   smudge or a band with a bright spot is less solid). They're shown as filled circles
   labelled with their size. **To correct one, drag it from the wrong band to the right
   one**: it snaps to the nearest band found (or stays where dropped), dropping it on
   another size swaps the two, and all masses update. Masses come from the nearest
   ladder, point-to-point in log(kDa) as in the Python version; outside the ladder they
   read ">220" / "<20". There's no correction yet for lanes running differently.
   Each lane's profile (mean darkness down its central columns) is drawn on the gel with
   the bands found in it: peaks (red), saturated peaks (black) and shoulders (orange:
   bands merged into a neighbour). Download the overlay, the edited image or a CSV of
   bands.

Band finding settings: threshold (in multiples of each lane's noise), how much of the
lane's centre is used, smoothing, and the noise window. Defaults match the Python version.

   **Method** (for the caption): SDS-PAGE with its stain (the default: Coomassie), or
   western blot with one or more antibodies (chosen from `js/antibodies.js` or typed in).
   **Ladder** (under the overlay): the selected ladder's name (editable) and its
   volume. **Lane annotations** (collapsible): per sample lane a label (pre-filled
   with the lane number, used on the figure), an annotation and a volume (µL), and one
   column per **group** (e.g. non-reducing / reducing): name it at the top, then click
   a lane's cell and drag to cover a continuous run of lanes. Pasting several lines
   into a lane box fills that lane and the ones below (tab-separated columns from a
   spreadsheet fill across label → annotation → volume). **Band annotations**
   (collapsible, appears once a band is marked): each marked band's estimated MW ±
   uncertainty and an annotation, also in the bands CSV. Masses are corrected for each
   lane running differently from the lane next to its ladder (a shift and slight
   stretch matched on the lane profiles, as in the Python version); the ± combines band
   position, the band's own width (FWHM/2.355) and the ladder bands' width, the leftover
   mismatch after that correction, and ladder calibration.
   Lanes that match poorly are flagged "?". Ladder sizes with no band found are placed by estimate
   (pale) so they can be dragged onto the right band.
4. **Figure**: the analysed gel, outlined, with the ladder sizes marked down the side under "MW (kDa)"
   (the leftmost ladder on the left, a second ladder on the right); sizes that would
   overlap get a longer line and sit further out. Above the gel: lane labels and group
   bars with names (groups that don't overlap share a row); each can be switched off. Download as PNG
   or copy to the clipboard. The **figure caption** underneath is written from the
   method, the ladder and lane annotations (label, annotation and volume where filled in) and the
   groups; it follows them until edited (Regenerate starts again) and can be copied.

**Session log** (Download box): a timestamped record of what the page and the user
did (image name and size, edits, lane count and dividers, bands found per lane, ladder
picks and drags, marked bands with masses, running-correction matches, errors), for
reporting problems. It stays in the browser until downloaded; no image data or typed
text goes in it.

## Repository layout

| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | The web page (plain JavaScript, no build step) |
| `js/bands.js` | Band finding (port of `scoping/band_peaks.py`) and lane placement |
| `js/signal.js` | Gaussian smoothing, peak finding etc. with scipy's definitions |
| `js/transform.js` | Rotation/skew/distort/perspective and the crop rule |
| `js/image.js` | File reading, including a small uncompressed-TIFF reader |
| `js/calibrate.js` | Ladder band picking (solidity) and the mass calibration (PCHIP, scipy's formulas) |
| `js/running.js` | Correction for lanes running differently (port of `scoping/band_masses.py`) |
| `js/antibodies.js` | Antibodies offered for western blots (used in the caption); add new ones here |
| `js/log.js` | Session log (in memory; downloaded on request) |
| `js/ladders.js` | The ladders the page knows (name and sizes); add new ones here |
| `js/icons.js` | Slider pictures, drawn with the editor's own transform |
| `tests/parity.html` | Checks the browser band finder against Python on the same pixels |
| `tests/lanes.html` | Lane counting on the samples (gel_02 has 13 lanes) |
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
