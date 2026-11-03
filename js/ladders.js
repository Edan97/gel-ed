// Ladders (molecular-weight standards) the page knows about. Sizes in kDa, top of the
// gel (largest) first. Add entries here; the ladder cards' dropdown lists them in order,
// then "Custom". A card's sizes start as listed here
// and can be edited on the card (Custom starts empty). short: the name written above the
// ladder's lane on the figure; supplier and catalogue number go in the caption.

export const LADDERS = {
  // first = the default for new ladder cards
  "novex-sharp-15": {
    name: "Novex™ Sharp Pre-stained Protein Standard, 15 to 260 kDa",
    short: "Novex Sharp", supplier: "Thermo Fisher Scientific", catalog: "LC5800",
    kda: [260, 160, 110, 80, 60, 50, 40, 30, 20, 15],
  },
  "magicmark-xp": {
    name: "MagicMark™ XP Western Protein Standard",
    short: "MagicMark XP", supplier: "Thermo Fisher Scientific", catalog: "LC5602",
    kda: [220, 120, 100, 80, 60, 50, 40, 30, 20],
  },
  "pageruler-plus": {
    name: "PageRuler™ Plus Prestained Protein Ladder, 10 to 250 kDa",
    short: "PageRuler Plus", supplier: "Thermo Fisher Scientific", catalog: "26619",
    kda: [250, 130, 100, 70, 55, 35, 25, 15, 10],
  },
  "novex-sharp": {
    name: "Novex™ Sharp Pre-stained Protein Standard",
    short: "Novex Sharp", supplier: "Thermo Fisher Scientific", catalog: "LC5800",
    kda: [260, 160, 110, 80, 60, 50, 40, 30, 20, 15, 10, 3.5],
  },
  "precision-plus-dual": {
    name: "Precision Plus Protein™ Dual Color Standards",
    short: "Precision Plus", supplier: "Bio-Rad", catalog: "1610374",
    kda: [250, 150, 100, 75, 50, 37, 25, 20, 15, 10],
  },
  "benchmark": {
    name: "BenchMark™ Protein Ladder",
    short: "BenchMark", supplier: "Thermo Fisher Scientific", catalog: "10747012",
    kda: [220, 160, 120, 100, 90, 80, 70, 60, 50, 40, 30, 25, 20, 15, 10],
  },
};
