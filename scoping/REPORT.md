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

The centre-lines are **not yet used** by band picking or masses (see below).

### Masses (`band_masses.py`)

1. **Ladder**: lane 1's 9 bands matched in order to 220, 120, 100, 80, 60, 50, 40,
   30, 20 kDa. A faint mark at row ~792 is assumed not to be a ladder band.
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
- Masses, centre-lines and uncertainties are not in the web page yet.

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
| `scoping/band_peaks.py` | Band picking; profile figures |
| `scoping/band_masses.py` | Masses with running correction |
| `scoping/compare_lanes.py` | Centre-lines for all lanes, degree by LOO |
| `scoping/ladder_centreline.py` | Ladder centre-line from band centroids (exploration) |
| `scoping/ladder_edges.py` | Ladder outline from per-row edges (exploration) |
| `scoping/column_profiles.py`, `strip_profiles.py` | First-look plots |
| `scoping/NOTES.md` | Running log |
