import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

// 真实 SQLite + 真实 OS 子进程 + 真实 Worker outbox：R1 取消重放的通道核对、R2 大输出的
// 补送与截断、R4 有/无 runner result 的两种取消终态都在子进程里跑。
test("acceptance fixes 2 hold on real SQLite and real subprocesses", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4c-accept-fixes-2-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/execution-accept-fixes-2.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "accept2.sqlite"),
          SPROUT_PI_ENABLED: "false",
        },
        encoding: "utf8",
        timeout: 120000,
      },
    );
    if (child.status !== 0)
      throw new Error(`accept-fixes-2 fixture failed: ${child.stderr || child.stdout}`);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("execution-accept-fixes-2: PASS (13 checks)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
