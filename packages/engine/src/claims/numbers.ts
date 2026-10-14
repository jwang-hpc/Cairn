// Numbers in claims and their sources (DR-0007 support check). A claimed number matches a number in a file if it is
// the same value, or the file's value rounded to the claim's precision ("0.0052" for 0.00518620199727593). Anything
// else is a different number. Extraction errs toward reading a number: a quantity the check can't see is a
// quantity nobody checked.

/**
 * Content that could hide a number from the check or from the reader of claims.md: HTML comments, invisible format
 * characters (zero-width spaces, bidi controls), and digits other than 0-9 (full-width, other scripts).
 */
export function hiddenContent(text: string): string | undefined {
  if (/<!--/.test(text)) return "an HTML comment";
  if (/\p{Cf}/u.test(text)) return "invisible formatting characters";
  if (/\p{Nd}/u.test(text.replace(/[0-9]/g, ""))) return "digits other than 0-9";
  return undefined;
}

/** Identifier-shaped text that is not a quantity. Everything else with digits is read. */
const NOT_QUANTITIES = [
  /\b\d{8}-\d{4}-[0-9a-f]{4}\b/g, // job and panel ids
  /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?(?!\d)/g, // dates, ISO timestamps
  /\b(?:EXP-\d+|HY\d+|C\d+|N\d+|D\d+|O\d+)\b/g, // ledger ids
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, // hashes
  /\b\d+(?:\.\d+){2,}\b/g, // versions (24.11.5)
];

/**
 * A code span hides its content only when it is one identifier-shaped token: letters, '/', '_', ':', a '-' after the
 * first character, or two or more dots (`20261014-1251-c30f`, `evidence/raw/x.csv`, `24.11.5`). A plain number in
 * a code span (`9593`) is still a number.
 */
const idSpan = (inner: string) => /^\S+$/.test(inner) && (/[A-Za-z/_:]/.test(inner) || /.-/.test(inner) || (inner.match(/\./g)?.length ?? 0) >= 2);

const mask = (s: string) => " ".repeat(s.length);

function masked(text: string): string {
  let t = text.replace(/`([^`]*)`/g, (m, inner: string) => (idSpan(inner) ? mask(m) : ` ${inner} `));
  for (const re of NOT_QUANTITIES) t = t.replace(re, mask);
  return t;
}

/**
 * Number-like runs: digits with inner '.'/',' (split later), an optional leading '-', an optional exponent, or a
 * leading-dot decimal. Digits right after a letter belong to a name (A100, p95, x86) and are not read; after '_',
 * '.', '/', or punctuation they are.
 */
const CANDIDATE = /(?<![A-Za-z0-9.])-?\.\d+|(?<![A-Za-z0-9])-?\d(?:[\d.,]*\d)?(?:[eE][-+]?\d+(?![A-Za-z0-9]))?/g;
const GROUPED = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

function split(c: string, mode: "prose" | "csv" | "text"): string[] {
  if (!c.includes(",")) return [c];
  const parts = c.split(",").filter((p) => /\d/.test(p));
  if (mode === "csv") return parts; // a comma in a CSV line separates fields
  if (GROUPED.test(c)) return mode === "prose" ? [c] : [c, ...parts]; // "33,860"; in a log it may be either
  return parts;
}

export interface NumberToken {
  text: string;
  start: number;
  end: number;
}

function tokens(text: string, mode: "prose" | "csv" | "text"): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    let at = m.index!;
    for (const part of split(m[0], mode)) {
      const i = text.indexOf(part, at);
      out.push({ text: part, start: i, end: i + part.length });
      if (mode !== "text" || !GROUPED.test(m[0])) at = i + part.length;
    }
  }
  return out;
}

/** Numbers written in prose: identifiers masked; "33,860" is one number. */
export function proseNumbers(text: string): string[] {
  return tokens(masked(text), "prose").map((t) => t.text);
}

/** Every number a source line could be said to contain. CSV lines split on commas; other text also reads 1,234. */
export function lineNumbers(line: string, mode: "csv" | "text" = "text"): string[] {
  return [...new Set(tokens(line, mode).map((t) => t.text))];
}

/** Numbers with their positions in a text (for checking that a quote covers a whole number). */
export function numberTokens(text: string, mode: "csv" | "text" = "text"): NumberToken[] {
  return tokens(text, mode);
}

/** A Sources value: one number with an optional short unit ("0.0052", "33,860", "3.3x", "12 ms", "4.1 GB/s"). */
export const SOURCE_VALUE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?(?: ?[A-Za-z%µ×/]{1,8})?$/;
export const isSourceValue = (v: string) => /\d/.test(v) && SOURCE_VALUE.test(v);

/** "33,860" -> 33860, "3.2x" -> 3.2, "12%" -> 12; undefined if there is no number. */
export function parseNumber(s: string): number | undefined {
  const m = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(s.trim());
  const core = m?.[0].replace(/,/g, "") ?? "";
  if (!/\d/.test(core)) return undefined;
  const n = Number(core);
  return Number.isFinite(n) ? n : undefined;
}

/** Half a unit in the last written digit: the largest difference a rounding to this precision can hide. */
export function halfUnit(s: string): number {
  const m = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?(?:[eE]([-+]?\d+))?/.exec(s.trim());
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
