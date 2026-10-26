import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test.each([
  {
    name: "MCP domain persists exact deliveries and rejects stale facts atomically",
    fixture: "mcp-worker-live.ts",
    marker: "PASS domain",
  },
  {
    name: "false acknowledgements preserve cleanup and bounded reconciliation admits fresh sessions",
    fixture: "mcp-ack-backlog.ts",
    marker: "E2b ",
  },
  {
    name: "close releases the exact process during attach and converges after lost session state",
    fixture: "mcp-attach-window.ts",
    marker: "E2 ",
  },
])("$name", ({ fixture, marker }) => {
  const directory = mkdtempSync(join(tmpdir(), "sprout-mcp-domain-"));
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", `tests/fixtures/${fixture}`], {
      env: {
        ...process.env,
        DATABASE_URL: join(directory, "private.sqlite"),
        SPROUT_PI_ENABLED: "false",
      },
      encoding: "utf8",
      timeout: 30000,
    });
    if (child.status !== 0) throw new Error(`MCP domain fixture failed: ${child.stderr}`);
    expect(child.stdout).toContain(marker);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
