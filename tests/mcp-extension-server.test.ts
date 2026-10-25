import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

/**
 * 服务端 MCP 分支的隔离 SQLite 反证。真实表、真实约束、真实 immediate 事务；
 * 只有 Machine 侧的进程与帧搬运被夹具替换（那属 r1-worker）。
 */
it("Agent 侧四个 MCP 分支在隔离 SQLite 上完成授权与状态反证", () => {
  const directory = mkdtempSync(join(tmpdir(), "r1-extension-mcp-"));
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/mcp-extension-server.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: join(directory, "mcp.sqlite"),
        SPROUT_PI_ENABLED: "false",
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  try {
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(child.stdout).toContain("PASS 反证：跨 Project 的 mcp_session_open 与 catalog 被拒");
    expect(child.stdout).toContain("PASS 反证：旧代次 exchange 得 lease_stale_generation");
    expect(child.stdout).toContain(
      "PASS 反证：failed session 再 exchange 原样返回、不改投别的 session",
    );
    expect(child.stdout).toContain("PASS mcp_session_close 幂等");
    expect(child.stdout).toContain("DONE mcp server relay branches");
    // 夹具不得把 secret 或启动配置写进可见输出。
    expect(child.stdout).not.toContain("configured_service");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
