"""Cairn parser: csv_summary (DR-0007: evidence/ tables are written only by parsers and the executor).

Reads one CSV with a header row and writes, into the output directory:
  <stem>.summary.csv  one row per numeric column: count, min, max, mean, first, last, last/first
  <stem>.ratios.csv   every numeric value divided by the same column's first-row value
so derived numbers (growth factors, speedups) come from code, not from a model. Prints a JSON manifest.

Contract (all Cairn parsers): python3 -I <parser>.py <input file> <output dir>; standard library only;
Python >= 3.11 in production (the agent image), kept 3.9-compatible for host-side tests.
"""
import csv
import json
import math
import os
import sys

PARSER = "csv_summary"
VERSION = 1
MAX_ROWS = 1_000_000


def number(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def fmt(v):
    """Shortest round-trip text for a float; integers without a trailing .0."""
    if v is None:
        return ""
    return str(int(v)) if v.is_integer() and abs(v) < 1e15 else repr(v)


def main(argv):
    if len(argv) != 3:
        print("usage: csv_summary.py <input.csv> <out dir>", file=sys.stderr)
        return 2
    src, out = argv[1], argv[2]
    stem = os.path.splitext(os.path.basename(src))[0]
    with open(src, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if not rows:
        print(json.dumps({"parser": PARSER, "version": VERSION, "outputs": [], "notes": ["empty file"]}))
        return 0
    header, data = rows[0], rows[1 : MAX_ROWS + 1]
    data = [r for r in data if any(cell.strip() for cell in r)]
    cols = []
    for i, name in enumerate(header):
        vals = [number(r[i]) if i < len(r) else None for r in data]
        if data and all(v is not None for v in vals):
            cols.append((name, vals))
    notes = [] if cols else ["no numeric columns"]

    outputs = []
    summary = os.path.join(out, f"{stem}.summary.csv")
    with open(summary, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["column", "count", "min", "max", "mean", "first", "last", "last_over_first"])
        for name, vals in cols:
            first, last = vals[0], vals[-1]
            ratio = last / first if first != 0 else None
            w.writerow([name, len(vals), fmt(min(vals)), fmt(max(vals)), fmt(sum(vals) / len(vals)), fmt(first), fmt(last), fmt(ratio)])
    outputs.append({"path": os.path.basename(summary), "rows": len(cols), "description": f"per-column statistics of {os.path.basename(src)}"})

    if cols and len(data) > 1:
        ratios = os.path.join(out, f"{stem}.ratios.csv")
        with open(ratios, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow([name for name, _ in cols])
            for k in range(len(data)):
                w.writerow([fmt(vals[k] / vals[0]) if vals[0] != 0 else "" for _, vals in cols])
        outputs.append({"path": os.path.basename(ratios), "rows": len(data), "description": f"each value / first row, {os.path.basename(src)}"})

    print(json.dumps({"parser": PARSER, "version": VERSION, "outputs": outputs, "notes": notes}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
