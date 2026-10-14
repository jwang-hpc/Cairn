// Numbers in claims and their sources (DR-0007 support check). A claimed number matches a number in a file if it is
// the same value, or the file's value rounded to the claim's precision ("0.0052" for 0.00518620199727593). Anything
// else is a different number.

/** Identifier-like text that is not a quantity: masked before numbers are read from prose. */
const NOT_QUANTITIES = [
  /`[^`]*`/g, // code spans: references (put job ids, versions, paths here)
  /\b\d{8}-\d{4}-[0-9a-f]{4}\b/g, // job and panel ids
  /\b\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+Z?)?/g, // dates and timestamps
  /\b(?:EXP-\d+|HY\d+|C\d+|N\d+|D\d+|O\d+)\b/g, // ledger ids
  /\S*\/\S*/g, // paths and ratios written with '/'
];

const THOUSANDS = /(?<![\w.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w,])/g;
const PLAIN = /(?<![\w.])-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Numbers written in prose: identifiers masked; "33,860" is one number. */
export function proseNumbers(text: string): string[] {
  let t = text;
  for (const re of NOT_QUANTITIES) t = t.replace(re, (m) => " ".repeat(m.length));
  const out: string[] = [];
  t = t.replace(THOUSANDS, (m) => {
    out.push(m);
    return " ".repeat(m.length);
  });
  for (const m of t.matchAll(PLAIN)) out.push(m[0]);
  return out;
}

/** Every number a source line could be said to contain: plain tokens (CSV fields) and thousands-grouped forms. */
export function lineNumbers(line: string): string[] {
  return [...new Set([...[...line.matchAll(PLAIN)].map((m) => m[0]), ...[...line.matchAll(THOUSANDS)].map((m) => m[0])])];
}

/** "33,860" -> 33860, "3.2x" -> 3.2, "12%" -> 12; undefined if there is no number. */
export function parseNumber(s: string): number | undefined {
  const m = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(s.trim());
  const core = m?.[0].replace(/,/g, "") ?? "";
  if (core === "" || core === "-" || core === "+" || !/\d/.test(core)) return undefined;
  const n = Number(core);
  return Number.isFinite(n) ? n : undefined;
}

/** Half a unit in the last written digit: the largest difference a rounding to this precision can hide. */
export function halfUnit(s: string): number {
  const m = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?(?:[eE]([-+]?\d+))?/.exec(s.trim());
  const decimals = m?.[1]?.length ?? 0;
  const exp = Number(m?.[2] ?? 0);
  return 0.5 * 10 ** (exp - decimals);
}

/** Is `claimed` the number `actual` (exactly, or rounded to the claim's precision)? */
export function sameNumber(claimed: string, actual: string): "exact" | "rounded" | undefined {
  const c = parseNumber(claimed);
  const a = parseNumber(actual);
  if (c === undefined || a === undefined) return undefined;
  const scale = Math.max(Math.abs(c), Math.abs(a), 1e-300);
  if (Math.abs(c - a) <= scale * 1e-12) return "exact";
  if (Math.abs(c - a) <= halfUnit(claimed) * (1 + 1e-9)) return "rounded";
  return undefined;
}
