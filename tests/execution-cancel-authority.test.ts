import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("human cancellation authority holds on real SQLite and the Web boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4c-execution-cancel-authority-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/execution-cancel-authority.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: join(directory, "cancel.sqlite"),
        NODE_ENV: "test",
        SPROUT_PI_ENABLED: "false",
        BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
      },
      encoding: "utf8",
      timeout: 180000,
    },
  );
  if (child.status !== 0)
    throw new Error(`execution cancel authority fixture failed: ${child.stderr}`);
  expect(child.stdout).toContain("execution-cancel-authority: PASS");
});
