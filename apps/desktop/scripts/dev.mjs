// Dev loop for the desktop app (option A, M8): Vite serves the renderer with hot reload; tsc watches main and
// preload; Electron restarts when they change. Run from your own terminal: corepack pnpm --filter @cairn/desktop dev
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(app, "package.json"));
const electronBin = require("electron"); // the electron package exports the path to its binary
const tsc = join(app, "..", "..", "node_modules", ".bin", "tsc");

const vite = await createServer({ configFile: join(app, "vite.config.ts") });
await vite.listen();
const url = vite.resolvedUrls?.local[0];
if (!url) throw new Error("vite did not report a URL");
console.log(`renderer: ${url}`);

const children = new Set();
const run = (cmd, args, env = process.env) => {
  const c = spawn(cmd, args, { cwd: app, env, stdio: "inherit" });
  children.add(c);
  c.on("exit", () => children.delete(c));
  return c;
};

// One build first, so Electron starts from current code; then watch.
await new Promise((resolve, reject) => run(tsc, ["-b", "tsconfig.main.json"]).on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited ${code}`)))));
run(tsc, ["-b", "tsconfig.main.json", "--watch", "--preserveWatchOutput"]);

let electron;
let quitting = false;
const startElectron = () => {
  electron = run(electronBin, ["."], { ...process.env, CAIRN_RENDERER_URL: url });
  electron.on("exit", () => {
    if (!quitting && !restarting) shutdown(0); // the window was closed: end the dev session
  });
};
let restarting = false;
let timer;
const restart = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    restarting = true;
    electron?.once("exit", () => {
      restarting = false;
      startElectron();
    });
    electron?.kill("SIGTERM");
  }, 400);
};
for (const dir of ["dist/main", "dist/preload"]) watch(join(app, dir), { recursive: true }, (_e, f) => f && /\.c?js$/.test(f) && restart());
startElectron();

async function shutdown(code) {
  quitting = true;
  for (const c of children) c.kill("SIGTERM");
  await vite.close();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
