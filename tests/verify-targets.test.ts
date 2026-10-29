import { spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";

test("distributed verification preserves inventory, target isolation and failure results", () => {
  const result = spawnSync(process.execPath, ["--test", "scripts/verify/targets.test.mjs"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
