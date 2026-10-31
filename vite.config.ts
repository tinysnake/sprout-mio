import { readFile, writeFile } from "node:fs/promises";
import { OFFLINE_READ_FUNCTIONS } from "./src/lib/offline-read-functions";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";
import type { Plugin } from "vite-plus";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * 共享组件的开发演示入口：只在 dev server 上挂 /__dev/ui，正式构建既不产出
 * 这个 HTML，也不会打包 src/dev。页面本身复用产品的 styles.css 与组件。
 */
function devComponentGallery(): Plugin {
  return {
    name: "sprout-dev-component-gallery",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/ui", async (request, response, next) => {
        const path = (request.url ?? "/").split("?")[0];
        if (path !== "/" && path !== "/index.html") return next();
        try {
          const html = await readFile(join(projectRoot, "src/dev/ui/index.html"), "utf8");
          const transformed = await server.transformIndexHtml("/__dev/ui/", html);
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(transformed);
        } catch (cause) {
          next(cause);
        }
      });
    },
  };
}

/** Build the complete client chunk list; lazy detail routes work offline after install. */
function pwaAssets(): Plugin {
  return {
    name: "sprout-pwa-assets",
    apply: "build",
    async generateBundle(_options, bundle) {
      if (this.environment.name === "ssr") {
        const reads: Record<string, string> = {};
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          for (const match of output.code.matchAll(/id:\s*"([a-f0-9]+)",\s*name:\s*"([^"]+)"/g)) {
            if ((OFFLINE_READ_FUNCTIONS as readonly string[]).includes(match[2]))
              reads[match[1]] = match[2];
          }
        }
        if (!Object.values(reads).includes("getChatSessionFn"))
          throw new Error("PWA read manifest is missing getChatSessionFn");
        await writeFile(join(projectRoot, ".output/public/pwa-reads.json"), JSON.stringify(reads));
        return;
      }
      if (this.environment.name !== "client") return;
      this.emitFile({
        type: "asset",
        fileName: "pwa-assets.json",
        source: JSON.stringify(
          Object.keys(bundle)
            .filter((name) => /\.(?:js|css|woff2?)$/.test(name))
            .map((name) => "/" + name),
        ),
      });
    },
  };
}

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "experiments/**",
      "docs/*.md",
      "docs/p0/**",
      "README.md",
      "drizzle/meta/**",
      "src/routeTree.gen.ts",
      "src/db/auth-schema.ts",
      // 证据快照按探针实际写出的字节保存，格式化成别的形状就和被验产物对不上了。
      "docs/r1/evidence/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "experiments/**",
      "dist/**",
      ".output/**",
      "src/routeTree.gen.ts",
      "src/db/auth-schema.ts",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  resolve: { tsconfigPaths: true },
  plugins: process.env.VITEST
    ? []
    : lazyPlugins(() => [
        devtools(),
        nitro({
          plugins: ["./src/server/server-entry.ts"],
          rollupConfig: { external: [/^@sentry\//] },
        }),
        tailwindcss(),
        devComponentGallery(),
        pwaAssets(),
        tanstackStart({ spa: { enabled: true } }),
        viteReact(),
      ]),
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    maxWorkers:
      process.env.SPROUT_VERIFY_RUN_DIR && process.env.SPROUT_VERIFY_FULL_SUITE !== "1"
        ? 4
        : undefined,
    // 默认 5s 会把「spawn 子进程 + 并行争用」的用例打成假红；上限必须高于套件内最大内部 spawn 超时 (60s)，
    // 让真卡死报真实的 spawn 错误而不是脚手架超时。实测最慢单测（争用下）28.1s，取 3 倍以上。
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
  pack: [
    {
      name: "worker",
      entry: ["src/worker/main.ts", "src/worker/runner.mjs"],
      tsconfig: "tsconfig.worker.json",
      outDir: "dist/worker",
      deps: { alwaysBundle: [/^effect(?:\/|$)/, /^zod(?:\/|$)/] },
      fixedExtension: false,
    },
    {
      name: "extension",
      entry: ["src/extension/main.ts"],
      tsconfig: "tsconfig.extension.json",
      outDir: "dist/extension",
      fixedExtension: false,
    },
  ],
});
