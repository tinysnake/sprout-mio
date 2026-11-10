import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("lease timeout reminder, escalation and blocking wait on real SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "p8b-timeout-domain-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/p8b-timeout-domain.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "timeout.sqlite"),
          NODE_ENV: "test",
          SPROUT_PI_ENABLED: "false",
          BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
          NO_PROXY: "localhost,127.0.0.1,::1",
          no_proxy: "localhost,127.0.0.1,::1",
        },
        encoding: "utf8",
        timeout: 60000,
      },
    );
    if (child.status !== 0)
      throw new Error(`p8b timeout fixture failed: ${child.stderr || child.stdout}`);
    expect(child.stdout).toContain("p8b-timeout-domain: PASS all");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
