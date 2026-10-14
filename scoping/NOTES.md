# Scoping notes

Open questions and decisions from exploring the sample gels. Not a plan.

## Open

- **Annotation cutoff.** Images can carry labels, lines or other marks above (or
  around) the lanes, e.g. the lane names and "+ CPI" / "Veh" bars in `gel_02.jpg`
  (rows ~0–130). These are darker than any lane and will dominate lane finding.
  The cutoff must be found per image, never hard-coded: it differs on every gel
  and some images have none. In the strip profiles, annotation rows look different
  from gel: spiky, high-frequency text and flat bars, rather than smooth plateaus.
  Scripts take a manual `--rows` range in the meantime.
- **Lanes can overlap.** A lane's selection should be allowed to share columns
  with its neighbours; don't force the gel into non-overlapping strips. Adjacent
  lanes nearly touch in `gel_02.jpg`, and the ladder region (cols 31–137)
  already picks up the edge of the first sample lane.
- **Lane width vs blur.** Per-row edges at 25% of peak suggest the ladder widens
  from ~53 to ~60 px down the gel; whole-band half-max widths show no trend.
  Lower bands are blurrier, so this may be blur, not fanning. Check on a sample
  lane with sharp bands near the bottom.
- **Bands are sheared, not rotated.** Ladder leans ~3.5° right going down, but
  bands slope ~4.4° down to the right instead of being square to the lane. Image
  tilt alone can't explain it; compare lean and band slope across all lanes.

- **Sample lanes vs ladder (compare_lanes.py, gel_02).** Fitted independently over
  a shared row domain (140–990):
  - Lean (c1) is the only coefficient that's stable across degrees and methods.
    It falls from left to right across the gel: ladder ~3.1°, +CPI AV/AV neat
    ~2–4°, Veh AV/+ neat ~2–3°, Veh AV/AV 1 in 50 ~1.2–1.6°. If real, lanes aren't
    parallel (they converge slightly going down), so it isn't a single image tilt.
  - Degree 4 is only supported by the ladder (10 bands, full height). Sample lanes
    have 6–8 bands, often bunched, and their c2–c4 swing wildly with degree and
    method. Options: choose degree per lane from the data, or share the higher-order
    shape across lanes and fit only position + lean per lane.
  - Per-row edges fail on sloped bands (Veh AV/AV 1 in 50: bands rise to the right,
    so one row only crosses part of a band; row widths 20–120 px). Band centroids are
    more robust there. Per-row edges need band slope removed first, or band-level edges.
  - Edges that land on the selection boundary are not real edges: background bands
    that run across neighbouring lanes, and the bottom-right darkening. Reject them.
  - Smear below the saturated band is picked up as several "bands". Harmless for the
    centre-line, wrong for band calling.
  - Saturation itself doesn't hurt geometry: the saturated band's edges are sharp.

- **All 13 lanes of gel_02 (compare_lanes.py --lanes samples/gel_02_lanes.csv).**
  Fits hold up on 7 lanes (ladder, +CPI AV/+ neat, +CPI AV/AV neat, +CPI AV/+ 1 in 10,
  +CPI AV/AV 1 in 50, Veh AV/+ neat, Veh AV/AV neat); where they work, every lane leans
  right going down, less so towards the right of the gel. Failures:
  - **A dominant band hides the rest.** Bands are kept if they reach 10% of the
    lane's strongest band, so lanes with a strong triplet or saturated band keep only
    2–3 bands bunched in ~30–80 rows (both AV/AV 1 in 10, Veh AV/AV neat). Veh AV/AV
    1 in 10 then "leans" −13° to −18° from two bands 24 rows apart. The band threshold
    should come from the lane's noise level, not its strongest band.
  - **LOO alone can be fooled.** +CPI AV/AV 1 in 10 scores LOO 0.0 px because its
    three bands sit within 34 rows. Quality needs band count and row coverage too.
  - **Faint lanes** (AV/+ 1 in 10 / 1 in 50) give scattered centroids, LOO 10–17 px.
  - **False bands**: haze above +CPI AV/+ 1 in 50 (rows ~150–200), bottom-edge
    darkening (~row 970) in several lanes, background bands that cross lanes.
  - Neighbouring good lanes agree on lean, which argues for sharing the shape across
    the gel (lean varying smoothly with column) so weak lanes borrow from neighbours.

