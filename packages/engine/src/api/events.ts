// GET /api/events: one Server-Sent Events stream per client (M8.1). Polling only, no fs.watch: new lines of
// <home>/events.jsonl are read by offset, the job store is compared state by state, and a comment keeps idle
// connections open. Built on a web ReadableStream so it works through handle(Request) without a socket.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { EVENTS_FILE } from "../events/log.js";

export interface EventStreamOptions {
  /** Engine home (events.jsonl). */
  home: string;
  /** Current jobs (the job store). */
  jobs: () => Promise<readonly { id: string; state: string; project: string }[]>;
  eventsMs: number;
  jobsMs: number;
  heartbeatMs: number;
  /** Aborted when the client goes away. */
  signal?: AbortSignal;
  /** Poll failures (logged by the caller; the stream keeps going). */
  onError: (e: unknown) => void;
  /** Called once when the stream ends, however it ends. */
  onClose?: () => void;
}

export interface EventStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** End the stream (server shutdown). */
  close(): void;
}

/** At most this much of events.jsonl is read per poll; the rest follows on the next one. */
const READ_MAX = 1 << 20;
/** A "line" longer than this without a newline is dropped rather than buffered forever. */
const LINE_MAX = 4 << 20;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function eventStream(o: EventStreamOptions): EventStream {
  const file = join(o.home, EVENTS_FILE);
  const enc = new TextEncoder();
  const timers: NodeJS.Timeout[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  let offset = 0;
  let partial: Buffer = Buffer.alloc(0);
  let states = new Map<string, string>();
  let readingEvents = false;
  let readingJobs = false;

  const send = (text: string) => {
    if (ended || !controller) return;
    try {
      controller.enqueue(enc.encode(text));
    } catch {
      stop();
    }
  };
  const onAbort = () => close();
  function stop() {
    if (ended) return;
    ended = true;
    for (const t of timers) clearInterval(t);
    o.signal?.removeEventListener("abort", onAbort);
    o.onClose?.();
  }
  function close() {
    if (ended) return;
    stop();
    try {
      controller?.close();
    } catch {
      // already closed or errored
    }
  }

  const size = () =>
    stat(file).then(
      (s) => s.size,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return 0;
        throw e;
      },
    );

  async function pollEvents() {
    if (readingEvents || ended) return;
    readingEvents = true;
    try {
      const end = await size();
      if (end < offset) {
        // Truncated or replaced: start over from the top of the new file.
        offset = 0;
        partial = Buffer.alloc(0);
      }
      if (end === offset) return;
      const n = Math.min(end - offset, READ_MAX);
      const buf = Buffer.alloc(n);
      const fh = await open(file, "r");
      let got: number;
      try {
        got = (await fh.read(buf, 0, n, offset)).bytesRead;
      } finally {
        await fh.close();
      }
      offset += got;
      const data = Buffer.concat([partial, buf.subarray(0, got)]);
      const nl = data.lastIndexOf(0x0a);
      partial = nl === -1 ? data : Buffer.from(data.subarray(nl + 1));
      if (partial.length > LINE_MAX) partial = Buffer.alloc(0);
      if (nl === -1) return;
      for (const line of data.subarray(0, nl).toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // a corrupt line is skipped here, as readUsage skips it
        }
        send(sse("engine", { type: "engine", event }));
      }
    } catch (e) {
      o.onError(e);
    } finally {
      readingEvents = false;
    }
  }

  async function pollJobs(initial = false) {
    if (readingJobs || ended) return;
    readingJobs = true;
    try {
      const next = new Map<string, string>();
      for (const j of await o.jobs()) {
        next.set(j.id, j.state);
        if (!initial && states.get(j.id) !== j.state) send(sse("job", { type: "job", id: j.id, state: j.state, project: j.project }));
      }
      states = next;
    } catch (e) {
      o.onError(e);
    } finally {
      readingJobs = false;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c;
      // Only what happens from now on: the end of the log and the jobs as they are. (The first await also lets
      // eventStream() return before anything below can close the stream.)
      try {
        offset = await size();
      } catch (e) {
        o.onError(e);
      }
      if (ended) return;
      if (o.signal?.aborted) return close();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      await pollJobs(true);
      send(": connected\n\n");
      if (ended) return;
      const every = (ms: number, f: () => unknown) => {
        const t = setInterval(f, ms);
        t.unref();
        timers.push(t);
      };
      every(o.eventsMs, () => void pollEvents());
      every(o.jobsMs, () => void pollJobs());
      every(o.heartbeatMs, () => send(": heartbeat\n\n"));
    },
    cancel() {
      stop();
    },
  });
  return { stream, close };
}
