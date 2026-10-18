import { defineConfig, lazyPlugins } from "vite-plus";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

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
