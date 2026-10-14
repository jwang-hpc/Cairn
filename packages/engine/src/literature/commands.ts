// `re literature ...` (M7). For now: the contact address OpenAlex and Crossref ask API users for ("polite pool"),
// kept in engine.yaml so each user of this software sets their own.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { Engine } from "../engine.js";

export const LITERATURE_COMMANDS = ["literature"] as const;
export const LITERATURE_OPTIONS = { clear: { type: "boolean" } } as const;
export const LITERATURE_USAGE = `literature commands:
  literature contact [<email> | --clear]   show or set the contact address sent to OpenAlex and Crossref
                                           (their "polite pool"; never sent to a model); stored in engine.yaml`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Set or clear literature.contact_email in <config>/engine.yaml, keeping the file's comments and layout. */
export async function setContactEmail(configDir: string, email: string | undefined): Promise<void> {
  if (email !== undefined && (!EMAIL.test(email) || email.length > 254)) throw new Error(`not an email address: ${email}`);
  const path = join(configDir, "engine.yaml");
  const doc = parseDocument(await readFile(path, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${path}: ${doc.errors[0]!.message}`);
  if (email === undefined) {
    doc.deleteIn(["literature", "contact_email"]);
    const lit = doc.getIn(["literature"]) as { items?: unknown[] } | undefined;
    if (lit && Array.isArray(lit.items) && lit.items.length === 0) doc.deleteIn(["literature"]);
  } else {
    doc.setIn(["literature", "contact_email"], email);
  }
  await writeFile(path, doc.toString());
}

export async function runLiteratureCommand(engine: Engine, args: string[], v: Values, io: Io): Promise<number> {
  const [sub, value] = args;
  if (sub !== "contact") {
    io.err(`re literature: unknown subcommand '${sub ?? ""}'\n${LITERATURE_USAGE}`);
    return 2;
  }
  try {
    if (v.clear) {
      await setContactEmail(engine.paths.configDir, undefined);
      io.out("contact address cleared: OpenAlex and Crossref will be queried anonymously (slower pool)");
    } else if (value) {
      await setContactEmail(engine.paths.configDir, value);
      io.out(`contact address set: ${value} (sent only to OpenAlex and Crossref)`);
    } else {
      const current = engine.config.engine.literature?.contact_email;
      io.out(current ? `contact address: ${current} (sent only to OpenAlex and Crossref)` : "no contact address: OpenAlex and Crossref are queried anonymously (set one with re literature contact <email>)");
    }
    return 0;
  } catch (e) {
    io.err(`re literature: ${(e as Error).message}`);
    return 1;
  }
}
