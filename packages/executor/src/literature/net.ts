// HTTP for the literature proxy (M7), host side only. Fixed base hosts per source (redirects are checked against
// them, never followed elsewhere); the user's contact address goes only to OpenAlex and Crossref, an API key only to
// its own service; per-source pacing, Retry-After, a circuit breaker, OpenAlex's daily credit quota, and a disk cache
// (whose keys and contents never hold the contact address or a key).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LitSource } from "./records.js";

export type LitService = LitSource | "doi";

/** The only hosts each service may be reached at (including redirects). */
export const SERVICE_HOSTS: Record<LitService, readonly string[]> = {
  s2: ["api.semanticscholar.org"],
  openalex: ["api.openalex.org"],
  arxiv: ["export.arxiv.org"],
  crossref: ["api.crossref.org"],
  doi: ["doi.org"],
};

/** Minimum gap between requests to one service (their published limits, conservatively). */
const MIN_INTERVAL_MS: Record<LitService, number> = { s2: 1100, openalex: 150, arxiv: 3000, crossref: 150, doi: 150 };
const TIMEOUT_MS = 20_000;
const MAX_BODY = 5 << 20;
const CACHE_TTL_MS = 7 * 24 * 3600_000;
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 60_000;
/** Stop using OpenAlex before its free daily credits run out. */
const OPENALEX_RESERVE_CREDITS = 50;

export class LitError extends Error {
  constructor(
    message: string,
    readonly kind: "throttled" | "blocked" | "error" | "not_found",
  ) {
    super(message);
    this.name = "LitError";
  }
}

export interface LitHttpOptions {
  fetch?: typeof fetch;
  /** Disk cache directory (engine home literature-cache/); none: no cache. */
  cacheDir?: string;
  /** Sent only to OpenAlex and Crossref ("polite pool"). */
  contactEmail?: string;
  /** Semantic Scholar API key; sent only to api.semanticscholar.org. */
  s2Key?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LitResponse {
  status: number;
  body: string;
  /** Served from the cache. */
  cached: boolean;
}

const AGENT = "Cairn-research-workbench/0.0";

export class LitHttp {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #queue = new Map<LitService, Promise<unknown>>();
  readonly #last = new Map<LitService, number>();
  readonly #failures = new Map<LitService, number>();
  readonly #openUntil = new Map<LitService, number>();
  readonly #pauseReason = new Map<LitService, string>();
  /** Requests actually sent (not cached), per service: what the cost of a run was. */
  readonly sent = new Map<LitService, number>();

