import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const scenarios = [
  ["detach", "带租约移出：无租约直接 removed、held 同事务完成、在途停在 detaching"],
  ["rejoin", "重新加入只建 epoch+1，旧行与租约代次不被改写"],
  ["notices", "资源撤销通知单一根因、崩溃窗口内至少一次、配额不截断"],
  ["force", "强制收回后 removed 仍显示 unconfirmed，且只有显式 rejoin 能复活"],
  ["pending", "待处理投影三类输入、14999/15000 边界与在线离线两维"],
  ["authority", "越权面：非成员、未绑定、已移出与 Agent 身份"],
] as const;

for (const [scenario, name] of scenarios) {
  test(name, () => {
    const directory = mkdtempSync(join(tmpdir(), `p4d-removal-${scenario}-`));
    try {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/p4d-removal.ts", scenario],
        {
          env: {
            ...process.env,
            DATABASE_URL: join(directory, "removal.sqlite"),
            SPROUT_PI_ENABLED: "false",
            NO_PROXY: "localhost,127.0.0.1",
          },
          encoding: "utf8",
          timeout: 120000,
        },
      );
      if (child.status !== 0) throw new Error(`p4d removal fixture failed: ${child.stderr}`);
      expect(child.status).toBe(0);
      expect(child.stdout).toContain("PASS");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
