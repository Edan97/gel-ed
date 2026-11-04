// Ladders (size standards) the page knows about, top of the gel (largest) first: protein
// ladders in kDa, DNA ladders (dna: true) in bp. Add entries here; the ladder cards'
// dropdown lists the current mode's in order, then "Custom". A card's sizes start as
// listed here and can be edited on the card (Custom starts empty). short: the name
// written above the ladder's lane on the figure; supplier and catalogue number go in the
// caption. ng: DNA per band at the recommended load, where the supplier gives it (the
// brighter reference bands help pick the ladder's bands).

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
  // DNA: the first is the default in DNA mode. NEB's sheet for N0550 (as the 2-Log
  // ladder, same product): 19 bands, ng per band for 1 µg; 3.0, 1.0 and 0.5 kb brighter.
  "neb-1kb-plus": {
    dna: true,
    name: "Quick-Load® Purple 1 kb Plus DNA Ladder",
    short: "1 kb Plus", supplier: "NEB", catalog: "N0550S",
    kda: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
    ng: [40, 40, 48, 40, 32, 120, 40, 57, 45, 122, 34, 31, 27, 23, 124, 49, 37, 32, 61],
  },
};
