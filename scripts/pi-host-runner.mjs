import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const input = createInterface({ input: process.stdin });
const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let session;
let opening = false;
let prompting = false;
let closing = false;
let openId = "unknown";

function failure(id, code, message, stopReason) {
  line({ type: "failure", id, code, message, ...(stopReason ? { stopReason } : {}) });
}

function sdkRoot(agentDir) {
  const releases = join(agentDir, "install", "releases");
  const candidates = [];
  try {
    const executable = realpathSync(join(agentDir, "bin", "pi"));
    let current = dirname(executable);
    while (current !== dirname(current)) {
      if (existsSync(join(current, "package.json"))) {
        const pkg = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") candidates.push(current);
      }
      current = dirname(current);
    }
  } catch {}
  if (existsSync(releases)) {
    const versions = readdirSync(releases).filter((value) =>
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value),
    );
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions)
      candidates.push(
        join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent"),
      );
  }
  const root = candidates.find((path) => existsSync(join(path, "dist", "index.js")));
  if (!root) throw new Error("找不到 Pi SDK，请在 PI_CODING_AGENT_DIR 对应目录安装托管 Pi");
  return root;
}

function jsonFile(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

async function open(config) {
  const root = sdkRoot(config.agentDir);
  const sdk = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const { ReadOnlyAuthStorage } = await import(
    pathToFileURL(join(root, "dist", "core", "auth-storage.js")).href
  );
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ReadOnlyAuthStorage(join(config.agentDir, "auth.json")),
    modelsPath: existsSync(join(config.agentDir, "models.json"))
      ? join(config.agentDir, "models.json")
      : null,
    modelsStore: {
      read: async (provider) => jsonFile(join(config.agentDir, "models-store.json"), {})[provider],
      write: async () => {
        throw new Error("只读模型目录");
      },
      delete: async () => {
        throw new Error("只读模型目录");
      },
    },
    allowModelNetwork: false,
  });
  const defaults = jsonFile(join(config.agentDir, "settings.json"), {});
  const selected = config.profile.model;
  const slash = selected?.indexOf("/") ?? -1;
  const provider = slash > 0 ? selected.slice(0, slash) : defaults.defaultProvider;
  const modelId = slash > 0 ? selected.slice(slash + 1) : (selected ?? defaults.defaultModel);
  if (!provider || !modelId)
    throw new Error("Agent profile 或 Pi settings.json 必须指定 provider 与 model");
  if (provider === "magpie") {
    const configuredPackages = (defaults.packages ?? []).flatMap((entry) => {
      const source = typeof entry === "string" ? entry : entry.source;
      return typeof source === "string" && (source.startsWith(".") || isAbsolute(source))
        ? [resolve(config.agentDir, source)]
        : [];
    });
    const providerRoot =
      process.env.SPROUT_PI_PROVIDER_ROOT ??
      configuredPackages.find(
        (path) => jsonFile(join(path, "package.json"), {}).name === "pi-magpie",
      );
    if (!providerRoot || !existsSync(join(providerRoot, "provider.ts"))) {
      throw new Error(
        "magpie 需要配置本地 pi-magpie package，或用 SPROUT_PI_PROVIDER_ROOT 指向 provider.ts 所在目录",
      );
    }
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@earendil-works/pi-ai/compat")
          return {
            url: pathToFileURL(join(dirname(root), "pi-ai", "dist", "compat.js")).href,
            shortCircuit: true,
          };
        return nextResolve(specifier, context);
      },
    });
    const { createMagpieProvider } = await import(
      pathToFileURL(join(providerRoot, "provider.ts")).href
    );
    runtime.registerNativeProvider(createMagpieProvider().provider);
  }
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel(provider, modelId);
  if (!model || model.provider !== provider || model.id !== modelId)
    throw new Error("指定的 Pi model 不存在，检查 Agent profile 的 provider/model");
  if (!runtime.hasConfiguredAuth(provider)) throw new Error("Pi provider 尚未配置凭据");
  const thinking = config.profile.effort ?? defaults.defaultThinkingLevel ?? "medium";
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking))
    throw new Error("Pi 不支持该 thinking 配置");
  mkdirSync(config.cwd, { recursive: true, mode: 0o700 });
  mkdirSync(config.sessionDirectory, { recursive: true, mode: 0o700 });
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: true },
  });
  const controlledDir = join(config.cwd, ".sprout-pi");
  mkdirSync(controlledDir, { recursive: true, mode: 0o700 });
  const { default: sproutExtension } = await import(pathToFileURL(config.extensionPath).href);
  // Use the same TypeScript loader as the installed SDK for shared contract imports.
  const sdkRequire = createRequire(join(root, "package.json"));
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
  const jiti = createJiti(import.meta.url);
  const { createRemoteClient } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/remote-client.ts"),
  );
  const { registerRemoteTools } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/remote-tools.ts"),
  );
  const { registerTaskTools } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/task-tools.ts"),
  );
  const { taskToolInputSchemas } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/task.ts"),
  );
  const { remoteToolInputSchemas } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/contracts/remote.ts"),
  );
  const { registerSproutMcp } = await jiti.import(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/extension/mcp-extension.ts"),
  );
  const remoteClient = createRemoteClient(config.remote);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: controlledDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "sprout-extension",
        factory: async (pi) => {
          sproutExtension(pi);
          let target = null;
          let mcp;
          const remote = {
            projectId: remoteClient.projectId,
            async request(request, signal) {
              const response = await remoteClient.request(request, signal);
              if (response.outcome === "response" && response.result.ok) {
                const { call } = request;
                const data = response.result.data;
                let next;
                if (call.type === "lease_get")
                  next =
                    data.lease.state === "held"
                      ? { machineId: call.input.machineId, generation: data.lease.generation }
                      : null;
                if (call.type === "lease_mutate")
                  next =
                    call.input.action === "acquire" && data.state === "completed"
                      ? { machineId: call.input.machineId, generation: data.completedGeneration }
                      : null;
                if (next !== undefined && JSON.stringify(next) !== JSON.stringify(target)) {
                  target = next;
                  const refreshed = await mcp.refresh();
                  // 不假装成功：目录已变但工具面没跟进时，把失败推到 stderr 的 runner 协议行外，
                  // 由 `sprout_status` 的诊断槽与验收脚本读取。
                  if (refreshed.outcome === "failed")
                    line({
                      type: "progress",
                      id: config.id,
                      kind: "mcp_surface_failed",
                      message: refreshed.error.message,
                    });
                }
              }
              return response;
            },
          };
          mcp = await registerSproutMcp(pi, {
            remote,
            machineId: () => target?.machineId ?? null,
            authorizationGeneration: () => target?.generation ?? null,
          });
          registerRemoteTools(pi, remote);
          registerTaskTools(pi, remote);
        },
      },
    ],
    systemPrompt: config.profile.persona,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length) throw new Error("Sprout extension 加载失败");
  const existing = sdk.SessionManager.findById(
    config.cwd,
    config.sessionId,
    config.sessionDirectory,
  );
  if (config.sessionFile && !existsSync(config.sessionFile))
    throw new Error("持久 Pi session 文件缺失，拒绝创建替代会话");
  const sessionFile = config.sessionFile ?? existing;
  const manager = sessionFile
    ? sdk.SessionManager.open(sessionFile, config.sessionDirectory, config.cwd)
    : sdk.SessionManager.create(config.cwd, config.sessionDirectory, { id: config.sessionId });
  if (manager.getSessionId() !== config.sessionId) throw new Error("Pi session 身份不匹配");
  ({ session } = await sdk.createAgentSession({
    cwd: config.cwd,
    agentDir: controlledDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: thinking,
    // MCP 工具必须以 `mcp__*` 出现在这一条 allowlist 里，否则 Pi 只把它们留在 registry、
    // 不声明给模型（`_isActivatable` 对 `direct` exposure 恒为 false，`setActiveTools` 也救不回来）。
    // 这是 `list_changed` 后新工具到不了模型工具面的根因，详见
    // `orchestrate/sprout-mio-r1/reports/remediation-extension.md`。
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "mcp__*",
      ...Object.keys(remoteToolInputSchemas),
      ...Object.keys(taskToolInputSchemas),
    ],
    resourceLoader,
    settingsManager,
    sessionManager: manager,
  }));
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      line({
        type: "progress",
        id: config.id,
        kind: "text_delta",
        text: event.assistantMessageEvent.delta,
      });
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      line({
        type: "progress",
        id: config.id,
        kind: event.type === "tool_execution_start" ? "tool_start" : "tool_end",
        toolName: event.toolName,
      });
    }
  });
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  if (extensionErrors.length)
    throw new Error(
      `Sprout extension 初始化失败：${extensionErrors
        .map((error) =>
          error instanceof Error
            ? error.message
            : JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
        )
        .join("; ")}`,
    );
  if (session.model?.provider !== provider || session.model?.id !== modelId)
    throw new Error("Pi 实际模型与显式配置不匹配");
  const pkg = jsonFile(join(root, "package.json"), {});
  line({
    type: "ready",
    id: config.id,
    snapshot: {
      provider: session.model.provider,
      model: session.model.id,
      thinking: session.thinkingLevel,
      tools: session.getActiveToolNames().sort(),
      extensions: extensions.extensions.map((extension) =>
        extension.path.replace(/^<inline:(.*)>$/, "$1"),
      ),
      sessionId: config.sessionId,
      sessionFile: session.sessionFile,
      cwd: config.cwd,
      sdkVersion: pkg.version,
      profile: config.profile,
    },
  });
}

