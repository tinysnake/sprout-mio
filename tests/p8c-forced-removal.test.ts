import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

/**
 * 强制移除的每个场景各需要一个干净的库（fixture 的 setup() 固定插入同一个 user 行），
 * 所以逐个 scenario 起一个子进程。
 */
const scenarios = ["normal", "retained", "fencing", "handoff", "isolation"] as const;

describe("p8c forced project member removal", () => {
  for (const scenario of scenarios) {
    it(`${scenario}: fixture passes`, () => {
      const directory = mkdtempSync(join(tmpdir(), "sprout-p8c-forced-removal-"));
      try {
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx", "tests/fixtures/p8c-forced-removal.ts", scenario],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: "test",
              SPROUT_PI_ENABLED: "false",
              DATABASE_URL: join(directory, `${scenario}.sqlite`),
            },
            encoding: "utf8",
            timeout: 120000,
          },
        );
        expect(child.status, child.stderr || child.stdout).toBe(0);
        expect(child.stdout).toContain(`p8c forced removal ${scenario} ok`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
