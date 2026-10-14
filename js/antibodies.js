// Antibodies the Method section offers for western blots (used in the caption). Add
// entries here; the dropdown lists them in order, then "Other (type your own)".

export const ANTIBODIES = {
  "his-ma1-80218": {
    name: "6x-His Tag Monoclonal Antibody HRP",
    supplier: "Thermo Scientific",
    catalog: "MA1-80218",
    dilution: "1:3000",
  },
  "goat-anti-mouse-p0447": {
    name: "Polyclonal Goat Anti-Mouse Immunoglobulins/HRP",
    supplier: "",
    catalog: "P0447",
    dilution: "1:5000",
  },
};

// As listed in the dropdown, e.g. "6x-His Tag Monoclonal Antibody HRP, cat. # MA1-80218 (Thermo Scientific), 1:3000"
export function antibodyLabel(a) {
  return `${a.name}, cat. # ${a.catalog}${a.supplier ? ` (${a.supplier})` : ""}, ${a.dilution}`;
}

// As written in the caption, e.g. "6x-His Tag Monoclonal Antibody HRP (Thermo Scientific, cat. # MA1-80218; 1:3000)"
export function antibodyCaption(a) {
  return `${a.name} (${[a.supplier, `cat. # ${a.catalog}`].filter(Boolean).join(", ")}; ${a.dilution})`;
}
