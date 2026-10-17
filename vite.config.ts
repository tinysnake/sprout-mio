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
        nitro({ rollupConfig: { external: [/^@sentry\//] } }),
        tailwindcss(),
        tanstackStart({ spa: { enabled: true } }),
        viteReact(),
      ]),
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
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
