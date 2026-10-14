// Claim drafts: one ARA claim block (research-manager "Claim" schema), with Sources as sub-bullets:
//   ## C??: <generalized title>
//   - **Statement**: ...
//   - **Sources**:
//     - 9592 ← evidence/raw/EXP-001/<job>/results.csv:2 «100000,9592,0.00518620199727593» [result]
//     - 100000 ← evidence/raw/EXP-001/<job>/job/bench.py:21 «    for n in (100000, 200000, 400000):» [input]
//     - 512 ← [pending: the 512-node run hasn't been fetched]
// The id is assigned when the user approves the claim; a draft's heading id is ignored.
import { CLAIM_REQUIRED, CLAIM_STATUSES, type ClaimDraft, type SourceEntry } from "@cairn/shared";

const HEADING = /^## (C[\w?-]*)\s*:\s*(.+)$/;
const FIELD = /^- \*\*([^*]+)\*\*:\s?(.*)$/;
const ITEM = /^\s{2,}- (.*)$/;

export function parseSource(raw: string): SourceEntry | undefined {
  const arrow = /\s*(?:←|<-)\s*/.exec(raw);
  if (!arrow) return undefined;
  const value = raw.slice(0, arrow.index).trim();
  const rest = raw.slice(arrow.index + arrow[0].length).trim();
  if (value === "") return undefined;
  const pending = /^\[pending:\s*([^\]]*)\]$/.exec(rest);
  if (pending) return { raw, value, pending: pending[1]!.trim() };
  // <ref> «quote» [input|result]; the quote is everything between the first « and the last ».
  const open = rest.indexOf("«");
  const close = rest.lastIndexOf("»");
  if (open <= 0 || close < open) return undefined;
  const refText = rest.slice(0, open).trim();
  const quote = rest.slice(open + 1, close);
  const tag = /^\[(input|result)\]$/.exec(rest.slice(close + 1).trim())?.[1] as "input" | "result" | undefined;
  if (!tag) return undefined;
  const node = /^(N\d+):([a-z_]+)$/.exec(refText);
  if (node) return { raw, value, ref: { kind: "node", node: node[1]!, field: node[2]! }, quote, tag };
  const file = /^(.+):(\d+)$/.exec(refText);
  if (file) return { raw, value, ref: { kind: "file", path: file[1]!, line: Number(file[2]) }, quote, tag };
  return undefined;
}

export function parseDraft(md: string): ClaimDraft {
  const draft: ClaimDraft = { title: "", fields: {}, sources: [], problems: [] };
  let field: string | undefined;
  const items: Record<string, string[]> = {};
  let seenHeading = false;
  for (const line of md.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      if (seenHeading) {
        draft.problems.push("a draft holds one claim; split the others into their own files");
        break;
      }
      seenHeading = true;
      draft.title = h[2]!.trim();
      continue;
    }
    if (!seenHeading) continue;
    const f = FIELD.exec(line);
    if (f) {
      field = f[1]!.trim();
      draft.fields[field] = f[2]!.trim();
      continue;
    }
    const it = ITEM.exec(line);
    if (it && field) (items[field] ??= []).push(it[1]!.trim());
    else if (/^\s{2,}\S/.test(line) && field) draft.fields[field] = `${draft.fields[field]} ${line.trim()}`.trim();
  }
  if (!seenHeading) draft.problems.push('no claim heading ("## C??: <title>")');
  for (const [k, v] of Object.entries(items)) if (k !== "Sources") draft.fields[k] = [draft.fields[k], ...v].filter(Boolean).join("; ");

  const sourceLines = [...(items.Sources ?? [])];
  const inline = draft.fields.Sources ?? "";
  if (inline !== "" && inline !== "[]") sourceLines.unshift(inline);
  for (const s of sourceLines) {
    const e = parseSource(s);
    if (e) draft.sources.push(e);
    else draft.problems.push(`unreadable source entry: ${s} (expected: <value> ← <file:line> «verbatim line» [input|result])`);
  }
  for (const k of CLAIM_REQUIRED) {
    if (k === "Sources" ? sourceLines.length === 0 : !(draft.fields[k] ?? "").trim()) draft.problems.push(`missing ${k}`);
  }
  const status = draft.fields.Status?.trim();
  if (status && !(CLAIM_STATUSES as readonly string[]).includes(status)) draft.problems.push(`Status must be one of ${CLAIM_STATUSES.join(", ")}`);
  return draft;
}
