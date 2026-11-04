# gel-ed

Simple, lightweight band finding for gel and western blot images. Early stage: a web
page for straightening, cropping and reading lane profiles, plus the Python scoping work
behind it.

**Use it:** https://edan97.github.io/gel-ed/ (runs in your browser; images are never uploaded)

## The web page

0. **Protein or DNA** (the switch under the title; remembered between visits). Protein: SDS-PAGE and
   western blots, ladders in kDa. DNA: agarose gels, ladders in bp (the Quick-Load
   Purple 1 kb Plus DNA Ladder, NEB N0550S, is the default: 19 bands, 10 kb to 100 bp).
   In DNA mode a photo of light bands on black is read inverted (band finding wants dark
   bands on light) but shown as photographed, light bands on black, on screen and in the
   figure; the analysed area starts as the gel slab (the glowing rectangle, its bright rim
   trimmed: `scoping/gel_slab.py`), since the black surround and the slab's edges made
   the lane count take lanes several times too wide; only a slab-sized one (60% of the
   photo each way) at least 1.3x brighter than its surround, else (a dim photo whose gel
   fills the frame) the whole photo. Lane width comes from the wells where a row of them
   shows (`scoping/wells.py`: the teeth of gel between wells, or the wells, as regularly
   spaced peaks along the top; at least 8): one lane per well, loaded or not, so a gel
   with a few wells loaded doesn't get lanes two or three times too wide, and the empty
   wells at either end stay lanes (marked empty) rather than becoming margin. The method fields become agarose %,
   buffer, stain, loading dye, voltage, time and imager (defaults from the lab's
   notebooks: 1% agarose in TAE with SYBR Safe, NEB purple loading dye to 1×, 100 V 40
   min, ChemiDoc); antibodies, transfer and protein sample preparation are hidden; the
   ladder scale on the figure is in kb, one decimal (10.0, 3.0, 0.5), crowded sizes left
   out to start with; the ladder's brighter reference bands (at least twice the median
   ng per band: the 1 kb Plus's 3.0, 1.0 and 0.5 kb) are always labelled, on the figure
   and on the gel, and other labels too close to them give way. Masses become sizes in bp. Two rows of wells on one gel aren't handled yet: crop to one row.
1. **Load** a PNG, JPEG, BMP, WebP or uncompressed TIFF. Colour is converted to greyscale.
   If there's plain background round the gel (a tray, light box or bench, lighter or
   darker than the gel), the analysed area starts as the gel with a small margin
   (`gel_box` in `scoping/gel_slab.py`): the background is fitted as a gentle slope
   from the photo's outer strip, the gel is what differs from it (by half the gel's own
   level, taken from its paler part so a pale gel still counts), and the box is the rows
   and columns mostly gel, gaps of a dark ladder or smear bridged. It must be a solid
   block (70% gel), so a trimmed scan isn't cropped down to its bands; a side whose
   photo edge is gel isn't cropped; the top keeps a wider margin (a pale stacking gel
   near the wells). On the lab's 39 ChemiDoc protein photos every crop keeps all lanes
   and bands; the trimmed sample scans keep every lane; padded with plain, noisy,
   lighter, darker or graded background, every sample's gel is found within 5% of its
   edges (`run_all.py` checks these). Drag the corners to change it.
