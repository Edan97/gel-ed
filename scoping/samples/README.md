# Sample images (not in the repository)

The scoping scripts and `scoping/run_all.py` expect these files here. They are lab data,
so they are kept out of git (see `.gitignore`).

| File | What |
|---|---|
| `210826_Het_Mut_IVP_Opt_2.tif` | First sample: 1710×1061 RGB TIFF |
| `gel_02.jpg` | Main sample: 2000×991 JPEG western, ladder + 12 lanes, labels above the lanes |
| `gel_02_lanes.csv` | Column range of each lane in `gel_02.jpg`: `name,start,end` |
| `gel_04.jpg` | 980×754 JPEG SDS-PAGE, 15 lanes, BenchMark™ Protein Ladder (15 bands) in the middle lane (8) |
| `dna/nicole_1.jpg` … `nicole_4.jpg` | Optional. Nicole Chapman's agarose gels (ChemiDoc, SYBR Safe, light bands on black, 1 kb Plus ladder). 1: about 30 wells, ladders at both ends; 2: ladder in lane 1, every other well loaded; 3 and 4: one gel, two exposures, two rows of wells. `run_all.py` checks 1 and 2 when present |

Any gel works with the individual scripts; `run_all.py` and its checks are written for
these.

`padded/` (optional, made by hand for testing the crop on loading): `gel_04_lightbox.png`
(gel_04 on a plain white surround) and `gel_03_bench.png` (gel_03 on a dark, noisy one).
`run_all.py` makes its own padded copies in memory.

The lab's own ChemiDoc photos (39 Coomassie protein gels, 10 SYBR Safe DNA gels, one
chemiluminescence blot) go in `references/` at the top of the repository (also kept out
of git). `scoping/lab_survey.py references OUT` runs the page's pipeline on all of them
and draws what it found; `run_all.py` checks a few of them when they're there.
