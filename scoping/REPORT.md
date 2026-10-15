# gel-ed scoping report

Can a small, lightweight tool find lanes and bands on a western blot / protein gel
image and estimate band masses? This report covers what was tried on two sample
images, what works, what doesn't, and what it would take to go further. It is a
scoping exercise, not a product: lane positions are still chosen by hand and the
methods have only been tuned on one good gel.

Running log of decisions and observations: [NOTES.md](NOTES.md).

The sample images and everything generated from them are kept out of the repository
(lab data), so figure links below only work in a local copy with the samples in place.

## Reproduce everything

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scoping/run_all.py
```

`run_all.py` clears `scoping/out/`, regenerates all 38 figures and tables from the
sample images (about 15 s), then checks seven results this report relies on:

| Check | Result on current code |
|---|---|
| Loader writes a 16-bit PNG identical to the source | ok |
| `load()` and the written PNG agree | ok |
| Ladder lane has 9 bands, one per size | ok (9) |
| Lane 5 and 11 triplets agree within 2 kDa after running correction | ok (40.0 / 38.7 / 38.1 vs 40.0 / 38.8 / 38.2) |
| Every band with a mass has relative and absolute uncertainty | ok |
| Lanes 4 and 10 each hold both the ~105 and ~109 kDa band | ok |
| Ladder lean is 2.5–3.5° | ok (3.09°) |

Package versions are pinned in `requirements.txt` (numpy, scipy, pillow, tifffile,
matplotlib). It was checked from a fresh virtual environment.

## Samples

| File | What it is |
|---|---|
| `samples/210826_Het_Mut_IVP_Opt_2.tif` | First sample: 1710×1061 RGB TIFF (grey stored as RGB). Messy; used only for the loader and a first look. |
| `samples/gel_02.jpg` | Main sample: 2000×991 JPEG western, 1 ladder + 12 sample lanes (+CPI and Veh, AV/+ and AV/AV at neat, 1 in 10, 1 in 50). Lane labels printed above the lanes. |
| `samples/gel_02_lanes.csv` | Hand-picked column range for each lane of gel_02. Ranges overlap. |

Lanes are numbered 1–13 left to right; lane 1 is the ladder.

**gel_02's ladder is uncertain.** The analysis reads it as MagicMark XP (220…20 kDa),
but the blot looks like an earlier export of the same experiment as Inna Navarro's
25/09/26 frozen-blood blot, whose ladder is Precision Plus Dual Color (there the
triplet is ~24 kDa, not ~40), and part of gel_02 may have run off the gel. So gel_02's
absolute masses shouldn't be trusted. Comparisons between its lanes (triplets agreeing,
same-protein tests, lane finding, profiles) don't depend on which ladder it is.

## Pipeline as it stands

```
image file ─► load (16-bit grey) ─► lanes (manual column ranges) ─► band picking ─┬─► masses
                                                                                  └─► centre-lines
