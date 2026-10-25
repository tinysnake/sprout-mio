import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

for (const [scenario, name] of [
  [
    "independence",
    "Project × Machine budgets admit independent Projects, cap each pair at 64 and keep executions private",
  ],
  ["expiration", "reclaiming quota expires only the submitting Project × Machine"],
] as const) {
  test(name, () => {
    const directory = mkdtempSync(join(tmpdir(), "p4b-quota-scope-"));
    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/quota-scope.ts", scenario],
        {
          env: {
            ...process.env,
            DATABASE_URL: join(directory, "quota.sqlite"),
            SPROUT_PI_ENABLED: "false",
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      if (child.status !== 0) throw new Error(`quota scope fixture failed: ${child.stderr}`);
      expect(child.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
