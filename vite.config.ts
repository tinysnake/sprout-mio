import { readFile } from "node:fs/promises";
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
        tanstackStart({ spa: { enabled: true } }),
        viteReact(),
      ]),
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 默认 5s 会把「spawn 子进程 + 并行争用」的用例打成假红；上限必须高于套件内最大内部 spawn 超时 (60s)，
    // 让真卡死报真实的 spawn 错误而不是脚手架超时。实测最慢单测（争用下）28.1s，取 3 倍以上。
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
  pack: [
    {
      name: "worker",
      entry: ["src/worker/main.ts"],
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
