// M0 spike 1 (throwaway): interactive login. Run in YOUR terminal, not inside the Claude sandbox
// (the ChatGPT flow must bind 127.0.0.1:1455; Anthropic's prefers 53692).
//   node login.mjs anthropic oauth      # Claude Team seat
//   node login.mjs openai oauth         # ChatGPT plan
//   node login.mjs anthropic api_key    # fallback key (prompted, hidden)
//   node login.mjs openai api_key
//   node login.mjs openai-codex oauth   # legacy ChatGPT route (chatgpt.com); binds 1455 like the Codex CLI
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { makeModels, SECRETS_DIR, storePath } from "./lib.mjs";

// Sign in with ChatGPT requires a stable per-installation UUID (sent as ext_agent_host_id).
// Must be the same on every login, so persist it on first use.
function getDeviceId() {
  const path = join(SECRETS_DIR, "device-id");
  try { return readFileSync(path, "utf8").trim(); }
  catch (e) {
    if (e.code !== "ENOENT") throw e;
    const id = randomUUID();
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, id, { mode: 0o600 });
    return id;
  }
}

const [provider, kind] = process.argv.slice(2);
if (!["anthropic", "openai", "openai-codex"].includes(provider) || !["oauth", "api_key"].includes(kind)) {
  console.error("usage: node login.mjs <anthropic|openai|openai-codex> <oauth|api_key>");
  process.exit(2);
}

const rl = createInterface({ input: stdin, output: stdout, terminal: true });

async function ask(message, secret) {
  if (!secret) return (await rl.question(`${message}\n> `)).trim();
  // Hide typed secret: mute echo while reading.
  const write = rl._writeToOutput;
  rl._writeToOutput = (s) => { if (s.includes(message)) write.call(rl, s); };
  const answer = await rl.question(`${message}\n> `);
  rl._writeToOutput = write;
  stdout.write("\n");
  return answer.trim();
}

const interaction = {
  async prompt(p) {
    if (p.type === "select") {
      p.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`));
      const n = Number(await ask(p.message, false));
      return p.options[n - 1]?.id ?? p.options[0].id;
    }
    return ask(p.message, p.type === "secret");
  },
  notify(e) {
    if (e.type === "auth_url") console.log(`\nOpen this URL in your browser:\n${e.url}\n${e.instructions ?? ""}\n`);
    else if (e.type === "device_code") console.log(`Code ${e.userCode} at ${e.verificationUri}`);
    else if (e.type === "info") console.log(e.message, ...(e.links ?? []).map((l) => l.url));
    else if (e.type === "progress") console.log(`… ${e.message}`);
  },
};

const models = makeModels(kind);
try {
  const cred = await models.login(provider, kind, interaction, { agentName: "cairn-spike", getDeviceId });
  console.log(`\nStored ${cred.type} credential for ${provider} in ${storePath(kind)}`);
  if (cred.type === "oauth") console.log(`Access token expires ${new Date(cred.expires).toISOString()}`);
} catch (e) {
  console.error(`\nLogin failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