  constructor(readonly opts: LitHttpOptions = {}) {
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET a JSON or text resource from one service. `url` must be on that service's host. */
  async get(service: LitService, url: URL, opts: { accept?: string } = {}): Promise<LitResponse> {
    if (!SERVICE_HOSTS[service].includes(url.hostname) || url.protocol !== "https:") throw new LitError(`${url.host} is not ${service}'s host`, "blocked");
    const key = createHash("sha256").update(`${service} ${url.toString()}`).digest("hex");
    const hit = await this.#cacheGet(key);
    if (hit) return { ...hit, cached: true };
    const res = await this.#paced(service, () => this.#send(service, url, opts.accept ?? "application/json"));
    if (res.status === 200) await this.#cachePut(key, res);
    return { ...res, cached: false };
  }

  async #paced<T>(service: LitService, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queue.get(service) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const wait = (this.#last.get(service) ?? 0) + MIN_INTERVAL_MS[service] - this.#now();
      if (wait > 0) await this.#sleep(wait);
      try {
        return await fn();
      } finally {
        this.#last.set(service, this.#now());
      }
    });
    this.#queue.set(service, run);
    return run;
  }

  async #send(service: LitService, url: URL, accept: string): Promise<{ status: number; body: string }> {
    const open = this.#openUntil.get(service) ?? 0;
    if (open > this.#now()) throw new LitError(`${service} is paused: ${this.#pauseReason.get(service) ?? "unavailable"} (${Math.ceil((open - this.#now()) / 1000)} s left)`, "throttled");
    let target = new URL(url);
    if ((service === "openalex" || service === "crossref") && this.opts.contactEmail) target.searchParams.set("mailto", this.opts.contactEmail);
    const headers: Record<string, string> = {
      accept,
      "user-agent": service === "crossref" && this.opts.contactEmail ? `${AGENT} (mailto:${this.opts.contactEmail})` : AGENT,
    };
    if (service === "s2" && this.opts.s2Key) headers["x-api-key"] = this.opts.s2Key;
    for (let hop = 0; hop < 4; hop++) {
      let r: Response;
      try {
        this.sent.set(service, (this.sent.get(service) ?? 0) + 1);
        r = await this.#fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        this.#fail(service);
        throw new LitError(`${service}: ${(e as Error).message}`, "error");
      }
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        const next = new URL(r.headers.get("location")!, target);
        if (!SERVICE_HOSTS[service].includes(next.hostname) || next.protocol !== "https:") throw new LitError(`${service} redirected to ${next.host}, which is not allowed`, "blocked");
        target = next;
        continue;
      }
      if (service === "openalex") this.#openAlexQuota(r.headers);
      if (r.status === 429) {
        const after = Number(r.headers.get("retry-after"));
        if (Number.isFinite(after) && after > 0 && after <= 10 && hop === 0) {
          await this.#sleep(after * 1000);
          continue;
        }
        throw new LitError(`${service} is rate-limiting us (HTTP 429)${service === "s2" && !this.opts.s2Key ? "; a free API key raises the limit (re literature key s2)" : ""}`, "throttled");
      }
      if (r.status >= 500) {
        this.#fail(service);
        throw new LitError(`${service}: HTTP ${r.status}`, "error");
      }
      const type = r.headers.get("content-type") ?? "";
      const body = await r.text();
      if (body.length > MAX_BODY) throw new LitError(`${service}: response too large`, "error");
      if (r.status === 202 || (/text\/html/.test(type) && !/html/.test(accept))) throw new LitError(`${service} answered with a bot check or HTML page, not data`, "blocked");
      this.#failures.set(service, 0);
      return { status: r.status, body };
    }
    throw new LitError(`${service}: too many redirects`, "error");
  }

  #fail(service: LitService): void {
    const n = (this.#failures.get(service) ?? 0) + 1;
    this.#failures.set(service, n);
    if (n >= BREAKER_FAILURES) {
      this.#openUntil.set(service, this.#now() + BREAKER_OPEN_MS);
      this.#pauseReason.set(service, "repeated failures");
      this.#failures.set(service, 0);
    }
  }

  /** OpenAlex meters use (x-ratelimit-remaining credits, reset in x-ratelimit-reset seconds); keep a reserve. */
  #openAlexQuota(h: Headers): void {
    const header = h.get("x-ratelimit-remaining");
    if (header === null || header.trim() === "") return; // no quota information: nothing to do
    const remaining = Number(header);
    const reset = Number(h.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && remaining < OPENALEX_RESERVE_CREDITS) {
      this.#openUntil.set("openalex", this.#now() + (Number.isFinite(reset) && reset > 0 ? reset * 1000 : 3600_000));
      this.#pauseReason.set("openalex", `daily credits nearly used (${remaining} left); resets with OpenAlex's quota`);
    }
  }

  async #cacheGet(key: string): Promise<{ status: number; body: string } | undefined> {
    if (!this.opts.cacheDir) return undefined;
    try {
      const c = JSON.parse(await readFile(join(this.opts.cacheDir, `${key}.json`), "utf8")) as { at: number; status: number; body: string };
      return this.#now() - c.at < CACHE_TTL_MS ? { status: c.status, body: c.body } : undefined;
    } catch {
      return undefined;
    }
  }

  async #cachePut(key: string, res: { status: number; body: string }): Promise<void> {
    if (!this.opts.cacheDir) return;
    await mkdir(this.opts.cacheDir, { recursive: true, mode: 0o700 });
    const p = join(this.opts.cacheDir, `${key}.json`);
    await writeFile(`${p}.tmp`, JSON.stringify({ at: this.#now(), ...res }), { mode: 0o600 });
    await rename(`${p}.tmp`, p);
  }
}
