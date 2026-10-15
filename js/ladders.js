// Ladders (molecular-weight standards) the page knows about. Sizes in kDa, top of the
// gel (largest) first. Add entries here; the ladder cards' dropdown lists them in order,
// then "Custom" (sizes typed on the card).

export const LADDERS = {
  "magicmark-xp": {
    name: "MagicMark™ XP Western Protein Standard",
    kda: [220, 120, 100, 80, 60, 50, 40, 30, 20],
  },
  "pageruler-plus": {
    name: "PageRuler™ Plus Prestained Protein Ladder, 10 to 250 kDa",
    kda: [250, 130, 100, 70, 55, 35, 25, 15, 10],
  },
  "novex-sharp": {
    name: "Novex™ Sharp Pre-stained Protein Standard",
    kda: [260, 160, 110, 80, 60, 50, 40, 30, 20, 15, 10, 3.5],
  },
  "novex-sharp-15": {
    name: "Novex™ Sharp Pre-stained Protein Standard, 15 to 260 kDa",
    kda: [260, 160, 110, 80, 60, 50, 40, 30, 20, 15],
  },
  "precision-plus-dual": {
    name: "Precision Plus Protein™ Dual Color Standards",
    kda: [250, 150, 100, 75, 50, 37, 25, 20, 15, 10],
  },
};
