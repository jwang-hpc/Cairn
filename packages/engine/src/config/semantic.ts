import type { EngineConfig, MachinesConfig, ModelsConfig, RolesConfig } from "@cairn/shared";

interface Configs {
  models: ModelsConfig;
  roles: RolesConfig;
  machines: MachinesConfig;
  engine: EngineConfig;
}

const list = (keys: Iterable<string>) => [...keys].join(", ") || "(none)";

/** Rules that span fields or files and can't be expressed in the JSON schemas. */
export function crossFileProblems({ models, roles, machines, engine }: Configs): string[] {
  const problems: string[] = [];
  const providers = new Set(Object.keys(models.providers));
  const aliases = new Set(Object.keys(models.models));
  const roleNames = new Set(Object.keys(roles.roles));

  // models.yaml: every model's provider exists and has an effort mapping.
  const usedProviders = new Map<string, string[]>();
  for (const [alias, m] of Object.entries(models.models)) {
    if (!providers.has(m.provider)) {
      problems.push(`models.yaml: models.${alias}.provider: unknown provider '${m.provider}' (known: ${list(providers)})`);
    } else {
      usedProviders.set(m.provider, [...(usedProviders.get(m.provider) ?? []), alias]);
    }
  }
  for (const [provider, users] of usedProviders) {
    if (!(provider in models.effort_map)) {
      problems.push(`models.yaml: effort_map: missing entry for provider '${provider}' (used by ${users.join(", ")})`);
    }
  }

  // models.yaml: routing refers only to known aliases.
  for (const [purpose, entry] of Object.entries(models.routing)) {
    const refs: [string, string][] = [];
    for (const key of ["worker", "reviewer", "synthesizer"] as const) {
      const ref = entry[key];
      if (ref) refs.push([`routing.${purpose}.${key}`, ref]);
    }
    for (const key of ["panel", "fallback"] as const) {
      entry[key]?.forEach((ref, i) => refs.push([`routing.${purpose}.${key}[${i}]`, ref]));
    }
    for (const [path, ref] of refs) {
      const alias = ref.slice(0, ref.lastIndexOf("@"));
      if (!aliases.has(alias)) problems.push(`models.yaml: ${path}: unknown model alias '${alias}'`);
    }
  }

  // machines.yaml: scratch inside the allowed prefixes; DOE machines are Tier 0 only (DR-0006).
  for (const [name, m] of Object.entries(machines.machines)) {
    const prefixes = m.paths?.allowed_prefixes;
    if (m.scratch && prefixes && !prefixes.some((p) => m.scratch === p.replace(/\/+$/, "") || m.scratch!.startsWith(`${p.replace(/\/+$/, "")}/`))) {
      problems.push(`machines.yaml: machines.${name}.scratch: ${m.scratch} is not under paths.allowed_prefixes`);
    }
    if (m.scratch?.split("/").includes("..")) problems.push(`machines.yaml: machines.${name}.scratch: must not contain '..'`);
    if (!m.doe) continue;
    if (m.auto_approve_below) {
      problems.push(`machines.yaml: machines.${name}.auto_approve_below: DOE machines are never auto-approved (DR-0006)`);
    }
    if (!m.paths) {
      problems.push(`machines.yaml: machines.${name}.paths: DOE machines must declare allowed_prefixes (DR-0006)`);
    }
  }

  // engine.yaml: budget keys refer to real providers and roles.
  const { daily } = engine.budget;
  for (const [unit, caps] of [["usd", daily.usd], ["tokens", daily.tokens]] as const) {
    for (const p of Object.keys(caps.per_provider ?? {})) {
      if (!providers.has(p)) {
        problems.push(`engine.yaml: budget.daily.${unit}.per_provider.${p}: unknown provider (known: ${list(providers)})`);
      }
    }
  }
  for (const r of Object.keys(daily.per_role ?? {})) {
    if (!roleNames.has(r)) problems.push(`engine.yaml: budget.daily.per_role.${r}: unknown role (known: ${list(roleNames)})`);
  }

  return problems;
}
