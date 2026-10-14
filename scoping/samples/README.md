# Sample images (not in the repository)

The scoping scripts and `scoping/run_all.py` expect these files here. They are lab data,
so they are kept out of git (see `.gitignore`).

| File | What |
|---|---|
| `210826_Het_Mut_IVP_Opt_2.tif` | First sample: 1710×1061 RGB TIFF |
| `gel_02.jpg` | Main sample: 2000×991 JPEG western, ladder + 12 lanes, labels above the lanes |
| `gel_02_lanes.csv` | Column range of each lane in `gel_02.jpg`: `name,start,end` |

Any gel works with the individual scripts; `run_all.py` and its checks are written for
these two.