async function prompt(command) {
  prompting = true;
  const start = session.messages.length;
  line({ type: "input_delivered", id: command.id, messageId: command.messageId });
  try {
    await session.prompt(command.text, { expandPromptTemplates: false, source: "rpc" });
    const assistants = session.messages.slice(start).filter((entry) => entry.role === "assistant");
    const failed = assistants.find(
      (entry) => entry.stopReason === "error" || entry.stopReason === "aborted",
    );
    if (failed) {
      failure(
        command.id,
        failed.stopReason === "error" ? "model_error" : "model_aborted",
        "Pi 模型未正常完成本轮",
        failed.stopReason,
      );
      return;
    }
    const last = assistants.at(-1);
    if (last?.stopReason !== "stop") {
      failure(
        command.id,
        "invalid_stop_reason",
        "Pi 没有返回正常停止原因",
        last?.stopReason ?? "missing",
      );
      return;
    }
    const text = last.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text || text.length > 8000) {
      failure(command.id, "invalid_reply", "Pi 回复为空或超过消息长度限制", last.stopReason);
      return;
    }
    line({ type: "settled", id: command.id, text, stopReason: last.stopReason });
  } catch {
    failure(command.id, "prompt_failed", "Pi prompt 调用失败");
  } finally {
    prompting = false;
  }
}