- **Band picking (band_peaks.py).** Replaced "keep peaks ≥ 10% of the strongest band"
  with: profile from the central 25% of lane columns (less blur from sloped bands),
  raw profile (no baseline correction, by preference: keep it real and messy),
  peaks by prominence ≥ 6 × the lane's own noise, plus
  shoulders from curvature (-d²/dy²) for bands merged into a neighbour. Saturated rows
  are flagged and shoulders next to them dropped (a flat saturated top fakes shoulders).
  gel_02 band counts, old → new: lane 5 3 → 10, lane 7 7 → 8, lane 11 2 → 7; lanes
  11 and 13 now resolve their triplets (13's third band is a shoulder at row 674).
  Not yet used by compare_lanes.py. Still to look at: lumps in the smear below the
  saturated bands in lanes 3 and 9 are picked as bands (896, 957, 928).

- **Masses (band_masses.py).** One ladder per gel (lane 1 on gel_02), sizes
  220, 120, 100, 80, 60, 50, 40, 30, 20 kDa top to bottom; the faint ladder band at
  row ~792 is assumed not real. Calibration: point-to-point (PCHIP) in log10 kDa vs
  row, no extrapolation. Running correction: each lane's rows mapped to lane 2 by a
  shift + stretch matched on profile shape (shift grows to +64 rows at lane 13).
  ASSUMPTION: lane 2 ran like the ladder (can't be checked on the gel). After
  correction, shared bands agree across lanes (~105–110, 74, 62–64, 51–52, triplet
  40/39/38 kDa). Lanes 6, 7, 12, 13 match poorly (corr < 0.5) and are flagged.
  The calibration curve has kinks (120→100 nearly as far apart as 220→120; 40→30
  stretched) which may mean the band-to-size assignment is off; worth checking
  against the ladder's datasheet image.

## Want to detect (not attempted yet)

- **Clusters of close bands on a raised background.** In `gel_02.jpg` lane
  "Veh AV/AV 1 in 50" (cols ~1780–1910), rows ~635–675 hold three bands bunched
  together, all sitting on a darker haze. The band finder currently reports two
  (rows 641, 664). We want to (a) resolve all three and (b) report the raised
  background under the cluster as its own feature, separate from the bands. The
  current background (one median per column, whole lane) can't see a local hump.

## Decisions so far

- Loader standardises everything to a 16-bit greyscale PNG / uint16 array
  (`gel_ed/load.py`); no inversion, cropping or contrast changes.
- Subtract background before any geometric transform (per-column background
  doesn't survive row shifting).
- Centre-lines are fitted as Legendre polynomials, degree chosen per lane by
  leave-one-band-out cross-validation over interior bands (max 4); near-ties
  (within max(10%, 0.5 px)) go to the lower degree. The chosen degree's LOO error
  doubles as a lane quality score. On gel_02: ladder 3–4, +CPI AV/AV neat 2,
  Veh AV/+ neat 1, Veh AV/AV 1 in 50 1–2 (but LOO ~7 px: unreliable lane).
- Two fits kept for comparison on imperfect lanes: band centroids
  (`ladder_centreline.py`) and joint per-row edges with centre + width
  (`ladder_edges.py`). `compare_lanes.py` runs both.

- `compare_lanes.py` takes bands from `band_peaks.find_bands` (not the old 10%-of-max
  rule), but only clear peaks locate a lane: prominence ≥ 0.5 × the lane's median peak,
  no shoulders. Using every band made LOO errors 2–10× worse (faint and cross-lane
  bands pull centroids sideways). A noise threshold (snr ≥ 15) was worse because the
  noise estimate is inflated on the ladder.
- Centre-line degree is capped at bands − 3 so LOO always has spare bands to check
  against (without the cap, lane 9 took degree 4 through 6 bands and "leaned" 10°).
- `scoping/run_all.py` regenerates all outputs and checks key results; versions pinned
  in requirements.txt. Write-up in `scoping/REPORT.md`.

- **Uncertainty** (band_masses.py): position (from FWHM/SNR), running correction
  (leftover mismatch vs lane 2), calibration (ladder leave-one-out). Relative = first
  two (for comparing lanes); absolute adds calibration.
- **~100 kDa bands**: not one protein within error (p = 4e-12). Two groups, 105.4 and
  109.2 kDa, each consistent. Lanes 4 and 10 contain both (robust). Lanes 6, 7, 13
  were put in the 105 group but have flagged alignments and look continuous with the
  109 band by eye: neat lanes ~105, diluted ~109? Two proteins or load-dependent
  mobility; can't tell from this gel.

- **Web page** (index.html, js/): editor card + lanes/bands overlay. Band finding is
  a port of find_bands, identical on all 13 gel_02 lanes (tests/parity.html). Lane
  placement: comb DP, inner lanes 0.8–1.2× pitch (0.6–1.4× let dividers drift into
  faint lanes: errors up to 51 px; now ≤ 23 px). Not in the page yet: masses,
  centre-lines, uncertainty, annotation cutoff (the crop does that job by hand).
- Gel data (images, lane CSVs, outputs) is kept out of the public repository.

## Sample quirks

- `gel_02.jpg` band at row ~792 in the ladder has a bright spot that splits it;
  its edges are unreliable.
- `gel_02.jpg` bottom-right corner (cols ~1650+, rows ~900+) darkens: background
  gradient, not a lane.
