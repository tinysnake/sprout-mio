import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("Machine transactions reject stale writers, preserve owner isolation and roll back diagnostic failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "sprout-machine-functional-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/machine-functional.ts"],
    {
      env: { ...process.env, DATABASE_URL: join(directory, "machine.sqlite") },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  expect(child.status, child.stderr + child.stdout).toBe(0);
  expect(child.stdout).toContain("PASS ownership rollback");
});
