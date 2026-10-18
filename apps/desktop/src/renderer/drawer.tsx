// The preview drawer (DR-0014): whatever the user opens (a file, figure, table, job card, claim draft, claim, or a
// worker's log) slides in beside the chat. Presentational: App loads the content and passes callbacks.
import type { JobRecord } from "@cairn/shared";
import type { Draft, Entry, FileContent } from "./api.js";
import type { DrawerItem } from "./chat.js";
import { ClaimDetail, DraftDetail, type GateStep, JobDetail } from "./views.js";
import type { JobAction } from "./jobs.js";

export type DrawerContent =
  | { kind: "file"; file: FileContent }
  | { kind: "job"; job: JobRecord; card: string }
  | { kind: "draft"; draft: Draft; check?: { ok: boolean; text: string }; review?: string }
  | { kind: "claim"; claim: Entry }
  | { kind: "log"; title: string; steps: { at: string; step: string }[]; running: boolean }
  | { kind: "error"; message: string };

/** CSV (quoted fields allowed) into rows; at most `max` rows. */
export function parseCsv(text: string, max = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if ((field || row.length) && rows.length < max) rows.push([...row, field]);
  return rows;
}

export const drawerTitle = (item: DrawerItem): string =>
  item.kind === "file" ? item.path : item.kind === "job" ? `Job ${item.id}` : item.kind === "draft" ? item.ref : item.kind === "claim" ? item.id : `${item.proposal} · ${item.title}`;

function FileView(props: { file: FileContent }) {
  const f = props.file;
  if (f.kind === "binary") return <p className="muted">A binary file ({f.bytes.toLocaleString()} bytes); not shown.</p>;
  if (f.kind !== "text") {
    return f.kind === "image" ? (
      <img className="preview-img" src={`data:${f.mime};base64,${f.base64}`} alt={f.path} />
    ) : (
      <p className="muted">PDF preview comes with the paper view; {f.bytes.toLocaleString()} bytes.</p>
    );
  }
  if (/\.(csv|tsv)$/i.test(f.path)) {
    const rows = parseCsv(f.path.endsWith(".tsv") ? f.text.replace(/\t/g, ",") : f.text);
    const [head, ...body] = rows;
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{head?.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={/^-?[\d.,e+-]+$/i.test(c) ? "num" : ""}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <pre className="card prose">{f.text}</pre>;
}

/** Drawer width limits: at least 320 px; it leaves the sidebar (240) and 360 px of chat. */
export const DRAWER = { min: 320, default: 400, sidebar: 240, chatMin: 360 };
export function clampDrawer(width: number, windowWidth: number): number {
  const max = Math.max(DRAWER.min, windowWidth - DRAWER.sidebar - DRAWER.chatMin);
  return Math.round(Math.min(Math.max(width, DRAWER.min), max));
}
/** The "Widen" size: two thirds of the window, within the limits. */
export const wideDrawer = (windowWidth: number) => clampDrawer(Math.round(windowWidth * 0.66), windowWidth);

function ResizeHandle(props: { width: number; onResize: (w: number) => void }) {
  return (
    <div
      className="drawer-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the preview"
      aria-valuenow={props.width}
      tabIndex={0}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => props.onResize(clampDrawer(window.innerWidth - ev.clientX, window.innerWidth));
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          props.onResize(clampDrawer(props.width + (e.key === "ArrowLeft" ? 40 : -40), window.innerWidth));
        }
      }}
    />
  );
}

export function Drawer(props: {
  item: DrawerItem | undefined;
  content: DrawerContent | undefined;
  onClose: () => void;
  width: number;
  wide: boolean;
  onResize: (w: number) => void;
  onToggleWide: () => void;
  job: { busy: boolean; error: string | undefined; onAction: (a: JobAction, text?: string) => void };
  gate: { busy: GateStep | undefined; error: string | undefined; onStep: (s: GateStep, note?: string) => void };
  onStop: () => void;
}) {
  if (!props.item) return null;
  const c = props.content;
  return (
    <aside className="drawer" aria-label="Preview">
      <ResizeHandle width={props.width} onResize={props.onResize} />
      <div className="drawer-head">
        <span className="drawer-title">{drawerTitle(props.item)}</span>
        <button type="button" className="btn" onClick={props.onToggleWide} title="Drag the left edge to set any width">
          {props.wide ? "Narrow" : "Widen"}
        </button>
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="drawer-body">
        {!c && <p className="muted">Loading…</p>}
        {c?.kind === "error" && <p className="error">{c.message}</p>}
        {c?.kind === "file" && <FileView file={c.file} />}
        {c?.kind === "job" && <JobDetail key={c.job.id} job={c.job} card={c.card} busy={props.job.busy} error={props.job.error} onAction={props.job.onAction} />}
        {c?.kind === "draft" && <DraftDetail key={c.draft.ref} draft={c.draft} check={c.check} review={c.review} busy={props.gate.busy} error={props.gate.error} onStep={props.gate.onStep} />}
        {c?.kind === "claim" && <ClaimDetail claim={c.claim} />}
        {c?.kind === "log" && (
          <>
            {c.steps.length === 0 ? (
              <p className="muted">No steps logged yet.</p>
            ) : (
              <ol className="steps log">
                {c.steps.map((s, i) => (
                  <li key={i}>
                    <span className="at">{s.at.slice(11, 19)}</span> {s.step}
                  </li>
                ))}
              </ol>
            )}
            {c.running && (
              <button type="button" className="btn danger" onClick={props.onStop}>
                Stop worker
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
