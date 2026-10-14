import type { TSchema } from "typebox";
import type Type from "typebox";
import { Value } from "typebox/value";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

interface RawError {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
  message: string;
}

/** "/providers/openai/routes/0/auth" -> "providers.openai.routes[0].auth" ("(root)" for ""). */
function toPath(pointer: string): string {
  if (pointer === "") return "(root)";
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), "");
}

/**
 * Validate a value at a trust boundary. Errors are human-readable, one per problem, with
 * union branches collapsed ("must be one of a, b") instead of one error per branch.
 */
export function validate<S extends TSchema>(schema: S, value: unknown): ValidationResult<Type.Static<S>> {
  if (Value.Check(schema, value)) return { ok: true, value: value as Type.Static<S> };

  const raw = [...Value.Errors(schema, value)] as unknown as RawError[];
  const allowed = new Map<string, unknown[]>();
  const messages = new Map<string, Set<string>>();
  const add = (path: string, msg: string) => {
    if (!messages.has(path)) messages.set(path, new Set());
    messages.get(path)!.add(msg);
  };

  for (const e of raw) {
    const path = toPath(e.instancePath);
    if (e.keyword === "const" && "allowedValue" in e.params) {
      allowed.set(path, [...(allowed.get(path) ?? []), e.params.allowedValue]);
    } else if (e.keyword === "anyOf" || (e.keyword === "boolean" && e.message === "schema is false")) {
      // anyOf: summarized via collected constants; boolean-false: duplicated by additionalProperties.
      continue;
    } else if (e.keyword === "additionalProperties") {
      const keys = (e.params.additionalProperties as string[] | undefined) ?? [];
      for (const k of keys) add(path, `unknown key '${k}'`);
    } else if (e.keyword === "required" && Array.isArray(e.params.requiredProperties)) {
      for (const k of e.params.requiredProperties as string[]) add(path, `missing required key '${k}'`);
    } else {
      add(path, e.message);
    }
  }
  for (const [path, values] of allowed) {
    add(path, `must be one of ${[...new Set(values)].map((v) => JSON.stringify(v)).join(", ")}`);
  }

  const errors = [...messages].flatMap(([path, set]) => [...set].map((m) => `${path}: ${m}`));
  return { ok: false, errors: errors.length > 0 ? errors : ["(root): invalid value"] };
}