2. **Edit image** (a drop-down card):
   - Brightness and contrast.
   - Invert. Band finding expects dark bands on a light background, so invert
     white-on-black images before reading the results.
   - Rotation, perspective, skew and distort sliders, each starting in the middle (no
     change) and covering small corrections (rotation +-5 degrees). A small picture at
     each end of every slider shows what that end does (exaggerated).
     Perspective narrows the top or bottom; skew slides rows sideways (straightens
     leaning lanes); distort slides columns up and down (levels bands that slope across
     the gel). Double-click a slider to reset it.
   - Flip horizontally: mirrors the gel left-right (before the other edits). Lanes are
     found again; ladders, lane labels, annotations and groups move to the mirrored lane.
   - The whole edited image always stays in view, scaled to fit the display box, which
     is no taller than most of the window (as is the lanes-and-bands view).
   - The whole image is analysed; blank corners left by rotating contribute nothing. Drag
     the rectangle's corners and edges to leave something out (e.g. labels above the
     lanes); everything outside it is greyed out. Lanes already placed stay where they are
     on the gel (lanes cut off go; what's left at the edges is empty space).
3. **Lanes and bands**: lanes are numbered 1, 2, 3, …; bands are named by lane number
   and a letter counted from the top of the lane: 1.A, 1.B, … (AA, AB, … after Z), in
   the "band" column of the bands CSV.
   The number of lanes is estimated when an image loads and when
   you press **Find lanes**: it fits evenly spaced lanes to where the bands are (each
   column's darkness above its own background), so empty lanes between loaded ones are
   counted too; empty lanes at the edges start as empty space, not lanes
   (`scoping/count_lanes.py` does the same in Python). Clicking a lane's number above the
   gel steps it through: a lane → **empty** (∅: nothing loaded; it keeps its number, is
   hatched, its bands aren't shown or clickable, it's "Empty" in the lane table and left
   off the figure unless **annotate empty lanes** is ticked) → **removed** (×: space
   between lanes, as the × in its row of the lane annotations) → a lane again (+). Removed
   lanes aren't numbered: annotations, marked bands, ladders and groups move with their
   lane. On DNA gels empty lanes are found for you: a lane whose middle is no darker than
   5% of the way from the palest to the darkest columns (`lane_fill` in
   `scoping/count_lanes.py`; Nicole's empty wells are at most 4%, loaded lanes 12% or more).
   The lane annotations and sample preparation tables leave empty lanes out unless **show
   empty lanes** (above the table, with how many) is ticked. Straighten the gel first; tilted
   lanes blur the gaps. Typing a number places exactly that many across the image, at the
   clearest gaps with widths kept regular; drag the dashed dividers to adjust (the outer
   ones too).
   **Redo analysis** re-reads the profiles and finds bands again, keeping the lanes.
   **Click a band to mark it**: the nearest band found in that lane gets a hollow red
   circle at its middle (halfway between its edges, measured at half its darkness),
   labelled with its name; if no band was found there, one is created where you clicked.
   Drag a marked band to move it (it stays in its lane and snaps to the nearest band
   found); right-click it to delete it. The bands CSV lists marked and ladder bands with
   masses;
   **Show profiles** (off by default,
   for debugging) draws each lane's profile instead, with peaks, saturated peaks and
   shoulders marked, over the shaded columns it's read from (the lane's middle, set by
   "Centre of lane used"; band rows from there give the masses). It also shows each ladder's
   **calibration plot** under the gel, as in Bio-Rad's tech note 3133: MW (log scale)
   against distance down the gel, with the ladder bands, the curve masses are read from,
   and the marked bands at their row corrected for running, with their ± as a bar; dashed,
   a straight line of best fit through all the ladder bands with its r², as a check on the
   gel (masses aren't read from it). Profiles are read from the **edited image** by default; *original
   pixels* places each pixel of the loaded image through the edits and counts it once,
   never blended. The edit settings are written into every row of the bands CSV.
   **Ladders**: one card per ladder on the gel (add or remove cards). When lanes are
   counted and there's one ladder, a second ladder card is added for the best-scoring
   other lane (under 1.0) whose bands line up with the first ladder's: a band for 60%
   of its sizes, at rows a straight line (tilt, stretch) maps onto the first's within 1%
   of the gel's height (`second_ladder` in `scoping/ladder_pick.py`). A lane full of
   bands can score like a ladder (23 of the lab's 39 protein gels had one) but doesn't
   line up; a ladder at each end of a DNA gel does. Remove the card if it's wrong. Each card says
   which ladder it is (from `js/ladders.js`, or Custom), its sizes in kDa or bp (pre-filled
   from the ladder, editable: delete sizes that ran off; Custom starts empty)
   and which lane it's in. The lane starts as **Auto**: the page picks the lane whose
   bands fit the ladder's sizes best (evenly changing spacing, a band for most sizes),
   wherever the ladder is on the gel, and shows it as "Auto (lane 8)". Choosing a lane
   number fixes it; choosing Auto again hands it back. The ladder's bands are picked
   automatically: solid bands only (a smudge or a band with a bright spot is less solid),
   and the assignment of sizes to them whose spacing fits best (log size changes smoothly
   down a ladder). A size can be left without a band, at a cost, so a well or smudge
   above the ladder doesn't push every size down one; rows where nearly every lane has a
   peak near the top (wells, the stacking line) aren't ladder bands; a shoulder on a
   bigger band can be picked, at a cost (a DNA ladder's 0.9, 0.8 and 0.6 kb bands sit on
   the flanks of the brighter 1.0 and 0.5 kb ones); and where the ladder gives ng per
   band, brightness against mass breaks ties. Sizes left without a band are placed by
   estimate (pale), between their neighbours, to drag onto the right band. A ladder
   lane is bands from top to bottom, which makes its own noise estimate too high; if too
   few bands are found there, it's read again with the gel's typical lane noise
   (`scoping/ladder_pick.py` does the same in Python). They're shown as filled circles
   labelled with their size. **To correct one, drag it from the wrong band to the right
   one**: it snaps to the nearest band found (or stays where dropped), dropping it on
   another size swaps the two, and all masses update. **Right-click a ladder point** to take that
   size out of the calibration (a band the ladder ran off, or one that's unclear);
   choosing the ladder or its lane again picks its bands afresh. Masses come from each lane's
   standard curve (below), point-to-point in log(size). A little past either end of the
   ladder they're extrapolated: a straight line in log size with the slope of the
   ladder's last interval, out to 1.5x the end size, shown with a "~" (e.g. "~11500 ±
   1600"); the ± grows with the distance past the end (rows past x the larger of the
   change in slope over the last two intervals and a quarter of the slope). Further out
   they read ">220" / "<20".
   Each lane's profile (mean darkness down its central columns) is drawn on the gel with
   the bands found in it: peaks (red), saturated peaks (black) and shoulders (orange:
   bands merged into a neighbour). Download the overlay, the edited image or a CSV of
   bands.

Band finding settings: threshold (in multiples of each lane's noise), how much of the
lane's centre is used, smoothing, and the noise window. Defaults match the Python version.

   **Method** (for the caption): SDS-PAGE with its stain (the default: Coomassie), or
   western blot with one or more antibodies (chosen from `js/antibodies.js` or typed in).
   How the gel was run (gel, wells, running buffer, sample heating, voltage and time) and,
   for western blots, the transfer (membrane, transfer conditions, Ponceau S check,
   blocking, detection): each field filled in goes into the caption. They start at what
   the lab's notebooks use most (NuPAGE 4–12% Bis-Tris in MES, 95 °C for 5 min, 180 V for
   35 min; nitrocellulose, 100 V for 1 h in the cold room, Ponceau S, 5% BSA in TBS, ECL);
   wells start blank.
   **Ladder** (under the overlay): the selected ladder's name with its supplier and
   catalogue number (editable) and its volume. **Lane annotations** (collapsible): per sample lane a label (pre-filled
   with the lane number, used on the figure; Enter starts a new line, e.g. genotype over
   dilution), an annotation and a volume (µL), and one
   column per **group** (e.g. non-reducing / reducing): name it at the top, then click
   a lane's cell and drag to cover a continuous run of lanes. Pasting several lines
   into a lane box fills that lane and the ones below (tab-separated columns from a
   spreadsheet fill across label → annotation → volume). **Sample preparation**
   (collapsed to start with): per sample lane a concentration (mg/mL), the amount to load (µg) and a
   **Reduced** tick (lanes in a group named Reduced or R start ticked); every tube is made
   up to the total (20 µL) with loading dye (4×, so 5 µL) and, in reduced lanes, the
   reducing agent (2 µL 1 M DTT); the sample volume is amount ÷
   concentration and the diluent (PBS) makes up the rest. With no amount, the sample fills
   what's left (e.g. 15 µL non-reduced, 13 µL reduced). Amounts that don't fit are
   flagged with the most that does. The amounts go in the caption ("5 µg, 20 µL").
   **Band annotations**
   (collapsible, appears once a band is marked): each marked band's estimated MW ±
   uncertainty and an annotation, also in the bands CSV. Sizes are read as in Bio-Rad's
   tech note 3133: off the standard curve (log size against distance migrated) at the
   band's own row. Each lane has its own curve: the ladder's band rows carried straight
   across to it, or with a ladder on each side, along the line joining each size in the
   two (interpolated by where the lane sits between them), so a gel that ran a little
   faster on one side is followed. No other correction: an earlier one matched each
   lane's profile against the lane next to the ladder, and on lanes with few bands it
   found false matches (a 35-row shift on a DNA gel, moving a band above the 10 kb
   marker to 7.7 kb). The ± combines band position, the band's own width (FWHM/2.355),
   the ladder bands' width and the curve's own uncertainty (leave-one-out). Ladder sizes with no band found are placed by estimate
   (pale) so they can be dragged onto the right band.
4. **Figure**: the analysed gel, outlined, with the ladder sizes marked down the side under "MW (kDa)"
   or "Size (kb)" (the leftmost ladder on the left, a second ladder on the right; a lone
   ladder in the right half of the gel on the right); size labels shrink
   (to 65%) so close ladder bands' labels fit side by side, and only then get a longer
   line further out; untick **crowded sizes** to leave those out instead (going down the
   side, a size too close to the last one shown is skipped, and the rest grow to fit). Lane labels shrink (to 60%) to fit over their lanes. Above the gel: lane labels and group
   bars with names (groups that don't overlap share a row); each can be switched off.
   **lane list** numbers the lanes above the gel and lists them beside it ("2. 9D9-mIgG1
   NR"), for long sample names; **ladder names** writes each ladder's short name above its
   lane (upright if it doesn't fit across). **ladder sizes** switches the MW scale off.
   **marked bands** puts a red arrowhead and the band's name (e.g. 4.A) beside each band
   you've marked; **band key** lists the names right of the gel with each band's
   annotation and estimated MW ("4.A cleaved (21 kDa)"). The full band table (with ±) is
   under Tables for the notebook, to copy. **Keep as panel** keeps the figure as panel A;
   the next image loaded is drawn beside it as B (all panels scaled to the same height,
   lettered), and the caption gives each panel's caption after its letter (e.g. a
   Coomassie gel and its western blot). **Clear panels** goes back to one figure.
   Download as PNG or copy to the clipboard. The **figure caption** underneath is written from the
   method, the ladder and lane annotations (label, annotation and volume where filled in; if two
   lanes share a label, lanes are also named by number) and the
   groups; it follows them until edited (Regenerate starts again) and can be copied.
5. **Tables for the notebook** (under the figure): the run method (Parameter / Details,
   with the ladder and sample preparation), lane assignments (lane, sample, groups,
   amount, volume), sample preparation (per lane: concentration, amount, sample, diluent,
   reducing agent, dye, total) and band annotations (band, lane, MW ±, annotation). Each
   has its own **Copy**, and **Copy all** copies them one after another under their
   headings: they paste as tables into LabArchives or Word and as cells into a
   spreadsheet.

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
| `js/transform.js` | Flip/rotation/perspective/skew/distort and the crop rule |
| `js/image.js` | File reading, including a small uncompressed-TIFF reader |
| `js/calibrate.js` | Ladder band picking (solidity) and the mass calibration (PCHIP, scipy's formulas) |
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
fetches everything again. Features new in a version carry an orange **NEW** badge
(`<span class="new">new</span>` in `index.html`) so people already using the page spot
them; take the badges off a version or two later.

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

## Credits

The DNA icon on the Protein / DNA switch is Lucide's "dna" icon
([lucide.dev](https://lucide.dev)), used under the ISC License:

```
Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The protein icon (an alpha helix) was drawn for gel-ed.
