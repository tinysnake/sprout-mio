/**
 * P0-d experiment f: the SDK path, run in-process under the managed Pi 1.3.0
 * release. It covers the same surfaces as the CLI experiments so the
 * recommendation in docs/p0/pi-integration.md compares like with like.
 *
 * There is no npm install here. The SDK and the model runtime are imported by
 * absolute path from the managed release, and the runtime is built over the
 * same auth and model stores the CLI uses. That is the wiring the reference
 * Sprout runner used too (src/engine/pi-host-runner.mjs at sprout 5b48a53).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
const sessionDir = join(resultsDir, "f-sdk-sessions");
const cwd = join(resultsDir, "f-sdk-cwd");
rmSync(sessionDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
mkdirSync(sessionDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

const NODE_MODULES = "/Users/snake/.pi/agent/install/releases/1.3.0/node_modules";
const RELEASE = join(NODE_MODULES, "@earendil-works/pi-coding-agent");
const sdk = await import(pathToFileURL(join(RELEASE, "dist/index.js")).href);
const { createAgentSession, SessionManager, ModelRuntime, getAgentDir, DefaultResourceLoader } = sdk;
const { ReadOnlyAuthStorage } = await import(
  pathToFileURL(join(RELEASE, "dist/core/auth-storage.js")).href
);

const agentDir = getAgentDir();
const summary = { scenario: "f-sdk", agentDir };

const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");

const buffered = (session, sink) =>
  session.subscribe((event) => {
    if (event.type !== "message_update") sink.push(`${event.type}${event.toolName ? `:${event.toolName}` : ""}`);
  });

const waitForEvent = async (sink, prefix, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!sink.some((e) => e.startsWith(prefix))) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${prefix}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// --- 0. what the bare factory resolves to -----------------------------------
// Recorded, not asserted: the CLI resolves defaultProvider=magpie, the bare SDK
// factory does not load the extension that registers that provider.
const bareEvents = [];
const bare = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory() });
buffered(bare.session, bareEvents);
summary.bareFactoryModel = bare.session.model
  ? `${bare.session.model.provider}/${bare.session.model.id}`
  : null;
await bare.session.prompt("Reply with exactly BARE_SDK_PROBE.");
const bareLast = bare.session.messages.at(-1);
summary.bareFactoryStopReason = bareLast?.stopReason ?? null;
summary.bareFactoryDiagnostic = bareLast?.diagnostics?.[0]?.error?.message ?? null;
bare.session.dispose();

// --- model runtime over the real stores -------------------------------------
const modelsStorePath = join(agentDir, "models-store.json");
const runtime = await ModelRuntime.create({
  credentials: new ReadOnlyAuthStorage(join(agentDir, "auth.json")),
  modelsPath: join(agentDir, "models.json"),
  modelsStore: {
    read: async (provider) =>
      existsSync(modelsStorePath)
        ? JSON.parse(readFileSync(modelsStorePath, "utf8"))[provider]
        : undefined,
    write: async () => {},
    delete: async () => {},
  },
  allowModelNetwork: false,
});
await runtime.refresh({ allowNetwork: false });
const model = runtime.getModel("deepseek", "deepseek-flash");
summary.runtimeModel = model ? `${model.provider}/${model.id}` : null;
summary.runtimeAuthConfigured = runtime.hasConfiguredAuth("deepseek");
summary.runtimeHasMagpie = runtime.getModel("magpie", "group/auto-deepseek-v4-1-flash") !== undefined;

// --- 1. create, prompt, inherit credentials ---------------------------------
const events1 = [];
const created = await createAgentSession({
  cwd,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  tools: ["read", "bash"],
  sessionManager: SessionManager.create(cwd, sessionDir, { id: "probe-f" }),
});
const session = created.session;
summary.sessionFile = session.sessionFile;
buffered(session, events1);
await session.prompt("Reply with exactly SDK_PROBE_OK");
summary.promptText = textOf(session.messages.at(-1));
summary.authInherited = summary.promptText?.includes("SDK_PROBE_OK") ?? false;

// --- 2. steer a live run -----------------------------------------------------
const events2 = [];
const unsub2 = buffered(session, events2);
const run = session.prompt(
  "Use the bash tool to run the command `sleep 20`. After it returns, reply with the single word SLEPT.",
);
await waitForEvent(events2, "tool_execution_start");
summary.sdkSteerDisposition = await session.steer(
  "Ignore the sleep task. Reply with exactly SDK_STEER_RECEIVED and nothing else.",
);
await run;
summary.sdkSteerFinalText = textOf(session.messages.at(-1));
unsub2();

// --- 3. abort a live run -----------------------------------------------------
const events3 = [];
const unsub3 = buffered(session, events3);
const abortRun = session.prompt(
  "Use the bash tool to run the command `sleep 60`, then reply with the single word DONE.",
);
await waitForEvent(events3, "tool_execution_start");
await session.abort();
await abortRun.catch((error) => {
  summary.abortRunError = String(error?.message ?? error);
});
summary.sdkSawAgentSettledAfterAbort =
  events3.includes("agent_settled") || events3.includes("agent_end");
session.dispose();
summary.firstSessionDisposed = true;

// --- 4. reopen the persisted session and confirm history ---------------------
const reopened = await createAgentSession({
  cwd,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  tools: ["read", "bash"],
  sessionManager: SessionManager.open(summary.sessionFile),
});
const events4 = [];
buffered(reopened.session, events4);
await reopened.session.prompt(
  "Without running any command, answer in one line: which codeword did you reply with earlier, and what task was aborted?",
);
summary.resumeText = textOf(reopened.session.messages.at(-1));
summary.resumeSawHistory =
  (summary.resumeText?.includes("SDK_STEER_RECEIVED") ?? false) ||
  (summary.resumeText?.toLowerCase().includes("aborted") ?? false);
reopened.session.dispose();

// --- 5. load the probe extension through the SDK resource loader -------------
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  modelRuntime: runtime,
  additionalExtensionPaths: [join(here, "ext", "sprout-probe.ts")],
});
await resourceLoader.reload();
const withExt = await createAgentSession({
  cwd,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  resourceLoader,
  tools: ["sprout_probe_ping"],
  sessionManager: SessionManager.inMemory(),
});
const events5 = [];
buffered(withExt.session, events5);
await withExt.session.prompt(
  "Call the sprout_probe_ping tool, then reply with its exact output.",
);
summary.sdkExtensionText = textOf(withExt.session.messages.at(-1));
summary.sdkExtensionLoaded = summary.sdkExtensionText?.includes("SPROUT_EXTENSION_LOADED") ?? false;
summary.sdkExtensionToolIsActive = (withExt.session.getActiveToolNames?.() ?? []).includes(
  "sprout_probe_ping",
);
withExt.session.dispose();

summary.events = {
  bare: bareEvents,
  first: events1,
  steer: events2,
  abort: events3,
  resume: events4,
  extension: events5,
};

writeFileSync(join(resultsDir, "f-sdk.summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
