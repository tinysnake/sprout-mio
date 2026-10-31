import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const jsonFile = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
function sdkRoot(agentDir) {
  const candidates = [];
  try {
    let current = dirname(realpathSync(join(agentDir, "bin", "pi")));
    while (current !== dirname(current)) {
      if (jsonFile(join(current, "package.json"), {}).name === "@earendil-works/pi-coding-agent")
        candidates.push(current);
      current = dirname(current);
    }
  } catch {}
  const releases = join(agentDir, "install", "releases");
  if (existsSync(releases)) {
    const versions = readdirSync(releases).filter((version) =>
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version),
    );
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions)
      candidates.push(
        join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent"),
      );
  }
  const root = candidates.find((path) => existsSync(join(path, "dist", "index.js")));
  if (!root) throw new Error("provider_unavailable");
  return root;
}

async function main(config) {
  const root = sdkRoot(config.agentDir);
  const { ModelRuntime } = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const { ReadOnlyAuthStorage } = await import(
    pathToFileURL(join(root, "dist", "core", "auth-storage.js")).href
  );
  const runtime = await ModelRuntime.create({
    credentials: new ReadOnlyAuthStorage(join(config.agentDir, "auth.json")),
    modelsPath: existsSync(join(config.agentDir, "models.json"))
      ? join(config.agentDir, "models.json")
      : null,
    modelsStore: {
      read: async (provider) => jsonFile(join(config.agentDir, "models-store.json"), {})[provider],
      write: async () => {
        throw new Error("readonly");
      },
      delete: async () => {
        throw new Error("readonly");
      },
    },
    allowModelNetwork: false,
  });
  const slash = config.model.indexOf("/");
  if (slash < 1) throw new Error("provider_unavailable");
  const provider = config.model.slice(0, slash);
  const modelId = config.model.slice(slash + 1);
  if (provider === "magpie") {
    const settings = jsonFile(join(config.agentDir, "settings.json"), {});
    const packages = (settings.packages ?? []).flatMap((entry) => {
      const source = typeof entry === "string" ? entry : entry.source;
      return typeof source === "string" && (source.startsWith(".") || isAbsolute(source))
        ? [resolve(config.agentDir, source)]
        : [];
    });
    const providerRoot =
      process.env.SPROUT_PI_PROVIDER_ROOT ??
      packages.find((path) => jsonFile(join(path, "package.json"), {}).name === "pi-magpie");
    if (!providerRoot) throw new Error("provider_unavailable");
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
    // Match the host's installed TypeScript loader, without loading extensions or agent tools.
    const sdkRequire = createRequire(join(root, "package.json"));
    const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
    const jiti = createJiti(import.meta.url);
    const { createMagpieProvider } = await jiti.import(join(providerRoot, "provider.ts"));
    runtime.registerNativeProvider(createMagpieProvider().provider);
  }
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel(provider, modelId);
  if (!model || model.provider !== provider || model.id !== modelId)
    throw new Error("provider_unavailable");
  if (!runtime.hasConfiguredAuth(provider)) throw new Error("provider_auth_failed");
  const response = await runtime.complete(
    model,
    {
      systemPrompt: config.system,
      messages: [
        { role: "user", content: config.prompt, timestamp: Date.parse(config.evaluatedAt) },
      ],
      tools: [],
    },
    { maxTokens: 3000, signal: AbortSignal.timeout(config.timeoutMs) },
  );
  if (response.stopReason !== "stop" || response.content.some((item) => item.type === "toolCall"))
    throw new Error("provider_invalid_response");
  return {
    text: response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(""),
    inputTokens: response.usage.input,
    outputTokens: response.usage.output,
  };
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(await main(JSON.parse(input))));
} catch (error) {
  const errorCode = [
    "provider_unavailable",
    "provider_auth_failed",
    "provider_invalid_response",
  ].includes(error?.message)
    ? error.message
    : "provider_unavailable";
  process.stdout.write(JSON.stringify({ errorCode }));
  process.exitCode = 1;
}
