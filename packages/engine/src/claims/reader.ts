// The ledger as committed, for the support check: sources must already be in the project's history.
import { git } from "@cairn/launcher";
import { parseDocument } from "yaml";
import type { Ledger } from "../ledger/ledger.js";
import { flatten, validateTree } from "../ledger/tree.js";
import type { SourceReader } from "./support.js";

export function ledgerReader(ledger: Ledger, rev = "HEAD"): SourceReader {
  let revision: Promise<string> | undefined;
  const at = () => (revision ??= git(ledger.dir, ["rev-parse", "--verify", `${rev}^{commit}`]).then((s) => s.trim()));
  return {
    revision: at,
    async read(path) {
      try {
        return await git(ledger.dir, ["show", `${await at()}:${path}`]);
      } catch {
        return undefined;
      }
    },
    async node(id) {
      try {
        const doc = parseDocument(await git(ledger.dir, ["show", `${await at()}:trace/exploration_tree.yaml`]));
        const tree = validateTree((doc.toJS() as { tree?: unknown } | null)?.tree ?? []);
        return flatten(tree).find((x) => x.node.id === id)?.node as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    },
  };
}