async function deliverSteer(command) {
  if (!session.isStreaming) {
    line({
      type: "input_rejected",
      id: command.id,
      messageId: command.messageId,
      reason: "Pi 会话当前不在运行，消息未进入本轮",
    });
    return;
  }
  try {
    await session.steer(command.text, undefined, { source: "rpc" });
    line({ type: "input_delivered", id: command.id, messageId: command.messageId });
  } catch {
    line({
      type: "input_rejected",
      id: command.id,
      messageId: command.messageId,
      reason: "Pi 会话拒绝了该消息",
    });
  }
}

async function close() {
  if (closing) return;
  closing = true;
  try {
    await session?.abort();
  } finally {
    session?.dispose();
    input.close();
    process.exit(0);
  }
}

input.on("line", (raw) => {
  let command;
  try {
    command = JSON.parse(raw);
  } catch {
    return;
  }
  if (command.type === "open" && !opening) {
    opening = true;
    openId = command.id;
    void open(command).catch((error) => {
      const safe = [
        "找不到 Pi SDK",
        "Agent profile 或 Pi",
        "magpie 需要",
        "指定的 Pi model",
        "Pi provider",
        "Pi 不支持",
        "Sprout extension",
        "持久 Pi session",
        "Pi session 身份",
        "Pi 实际模型",
      ];
      const message = safe.some((prefix) => error.message?.startsWith(prefix))
        ? error.message
        : "Pi session 初始化失败，请检查宿主 SDK 与配置";
      failure(command.id, "session_open_failed", message);
      session?.dispose();
      input.close();
      process.exitCode = 1;
    });
  } else if (command.type === "prompt" && session && !prompting && !closing) {
    void prompt(command);
  } else if (command.type === "steer" && session && !closing) {
    void deliverSteer(command);
  } else if (command.type === "abort") {
    void session?.abort();
  } else if (command.type === "close") {
    void close();
  }
});
input.on("close", () => {
  if (!closing) void close();
});
process.on("SIGTERM", () => {
  void close();
});
process.on("uncaughtException", () => {
  failure(openId, "runner_crashed", "Pi runner 异常退出");
  process.exit(1);
});
