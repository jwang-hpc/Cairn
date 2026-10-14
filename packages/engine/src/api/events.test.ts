import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventStream } from "./events.js";

let home: string;
let file: string;
let jobs: { id: string; state: string; project: string }[];
let jobPolls: number;
let errors: unknown[];
let closes: number;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-sse-"));
  file = join(home, "events.jsonl");
  jobs = [];
  jobPolls = 0;
  errors = [];
  closes = 0;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (o: { signal?: AbortSignal; heartbeatMs?: number } = {}) =>
  eventStream({
    home,
    jobs: async () => (jobPolls++, jobs),
    eventsMs: 10,
    jobsMs: 10,
    heartbeatMs: o.heartbeatMs ?? 60_000,
    ...(o.signal ? { signal: o.signal } : {}),
    onError: (e) => errors.push(e),
    onClose: () => closes++,
  });

/** Reads an SSE byte stream into text; one read is kept pending across timeouts so no chunk is lost. */
function reader(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  let pending: Promise<void> | undefined;
  const next = () =>
    (pending ??= r.read().then(({ done, value }) => {
      pending = undefined;
      if (done) ended = true;
      else text += dec.decode(value, { stream: true });
    }));
  const wait = async (ok: () => boolean, what: string, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (ended) throw new Error(`stream ended while waiting for ${what}; got:\n${text}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}; got:\n${text}`);
      await Promise.race([next(), sleep(left)]);
    }
  };
  return {
    get text() {
      return text;
    },
    until: (re: RegExp, ms?: number) => wait(() => re.test(text), String(re), ms),
    ended: (ms?: number) => wait(() => ended, "the end of the stream", ms),
    cancel: () => r.cancel(),
  };
}
const data = (text: string, event: string) =>
  [...text.matchAll(/^event: (\w+)\ndata: (.*)\n\n/gm)].filter((m) => m[1] === event).map((m) => JSON.parse(m[2]!) as unknown);

describe("eventStream (GET /api/events)", () => {
  it("sends only lines appended after connecting; a partial line waits for its newline; a truncated log starts over", async () => {
    await writeFile(file, `${JSON.stringify({ type: "message", text: "before" })}\n`);
    const s = open();
    const r = reader(s.stream);
    await r.until(/^: connected\n\n/);
    await appendFile(file, '{"type":"message","text":"fir');
    await sleep(60);
    expect(data(r.text, "engine")).toEqual([]);
    await appendFile(file, 'st"}\nnot json\n{"type":"message","text":"second"}\n');
    await r.until(/second/);
    expect(data(r.text, "engine")).toEqual([
      { type: "engine", event: { type: "message", text: "first" } },
      { type: "engine", event: { type: "message", text: "second" } },
    ]);
    await writeFile(file, '{"type":"m","text":"x"}\n');
    await r.until(/"text":"x"/);
    expect(data(r.text, "engine")).toHaveLength(3);
    expect(r.text).not.toContain("before");
    await r.cancel();
    expect(errors).toEqual([]);
  });

  it("reports new jobs and state changes once each, not the jobs that existed at connect", async () => {
    jobs = [{ id: "j1", state: "pending_approval", project: "p" }];
    const s = open();
    const r = reader(s.stream);
    await r.until(/: connected/);
    jobs = [{ id: "j1", state: "running", project: "p" }, { id: "j2", state: "pending_approval", project: "q" }];
    await r.until(/"j2"/);
    await r.until(/"j1"/);
    await sleep(60);
    expect(data(r.text, "job")).toEqual(
      expect.arrayContaining([{ type: "job", id: "j1", state: "running", project: "p" }, { type: "job", id: "j2", state: "pending_approval", project: "q" }]),
    );
    expect(data(r.text, "job")).toHaveLength(2);
    s.close();
    await r.ended();
  });

  it("sends a heartbeat comment while idle", async () => {
    const s = open({ heartbeatMs: 20 });
    const r = reader(s.stream);
    await r.until(/: heartbeat\n\n/);
    s.close();
    await r.ended();
    expect(closes).toBe(1);
  });

  it("stops polling when the client cancels, the request is aborted, or the server closes it", async () => {
    const a = open();
    const ra = reader(a.stream);
    await ra.until(/: connected/);
    await ra.cancel();
    expect(closes).toBe(1);
    const polls = jobPolls;
    await sleep(60);
    expect(jobPolls).toBe(polls);

    const ac = new AbortController();
    const rb = reader(open({ signal: ac.signal }).stream);
    await rb.until(/: connected/);
    ac.abort();
    await rb.ended();
    expect(closes).toBe(2);

    const gone = new AbortController();
    gone.abort();
    await reader(open({ signal: gone.signal }).stream).ended();
    expect(closes).toBe(3);
    expect(errors).toEqual([]);
  });
});
