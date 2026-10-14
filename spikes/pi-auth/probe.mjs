// M0 spike 1 (throwaway): one tiny completion per engine effort level; records the native effort
// setting pi-ai sends, token usage, and auth source.
//   node probe.mjs <anthropic|openai> <oauth|api_key> <model-id> [low,medium,high,max]
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { logCall, makeModels, nativeEffort } from "./lib.mjs";

const [provider, kind, modelId, effortsArg = "low,medium,high,max"] = process.argv.slice(2);
if (!provider || !kind || !modelId) {
  console.error("usage: node probe.mjs <anthropic|openai> <oauth|api_key> <model-id> [efforts]");
  process.exit(2);
}

// Engine levels (DR-0013) -> pi-ai reasoning levels. Identity for now; the spike checks it is honored.
const ENGINE_TO_PI = { low: "low", medium: "medium", high: "high", max: "max" };

const models = makeModels(kind);
const model = models.getModel(provider, modelId);
if (!model) { console.error(`pi-ai does not know ${provider}/${modelId} (needs a shim)`); process.exit(1); }

let authSource;
try {
  const auth = await models.getAuth(provider);
  if (!auth) { console.error(`No ${kind} credential for ${provider}. Run login.mjs first.`); process.exit(1); }
  authSource = auth.source;
} catch (e) {
  console.error(`Auth resolution failed (${e.code ?? "?"}): ${e.message}`);
  process.exit(1);
}

const supported = getSupportedThinkingLevels(model);
console.log(`${provider}/${modelId} via ${kind} (source: ${authSource}); pi-ai levels: ${supported.join(",")}\n`);

for (const effort of effortsArg.split(",")) {
  const level = ENGINE_TO_PI[effort];
  let native = {};
  const t0 = Date.now();
  const msg = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: "Reply with exactly one word: ok", timestamp: Date.now() }] },
    {
      reasoning: level,
      onPayload: (p) => { native = nativeEffort(p); },
      // Diagnostic: log endpoint and response metadata (never request headers).
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        console.error("Request:", url.origin + url.pathname);
        const response = await globalThis.fetch(input, init);
        console.error("Response:", {
          status: response.status,
          cfRay: response.headers.get("cf-ray"),
          requestId: response.headers.get("x-request-id"),
        });
        if (!response.ok) console.error(await response.clone().text());
        return response;
      },
    },
  );
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const rec = await logCall({
    spike: "pi-auth", provider, model: modelId, auth: kind, authSource,
    effort, piReasoning: level, levelSupported: supported.includes(level), native,
    stopReason: msg.stopReason, error: msg.errorMessage ?? null,
    usage: { input: msg.usage?.input, output: msg.usage?.output, cacheRead: msg.usage?.cacheRead, cacheWrite: msg.usage?.cacheWrite, costUsd: msg.usage?.cost?.total },
    ms: Date.now() - t0, reply: text.slice(0, 40),
  });
  const status = rec.error ? `ERROR ${rec.error}` : `ok "${rec.reply}"`;
  console.log(`${effort.padEnd(6)} native=${JSON.stringify(native)}`);
  console.log(`       tokens in/out=${rec.usage.input}/${rec.usage.output} ${rec.ms}ms -> ${status}\n`);
}
