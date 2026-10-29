import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

// 真实 SQLite + 真实领域边界：非 holder 读取、交接后旧 holder、取消代次、软预算窗口都在子进程里跑。
test("acceptance fixes hold on real SQLite: holder reads, cancel generation, soft byte budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4c-accept-fixes-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/execution-accept-fixes.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "accept.sqlite"),
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
      throw new Error(`accept-fixes fixture failed: ${child.stderr || child.stdout}`);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("execution-accept-fixes: PASS");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
