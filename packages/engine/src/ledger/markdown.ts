// Read/write the ARA "## ID: title" + "- **Key**: value" markdown entries (claims-style), used for
// logic/hypotheses.md and engine/decisions.md.

export interface MdEntry {
  id: string;
  title: string;
  fields: Record<string, string>;
}

/** Single-line field values: newlines are folded so one field stays one bullet. */
export const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

export function renderEntry(e: MdEntry): string {
  const lines = [`## ${e.id}: ${oneLine(e.title)}`];
  for (const [k, v] of Object.entries(e.fields)) lines.push(`- **${k}**: ${oneLine(v)}`);
  return `${lines.join("\n")}\n`;
}

export function parseEntries(md: string, idPattern: RegExp): MdEntry[] {
  const entries: MdEntry[] = [];
  let cur: MdEntry | undefined;
  for (const line of md.split("\n")) {
    const h = /^## ([A-Z]+\d+)(?: \([^)]*\))?: (.*)$/.exec(line);
    if (h && idPattern.test(h[1]!)) {
      cur = { id: h[1]!, title: h[2]!.trim(), fields: {} };
      entries.push(cur);
      continue;
    }
    if (line.startsWith("## ")) {
      cur = undefined;
      continue;
    }
    const f = /^- \*\*([^*]+)\*\*: (.*)$/.exec(line);
    if (f && cur) cur.fields[f[1]!] = f[2]!.trim();
  }
  return entries;
}

/** Next id with a prefix, scanning existing ids (ARA: always read the file for the highest id first). */
export function nextId(prefix: string, existing: Iterable<string>): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of existing) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}
