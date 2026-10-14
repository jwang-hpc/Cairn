// Project files as committed, for the app's Results tab, Files list, and preview drawer (DR-0014). Read from git
// (HEAD), never the working tree: no symlinks, nothing uncommitted. Images, PDFs, and other binaries come back as
// base64 with a type from a fixed list; anything else is text if it is text, else only its size.
import { extname } from "node:path";
import { git, gitBlob } from "@cairn/launcher";
import { relPath, ViewError } from "../session/view.js";
import type { Ledger } from "./ledger.js";

export const MAX_FILE_BYTES = 10 << 20;
const MAX_LIST = 2000;

const BINARY_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

export interface FileEntry {
  path: string;
  bytes: number;
}

export type FileContent =
  | { path: string; bytes: number; kind: "text"; text: string }
  | { path: string; bytes: number; kind: "image" | "pdf"; mime: string; base64: string }
  | { path: string; bytes: number; kind: "binary" };

export class FileError extends Error {}

/** Committed files under `dir` (default: the whole project), with sizes. */
export async function listFiles(ledger: Ledger, dir = ""): Promise<{ files: FileEntry[]; truncated: boolean }> {
  let d: string;
  try {
    d = relPath(dir);
  } catch (e) {
    throw new FileError((e as ViewError).message);
  }
  const out = await git(ledger.dir, ["ls-tree", "-r", "-l", "HEAD", "--", d || "."]).catch(() => "");
  const files = out
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(l);
      return m ? [{ path: m[2]!, bytes: Number(m[1]) }] : [];
    });
  return { files: files.slice(0, MAX_LIST), truncated: files.length > MAX_LIST };
}

/** One committed file. */
export async function readFile(ledger: Ledger, path: string): Promise<FileContent> {
  let p: string;
  try {
    p = relPath(path);
  } catch (e) {
    throw new FileError((e as ViewError).message);
  }
  if (!p) throw new FileError("give a file path");
  const type = (await git(ledger.dir, ["cat-file", "-t", `HEAD:${p}`]).catch(() => "")).trim();
  if (type !== "blob") throw new FileError(`no file ${p} in ${ledger.name} (as committed)`);
  const size = Number((await git(ledger.dir, ["cat-file", "-s", `HEAD:${p}`])).trim());
  if (size > MAX_FILE_BYTES) throw new FileError(`${p} is ${size} bytes; the preview limit is ${MAX_FILE_BYTES}`);
  const buf = await gitBlob(ledger.dir, "HEAD", p);
  const mime = BINARY_TYPES[extname(p).toLowerCase()];
  if (mime) return { path: p, bytes: buf.length, kind: mime === "application/pdf" ? "pdf" : "image", mime, base64: buf.toString("base64") };
  if (buf.subarray(0, 8000).includes(0)) return { path: p, bytes: buf.length, kind: "binary" };
  return { path: p, bytes: buf.length, kind: "text", text: buf.toString("utf8") };
}
