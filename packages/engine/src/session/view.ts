// The orchestrator's view of a project (DR-0014): the ledger as committed (git HEAD), and only under the read paths
// of the `orchestrator` role in roles.yaml. It reads git blobs, never the working tree, so nothing uncommitted and no
// symlink can be read through it. Everything it returns is project content: data for the model, not instructions.
import { posix } from "node:path";
import { git, gitBlob } from "@cairn/launcher";
import type { Ledger } from "../ledger/ledger.js";

/** DR-0014: what the orchestrator may read when roles.yaml has no `orchestrator` role. */
export const DEFAULT_READ_PATHS = ["PAPER.md", "logic/", "trace/", "evidence/tables/", "analysis/", "lit/notes/", "engine/claims/", "engine/jobs/"] as const;

const MAX_LIST = 300;
const MAX_READ_CHARS = 40_000;
const MAX_MATCHES = 80;

export class ViewError extends Error {}

/** A project-relative path, normalized; refuses absolute paths, "..", and NUL. */
export function relPath(p: string): string {
  if (typeof p !== "string" || p.includes("\0") || p.length > 500) throw new ViewError("path must be a short string");
  const t = p.trim().replace(/^\.\/+/, "");
  if (t === "" || t === ".") return "";
  if (t.startsWith("/")) throw new ViewError(`use a path inside the project, not ${p}`);
  const n = posix.normalize(t).replace(/\/+$/, "");
  if (n === ".." || n.startsWith("../") || n.split("/").includes("..")) throw new ViewError(`path ${p} leaves the project`);
  return n;
}

/** May this file be read? Read paths ending in "/" are directories; others are single files. */
export function readable(path: string, read: readonly string[]): boolean {
  return read.some((r) => (r.endsWith("/") ? path.startsWith(r) : path === r));
}

export class ProjectView {
  constructor(
    readonly ledger: Ledger,
    readonly read: readonly string[],
  ) {}

  /** Files under `dir` (default: everything readable), at HEAD. */
  async list(dir = ""): Promise<string> {
    const d = relPath(dir);
    const all = (await git(this.ledger.dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", d || "."])).split("\n").filter(Boolean);
    const files = all.filter((f) => readable(f, this.read));
    if (files.length === 0) return d ? `nothing readable under ${d}/ (readable: ${this.read.join(", ")})` : "(no readable files)";
    const shown = files.slice(0, MAX_LIST).join("\n");
    return files.length > MAX_LIST ? `${shown}\n[... ${files.length - MAX_LIST} more; list a subdirectory]` : shown;
  }

  /** A text file at HEAD, by lines. */
  async readFile(path: string, offset = 1, limit?: number): Promise<string> {
    const p = relPath(path);
    if (!p || !readable(p, this.read)) throw new ViewError(`${path} is not readable here (readable: ${this.read.join(", ")})`);
    let buf: Buffer;
    try {
      buf = await gitBlob(this.ledger.dir, "HEAD", p);
    } catch {
      throw new ViewError(`no ${p} in the project (as committed)`);
    }
    if (buf.subarray(0, 8000).includes(0)) return `${p} is a binary file (${buf.length} bytes); not shown`;
    const lines = buf.toString("utf8").split("\n");
    const from = Math.max(1, offset);
    const slice = lines.slice(from - 1, limit ? from - 1 + limit : undefined);
    let text = slice.map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
    if (text.length > MAX_READ_CHARS) text = `${text.slice(0, MAX_READ_CHARS)}\n[... cut at ${MAX_READ_CHARS} characters; read on with offset]`;
    return `${p} (lines ${from}-${from + slice.length - 1} of ${lines.length})\n${text}`;
  }

  /** Lines containing `query` (case-insensitive, literal), at HEAD, in readable files. */
  async search(query: string, dir = ""): Promise<string> {
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 200) throw new ViewError("query must be 2-200 characters");
    const d = relPath(dir);
    // Search inside `d` only where it overlaps what is readable: d itself if it lies in a readable directory, or
    // the readable paths that lie in d.
    const specs = d
      ? [
          ...new Set(
            this.read.flatMap((r) => {
              if (r.endsWith("/") && `${d}/`.startsWith(r)) return [d];
              return r === d || r.startsWith(`${d}/`) ? [r] : [];
            }),
          ),
        ]
      : [...this.read];
    if (specs.length === 0) return `nothing readable under ${d}`;
    let out: string;
    try {
      out = await git(this.ledger.dir, ["grep", "-n", "-I", "-i", "-F", "-e", query, "HEAD", "--", ...specs]);
    } catch {
      return `no matches for "${query}"`;
    }
    const lines = out.split("\n").filter(Boolean).map((l) => l.replace(/^HEAD:/, "")).filter((l) => readable(l.split(":")[0]!, this.read));
    if (lines.length === 0) return `no matches for "${query}"`;
    const shown = lines.slice(0, MAX_MATCHES).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
    return `${shown.join("\n")}${lines.length > MAX_MATCHES ? `\n[... ${lines.length - MAX_MATCHES} more matches; narrow the query or the directory]` : ""}`;
  }
}
