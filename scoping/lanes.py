"""Lane lists: read a lane CSV and number lanes left to right.

A lane CSV has columns name,start,end (column range, inclusive). Ranges may overlap.
"""

import csv


def read_lanes(path):
    """[(name, start, end), ...] in file order."""
    with open(path, newline="") as f:
        return [(row["name"], int(row["start"]), int(row["end"])) for row in csv.DictReader(f)]


def number_lanes(lanes):
    """Sort left to right and prefix each name with its lane number: "1 ladder", "2 ...", ..."""
    ordered = sorted(lanes, key=lambda l: (l[1] + l[2]) / 2)
    return [(f"{i} {name}", start, end) for i, (name, start, end) in enumerate(ordered, 1)]
