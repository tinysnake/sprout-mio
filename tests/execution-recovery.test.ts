import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("recovery, log cursor and cancellation state machines hold on real SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4c-execution-recovery-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/execution-recovery.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: join(directory, "recovery.sqlite"),
        NODE_ENV: "test",
        SPROUT_PI_ENABLED: "false",
      },
      encoding: "utf8",
      timeout: 120000,
    },
  );
  if (child.status !== 0) throw new Error(`execution recovery fixture failed: ${child.stderr}`);
  expect(child.stdout).toContain("execution-recovery: PASS");
});
