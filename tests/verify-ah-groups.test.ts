import { spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";

test("AH isolated groups preserve coverage, child failures and nested native cleanup", () => {
  const result = spawnSync(process.execPath, ["--test", "scripts/verify/ah-groups.test.mjs"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
