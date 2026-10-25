import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("MCP domain persists exact gateway deliveries, rejects stale and cross Project facts atomically, and tombstones acknowledged frames", () => {
  const directory = mkdtempSync(join(tmpdir(), "sprout-mcp-domain-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/mcp-worker-live.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "private.sqlite"),
          SPROUT_PI_ENABLED: "false",
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    if (child.status !== 0) throw new Error(`MCP domain fixture failed: ${child.stderr}`);
    expect(child.stdout).toContain("PASS domain");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
