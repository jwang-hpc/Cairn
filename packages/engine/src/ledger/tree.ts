// trace/exploration_tree.yaml: append-only research DAG (ARA research-manager schema).
import { isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { type ExplorationNode, NODE_REQUIRED, validate, ExplorationNode as NodeSchema } from "@cairn/shared";

export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeError";
  }
}

/** Flatten nested nodes (depth-first), keeping each node's parent. */
export function flatten(nodes: readonly ExplorationNode[], parent?: string): { node: ExplorationNode; parent: string | undefined }[] {
  return nodes.flatMap((n) => [{ node: n, parent: n.parent ?? parent }, ...flatten(n.children ?? [], n.id)]);
}

/** Validate every node (recursively), its type-specific fields, id uniqueness, and references. */
export function validateTree(nodes: unknown): ExplorationNode[] {
  if (!Array.isArray(nodes)) throw new TreeError("trace/exploration_tree.yaml: `tree` must be a list");
  const check = (n: unknown, path: string): ExplorationNode => {
    const r = validate(NodeSchema, n);
    if (!r.ok) throw new TreeError(`${path}: ${r.errors.join("; ")}`);
    const node = r.value as ExplorationNode;
    for (const f of NODE_REQUIRED[node.type]) {
      if ((node as Record<string, unknown>)[f] === undefined) throw new TreeError(`${path} (${node.id}, ${node.type}): missing required field '${f}'`);
    }
    return { ...node, ...(node.children ? { children: (node.children as unknown[]).map((c, i) => check(c, `${path}.children[${i}]`)) } : {}) };
  };
  const tree = nodes.map((n, i) => check(n, `tree[${i}]`));
  const ids = new Set<string>();
  for (const { node } of flatten(tree)) {
    if (ids.has(node.id)) throw new TreeError(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  for (const { node } of flatten(tree)) {
    for (const ref of [...(node.also_depends_on ?? []), ...(node.parent ? [node.parent] : [])]) {
      if (!ids.has(ref)) throw new TreeError(`${node.id} refers to unknown node ${ref}`);
    }
  }
  return tree;
}

/** Find the YAML map of a node by id anywhere in the document's tree. */
function findNodeMap(seq: YAMLSeq, id: string): YAMLMap | undefined {
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    if (item.get("id") === id) return item;
    const kids = item.get("children");
    if (isSeq(kids)) {
      const found = findNodeMap(kids, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Append a node: as a child of `parent` when given (ARA's nested form), else at the top level. Existing nodes
 * are never modified except to gain a `children` list (append-only trace).
 */
export function appendNode(doc: Document, node: ExplorationNode, parent?: string): void {
  let tree = doc.get("tree");
  if (!isSeq(tree)) {
    doc.set("tree", doc.createNode([]));
    tree = doc.get("tree");
  }
  const target = tree as YAMLSeq;
  if (!parent) {
    target.add(doc.createNode(node));
    return;
  }
  const parentMap = findNodeMap(target, parent);
  if (!parentMap) throw new TreeError(`unknown parent node ${parent}`);
  let kids = parentMap.get("children");
  if (!isSeq(kids)) {
    parentMap.set("children", doc.createNode([]));
    kids = parentMap.get("children");
  }
  (kids as YAMLSeq).add(doc.createNode(node));
}

const MARK: Record<string, string> = { dead_end: "✗ ", pivot: "↻ " };

/** Render the tree as text. Dead ends are marked ✗, pivots ↻; cross-edges listed under their node. */
export function renderTree(nodes: readonly ExplorationNode[]): string {
  if (nodes.length === 0) return "(empty exploration tree)";
  const out: string[] = [];
  const label = (n: ExplorationNode) => `${MARK[n.type] ?? ""}${n.id} ${n.type}  ${n.title}  [${n.provenance}]`;
  const deps = (n: ExplorationNode, prefix: string) => {
    if (n.also_depends_on?.length) out.push(`${prefix}⤷ also depends on ${n.also_depends_on.join(", ")}`);
  };
  const walk = (children: readonly ExplorationNode[], prefix: string) => {
    children.forEach((n, i) => {
      const last = i === children.length - 1;
      out.push(`${prefix}${last ? "└── " : "├── "}${label(n)}`);
      const next = `${prefix}${last ? "    " : "│   "}`;
      deps(n, next);
      walk(n.children ?? [], next);
    });
  };
  for (const root of nodes) {
    out.push(label(root));
    deps(root, "    ");
    walk(root.children ?? [], "");
  }
  return out.join("\n");
}