```

| Step | Script | Status |
|---|---|---|
| Load any format to 16-bit greyscale | `gel_ed/load.py` | Works. TIFF (8/12/16-bit, float, multi-page, RGB), PNG, JPEG, BMP. Not proprietary formats (.scn). |
| Look at the data | `column_profiles.py`, `strip_profiles.py` | Exploration plots. |
| Band picking | `band_peaks.py` | Works well on gel_02. |
| Lane centre-lines | `ladder_centreline.py`, `ladder_edges.py`, `compare_lanes.py` | Works on the ladder and clear lanes; weak on faint lanes. |
| Masses | `band_masses.py` | Works, with stated assumptions. |
| Lane finding, annotation cutoff | — | Not built; done by hand. |

### Loading

Every format is standardised to a 2-D 16-bit greyscale array, saved as PNG if
needed. Nothing else is changed (no inversion, cropping or contrast). 8-bit sources
are scaled ×257 so the conversion is exact; 12-bit data keeps its values.

### Band picking (`band_peaks.py`)

For each lane:

1. **Profile**: mean darkness per row over the central 25% of the lane's columns.
   Using only the centre limits blurring from sloped bands (it is what resolves lane
   11's triplet). No baseline is subtracted: the profile is kept raw.
2. **Peaks**: local maxima whose prominence (rise above their own surroundings) is at
   least 6× the lane's noise. Thresholds scale with each lane's own noise, not its
   strongest band; the earlier "≥ 10% of the strongest band" rule found only 3 bands
   in lane 5 and 2 in lane 11.
3. **Shoulders**: bands merged into a neighbour don't make a maximum but bend the
   profile, so they appear as peaks of curvature (−d²/dy²). This finds the third
   band of the lane 13 triplet (row 674).
4. **Saturation**: rows where ≥ 20% of central pixels are near black. Shoulders next
   to saturated rows are dropped (a flat saturated top fakes them).

Figures: [`gel_02_peaks_gel_profiles.png`](out/gel_02_peaks_gel_profiles.png)
(profiles drawn on the gel), [`gel_02_peaks_overlay.png`](out/gel_02_peaks_overlay.png),
[`gel_02_peaks_profiles.png`](out/gel_02_peaks_profiles.png).

Band counts per lane (shoulders included): 9, 10, 7, 10, 11, 6, 9, 10, 7, 11, 12, 8, 8.

### Lane centre-lines (`compare_lanes.py`)

Each lane's centre-line x(y) is fitted as a Legendre polynomial over a shared row
range (140–990), so coefficients compare between lanes: c0 position, c1 lean, c2 bow,
c3 S-bend. Two measurements are kept side by side: band centroids (intensity-weighted
centres) and per-row band edges fitted jointly as centre ± width/2.

- **Degree** is chosen per lane by leave-one-band-out cross-validation over interior
  bands: the lowest degree within max(10%, 0.5 px) of the best. Degree is capped at
  bands − 3 so every fit has at least two spare bands to be checked against.
- **Which bands locate a lane**: only peaks at least half as prominent as the lane's
  median peak. Faint bands, shoulders and background bands that run across lanes find
  rows well but pull centroids sideways; using every band made errors 2–10× worse.
- The LOO error at the chosen degree doubles as a quality score for the lane.

Results ([`gel_02_lanes_overlay.png`](out/gel_02_lanes_overlay.png),
[`gel_02_lanes_summary.png`](out/gel_02_lanes_summary.png)):

- The ladder needs degree 4 (an S-shape); its lean is 3.1°.
- Lanes with clear bands (2, 3, 4, 7, 8, 11) lean 1.6–3.2°, mostly at degree 1.
  Lanes on the left lean more than lanes on the right, so lanes are not parallel and
  the lean is not a single image tilt.
- Lane 5's two methods disagree (centroids: degree 3, −1.3°; edges: degree 2, 2.2°):
  half its clear bands are the bunched triplet, which says little about lean.
- Faint or awkward lanes (6, 9, 10, 12, 13) fall back to degree 0 (a fixed
  position): their bands don't constrain a lean.
- Bands are sheared, not rotated: the ladder leans right going down but its bands
  slope down to the right (~4°) instead of being square to the lane.

The centre-lines are **not used** by band picking or masses: following them was tested
and doesn't help (next section).

#### Do profiles that follow the centre-line help? (`follow_centreline.py`)

Profiles are read from a straight strip down the middle 25% of each lane. Following
the fitted centre-line instead (same strip width, `band_masses.py --follow
centroid|edge`) was compared with the straight strip on gel_02, as is and rotated 3°
without straightening (`--rotate 3`; lanes carried along, labels whited out):

| | Straight strip | Following centroid fit | Following edge fit |
|---|---|---|---|
| **gel_02 as is** (strips move up to 18 px) | | | |
| Peaks / median SNR / peak height | 83 / 20.5 / ×1 | 82 / 19.4 / ×0.994 | 81 / 19.6 / ×0.993 |
| Same-protein χ² (105, 109, 74, 64, 52 kDa) | 4.3, 1.1, 1.4, 194, 13 | 3.5, 0.2, 2.5, 99, 13 | 3.5, 0.1, 2.2, 96, 16 |
| Triplet lane 5 vs 11 | 0.1 kDa apart | 0.1 kDa | 0.1 kDa |
| **Rotated 3°, not straightened** (strips move up to 57 px) | | | |
| Peaks / median SNR / peak height | 98 / 25.7 / ×1 | 99 / 22.7 / ×1.012 | 100 / 22.7 / ×0.999 |
| Same-protein χ² | 0.7, 5.8, 17, 17, 38 | 5.8, 1.7, 8.8, 30, 38 | 1.4, 1.8, 8.7, 15, 42 |
| Lane 5 triplet (straight gel: 40.0 / 38.7 / 38.1) | 39.5 / 37.5 / 36.3 | 39.8 / 38.5 / 38.0 | 39.7 / 38.5 / 37.9 |

(The 61–67 kDa window holds more than one protein, so its χ² is large whatever the
strip; the χ² counts are for comparing strips, not proteins.)

- On a straight gel it changes nothing that matters: bands are ~100 px wide and the
  37 px strip stays on them even where the lane leans 18 px away from it.
- On a tilted gel it recovers some masses (lane 5's triplet) and makes others worse;
  peak heights hardly change. Straightening the gel first (the rotation slider) fixes
  the tilt for every lane at once and is the better route.
- So the web page keeps the straight strip. "Show profiles" shades it, so a strip that
  has slid off its bands is visible.

#### Auto-straighten from the centre-lines? (`auto_straighten.py`)

Measure the tilt and set the editor's sliders. Lane lean (and how it changes across
the gel) comes from straight centre-lines through each lane's band centroids; band
slope from matching the row profiles of neighbouring narrow strips inside lanes.
Measuring the lean without lanes (top half vs bottom half of the gel) was tried first
and failed: it read 7 degrees on gel_02, as the halves hold different bands. Lanes
are vertical strips, so a leaning lane's bands run off its strip and the lean is
under-read when large; measuring, correcting and re-measuring until a round changes
less than 0.05 degrees (3-6 rounds) removes that.

Accuracy, by adding known changes to gel_02 (labels whited out): +3 deg rotation
recovered as -2.85, -2 deg as +1.86, +0.2 perspective as -0.198; what's left after
correction is under 0.11 deg of lean and 0.03 deg of band slope.

But straightening doesn't make masses better (whole pipeline, lanes found
automatically; `--masses`):

| gel_02 | Lane 5 / 11 triplets | Same-protein chi2 (105, 109, 74, 64, 52 kDa) |
|---|---|---|
| as is | agree within 0.1 kDa | 8.6, 0.5, 18, 18, 26 |
| lanes upright (skew + perspective; rows untouched) | agree within 0.1 kDa | 4.8, 0.9, 15, 17, 50 |
| full (rotation + skew + distort + perspective) | 3 kDa apart | 33, 0.9, 12, 38, 31 |
| lean taken out by rotation | 3 kDa apart | 57, 6.4, 22, 24, 53 |

gel_02's lanes lean (~2.4 deg) but its rows are true; rotating or distorting moves rows,
and the running correction then pairs lanes with stretch 1.00 and growing shifts
instead of the real small differences in running. Lean alone can't tell a gel that
ran crooked from a photo taken crooked, so rotation can't be set from the lanes;
something known to be horizontal (the line of wells, the gel's edge) would be needed.
On gel_02 rotated 3 deg, none of the three gets back to the original masses ("full" is
closest). Making lanes upright with skew and perspective is safe for masses.

Found on the way: a well-straightened gel has flat-topped lanes, and the lane counter
then tied the true lane width with half of it (25 lanes on gel_02). Fixed by scoring
each lane against its darker divider (count_lanes.py, js/bands.js); checked in run_all
and tests/lanes.html.

### Masses (`band_masses.py`)

1. **Ladder**: lane 1's 9 bands matched in order to 220, 120, 100, 80, 60, 50, 40,
   30, 20 kDa (an assumption; see Samples). A faint mark at row ~792 is assumed not to be a ladder band.
2. **Calibration**: log₁₀(kDa) vs row, point-to-point (PCHIP). No extrapolation;
   bands outside the ladder are reported as ">220" / "<20".
3. **Running correction**: with one ladder, each lane's rows are mapped onto lane 2
   (next to the ladder) by a shift and slight stretch that best match where the two
   profiles rise and fall. The shift grows across the right half of the gel to +64
   rows at lane 13. **Assumption**: lane 2 ran like the ladder; the ladder shares no
   bands with the samples, so this can't be checked on the gel.

After correction, bands shared between lanes agree: ~105–110, 74, 62–64, 51–52 kDa,
and the triplet at 40 / 39 / 38 kDa in every lane that has it. Without correction
the lane 11 triplet read ~3 kDa (7%) heavier than lane 5's.
Lanes 6, 7, 12, 13 match lane 2 poorly (correlation < 0.5) and are flagged "?".

Figures: [`gel_02_masses.png`](out/gel_02_masses.png),
[`gel_02_calibration.png`](out/gel_02_calibration.png). Table: `out/gel_02_masses.csv`.

#### Uncertainty

Each mass carries two uncertainties (1σ), built from three sources:

| Source | How it's estimated | Typical size on gel_02 |
|---|---|---|
| Band position | 1.5 × (FWHM / 2.355) / SNR for peaks (min 0.25 rows); 2 rows for shoulders; saturated run length / √12 for saturated bands | 0.2–3 rows; ~18 rows for the two saturated bands |
| Running correction | Leftover mismatch between a lane's clear peaks and lane 2's after alignment, minus what position errors explain | 0.9–4.7 rows per lane |
| Calibration | Ladder leave-one-out, interpolated by row (conservative: doubles the gap) | ±1% at 50–80 kDa, ±4–6% at 40 and 100 kDa, ±19–21% at 120 and 30 kDa |

Rows convert to mass through the local slope of the calibration curve.

- **Relative** (position + running correction) is for comparing bands on the same
  gel: the calibration error is shared by every lane, so it can't make them differ.
  Typically ±0.1–1%.
- **Absolute** (relative + calibration) is for a band's mass on its own. Dominated by
  the calibration: e.g. 105 ± 10 kDa, 74 ± 1 kDa, 39 ± 2 kDa. The figure labels show
  this.
- **Not included** (can't be estimated from one gel): the ladder band-to-size
  assignment, the reference-lane assumption, and alignment picking the wrong pairing
  (see below).

#### Same protein? The bands around 105–110 kDa

`--same LO HI --same-lanes ...` takes the strongest peak in a mass window in each lane
and tests whether they share one mass (χ² on relative uncertainties).
Figures: [`gel_02_same_protein_zoom.png`](out/gel_02_same_protein_zoom.png),
`gel_02_same_protein_*.png`; table `out/gel_02_same_protein.csv`.

- All bands at ~100 kDa across lanes 8–13 as one protein: **rejected** (χ² = 62 on
  5 dof, p = 4×10⁻¹²). They fall into two groups 18–20 rows apart after correction.
- Split at 107.5 kDa, each group is consistent: **105.4 kDa** (lanes 2, 3, 4, 6, 7, 8,
  9, 10, 13; χ² = 4.3 on 8, p = 0.83) and **109.2 kDa** (lanes 4, 5, 10, 11, 12;
  χ² = 1.1 on 4, p = 0.90). χ² close to its degrees of freedom suggests the relative
  uncertainties are about the right size.
- **Robust**: lanes 4 and 10 each contain both bands (19 and 18 rows apart within the
  lane, no alignment involved), so two species ~3.5% apart exist on this gel.
- **Not robust**: which band a lane with only one of them shows. Lanes 6, 7 and 13
  were assigned to the 105 kDa group, but those are the three lanes with flagged
  alignment, and by eye the band runs continuously 5 → 6 → 7 (rows 292, 292, 286) and
  10 → 11 → 12 → 13 (264, 251, 235, 218), which would put them in the 109 kDa group.
  A wrong pairing in the alignment isn't covered by the uncertainty. If those lanes
  belong with 109 kDa, the pattern is: neat lanes show ~105, diluted lanes ~109,
  1 in 10 AV/+ shows both. That could be two proteins, or one protein whose
  mobility shifts with how heavily the lane is loaded; this gel can't separate those.

## Web page

A first browser version (`index.html`, `js/`; see the repository README) covers image
editing and the band-finding overlay:

- **Edit image** card: brightness, contrast, invert; rotation, skew, distort and
  perspective as one projective transform about the image centre; a crop that can never
  include area outside the original image (all four corners must lie inside the
  transformed outline).
- **Lane count**: found from the pale gaps between lanes after rescaling the column
  profile to its local range (a faint lane next to a saturated one then both read as
  lanes); lane width = median gap spacing; missed gaps filled where two gaps are about
  two lane widths apart; empty edge margins not counted. gel_02: 13 lanes, with or
  without the labels, and on the 3°-rotated copy once straightened (`tests/lanes.html`).
  Tilted lanes blur the gaps (the unstraightened copy gives 27), so straighten first.
  Looking for a repeating spacing (autocorrelation) failed: gel_02's lanes alternate
  faint/strong, so the pattern repeats every 2 or 6 lanes more strongly than every lane.
- **Lanes**: placed like the teeth of a comb (dividers on the palest columns, inner lanes
  0.8–1.2× the average width, outer lanes 0.3–1.6×), then adjustable by dragging. On
  gel_02 with 13 lanes, every divider lands within 23 px of the true gap (most within
  10); the two largest errors sit next to the saturated lanes.
- **Bands**: `js/bands.js` is a port of `band_peaks.find_bands`, with scipy's smoothing,
  peak prominence and width definitions reimplemented. `tests/parity.html` runs it on
  the pixels written by `scoping/js_reference.py`: all 13 lanes of gel_02 give exactly
  the same bands as Python.
- **Reading profiles through the transform.** Geometric edits resample the image: each
  new pixel blends up to four originals. On gel_02 a half-pixel shift or a 2° rotation and
  back loses 3–4 of 118 borderline bands. So the page reads profiles from the *original*
  pixels: each is sent through the edit's transform to its place in the edited view and
  counted once in that lane and row, never blended. No crop to the largest blank-free
  rectangle is needed (blank corners hold no pixels), so the whole image is analysed.
  Test (`tests/straighten.html`): a copy of gel_02 rotated 3°, straightened in the page,
  with the same lanes as the original. Original pixels: 111 of 115 bands recovered,
  2 extra. Edited image: 110 recovered, 10 extra. Both within 0.5 rows. The few missing
  bands come from the test copy itself, which was resampled once to make it.
- **Ladder bands and masses**: each ladder card has a type and a lane. The ladder's
  bands are the most solid candidates (share of the band's span that is actually dark),
  as many as the ladder has sizes, ties broken by strength. On gel_02 this drops the
  smudge at row ~789 (solidity 0.78; real bands 0.94–1.00) and leaves the 9 picked by
  eye. Strength, thickness and left/right agreement alone don't separate it (faint real
  bands at the bottom score as low). Confirmation is by hand: ladder bands are filled
  circles labelled with their size, dragged from a wrong band to the right one. Masses
  are read point-to-point from the nearest ladder (JS PCHIP matches scipy to 1e-6).
- Not in the web page yet: correction for lanes running differently, centre-lines,
  uncertainties.

## Known limitations

| Limitation | Effect | Possible fix |
|---|---|---|
| Lanes are chosen by hand | Not automatic | Strip profiles show lanes as clear plateaus; fit lane edges per strip with an evenly spaced comb as a constraint. |
| Annotation cutoff is manual (row 140) | Labels above lanes would be read as bands | Detect by texture: text is spiky and high-frequency, gel is smooth. Must not be hard-coded. |
| Ladder band assignment is uncertain | The calibration has kinks (120→100 kDa as far apart as 220→120); a different band-to-size match is possible. Little effect on samples, which fall in 38–110 kDa. | Datasheet image for the ladder; or user confirms bands. |
| Reference lane assumed to run like the ladder | Untestable systematic offset for all lanes | Second ladder, or shared bands between ladder and samples. |
| Running correction is a straight-line map | Can't follow running differences that vary down the gel | Higher-degree map, with degree chosen by LOO on shared bands. |
| Running correction can pair the wrong bands | On weakly matching lanes (6, 7, 12, 13) a band can be matched to its neighbour; the uncertainty doesn't cover this, and same-protein group membership of those lanes is unreliable | Report how close the second-best alignment comes; chain alignment through neighbouring lanes instead of matching every lane to lane 2 directly. |
| Uncertainty model is simple | Position error formula and shoulder ±2 rows are judgements; calibration error is a conservative leave-one-out envelope | Validate on repeat gels or replicate lanes. |
| Centre-lines not used for reading profiles | Band rows read from a fixed central strip; the ladder leans out of its strip near the bottom (0–5 rows, ~3–4% mass at 20–30 kDa) | Read each lane along its fitted centre-line. |
| Faint lanes give no usable centre-line | Fixed position only | Share shape across lanes (lean varying smoothly across the gel); fit only position per lane. |
| Smear | Lumps in the smear below saturated bands are picked as bands (lanes 3, 9) | Define smear (broad rise under/below a band) as its own feature. |
| Clusters on a raised background | Triplets resolve, but the haze under them isn't reported | Report local background under clusters as its own feature. |
| Noise estimate | Inflated on lanes with many sharp or leaning bands (ladder ~3–9× other lanes) | Estimate noise from a band-free region, or from repeated measurements. |
| One good gel | Methods tuned on gel_02 only; the first sample (saturated smear lane, uneven background) is untested beyond loading | More sample gels, including bad ones. |

## How hard would a lightweight tool be?

The core (load → bands → masses) works on a good gel with a few hundred lines of
numpy/scipy, and runs in seconds. What makes it a tool rather than a script is
handling gels that aren't this nice, which is where most of the effort would go:

- **Straightforward**: loading, band picking, mass calibration, figures and tables.
  These exist and behave well on gel_02.
- **Moderate**: automatic lane finding and annotation cutoff (clear signals exist in
  the strip profiles), reading lanes along fitted centre-lines, a smear definition.
- **Open-ended**: robustness across many gels (faint, smeared, damaged, odd
  ladders), and the ladder/reference assumptions with only one ladder. These need
  more sample images and probably a light manual-correction step in the UI.

A practical first version would keep a human in the loop: draw or nudge lane
boundaries, confirm ladder bands, then compute. That removes the two hardest
automatic steps and leaves the parts that already work.

**Web (github.io)**: everything uses numpy/scipy only, so it could run in the browser
via Pyodide, or be ported to plain JavaScript like FPLC-ed. The heaviest step (the
alignment grid search) takes well under a second per lane.

## Files

| Path | What |
|---|---|
| `gel_ed/load.py` | Loader (any format → 16-bit greyscale) |
| `scoping/run_all.py` | Regenerate everything and check results |
| `scoping/lanes.py` | Read lane CSVs, number lanes |
| `scoping/count_lanes.py` | Count and place lanes as the web page does (comb fit to band content) |
| `scoping/band_peaks.py` | Band picking; profile figures |
| `scoping/band_masses.py` | Masses with running correction |
| `scoping/compare_lanes.py` | Centre-lines for all lanes, degree by LOO |
| `scoping/follow_centreline.py` | Straight strip vs following the centre-line: profiles and masses |
| `scoping/auto_straighten.py` | Measure tilt and set the editor's sliders; accuracy and masses checks |
| `scoping/ladder_centreline.py` | Ladder centre-line from band centroids (exploration) |
| `scoping/ladder_edges.py` | Ladder outline from per-row edges (exploration) |
| `scoping/column_profiles.py`, `strip_profiles.py` | First-look plots |
| `scoping/NOTES.md` | Running log |
