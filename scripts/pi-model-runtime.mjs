import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sdkRoot, jsonFile } from "./pi-host-skills.mjs";

export async function createPiModelRuntime(config) {
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
  return { root, sdk, runtime, model, thinking };
}
