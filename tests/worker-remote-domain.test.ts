import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
test("lease and execution transactions fence real gateway deliveries and isolate Projects", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4b-remote-domain-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/worker-remote-domain.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: join(directory, "remote.sqlite"),
        SPROUT_PI_ENABLED: "false",
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  if (child.status !== 0) throw new Error(`remote domain fixture failed: ${child.stderr}`);
  expect(child.status).toBe(0);
});
