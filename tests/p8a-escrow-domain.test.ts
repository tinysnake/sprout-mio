import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("lease escrow and claim hold on real SQLite with real identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "p8a-escrow-domain-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/p8a-escrow-domain.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "escrow.sqlite"),
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
      throw new Error(`p8a escrow fixture failed: ${child.stderr || child.stdout}`);
    expect(child.stdout).toContain("p8a-escrow-domain: PASS all");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
