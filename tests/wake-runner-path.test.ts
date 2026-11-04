import { describe, expect, it } from "vite-plus/test";
import { resolve } from "node:path";
import { wakeRunnerPath } from "../src/domain/wake-providers/llm";

describe("wake runner path", () => {
  it("uses the built app root instead of the caller cwd", () => {
    expect(wakeRunnerPath("/opt/sprout/app/.output/server/index.mjs", "/repo")).toBe(
      "/opt/sprout/app/scripts/pi-wake-runner.mjs",
    );
  });

  it("falls back to cwd for dev entrypoints", () => {
    expect(wakeRunnerPath("/repo/node_modules/vitest/vitest.mjs", "/repo")).toBe(
      resolve("/repo", "scripts/pi-wake-runner.mjs"),
    );
  });
});
