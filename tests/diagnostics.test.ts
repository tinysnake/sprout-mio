import { beforeAll, describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiagnosticEvent } from "../src/contracts/diagnostics";

type Evidence = {
  written: boolean;
  rows: DiagnosticEvent[];
  latest: DiagnosticEvent[];
  other: DiagnosticEvent[];
  failed: boolean;
  requestIds: string[];
  spoofed: string;
};
let evidence: Evidence;
beforeAll(() => {
  mkdirSync(".verify", { recursive: true });
  const directory = mkdtempSync(resolve(".verify/diagnostics-test-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      const { migrateDatabase } = await import("./src/db/migrate.ts");
      migrateDatabase();
      const { recordDiagnostic, queryDiagnostics } = await import("./src/server/diagnostics.ts");
      const written = recordDiagnostic({ level: "info", event: "test.event", requestId: "req_first", message: "可查询的诊断", data: { answer: 42 } });
      recordDiagnostic({ level: "info", event: "test.other", requestId: "req_second", message: "另一个请求" });
      const rows = queryDiagnostics({ requestId: "req_first", limit: 1 });
      const latest = queryDiagnostics({ limit: 1 });
      const other = queryDiagnostics({ projectId: "prj_missing" });
      const failed = recordDiagnostic({ level: "error", event: "test.foreign-key", requestId: "req_invalid", projectId: "prj_missing", message: "诊断失败不能中断请求" });
      const { initializeRequestContext, getRequestContext } = await import("./src/server/request-context.ts");
      const first = new Request("http://localhost/api/health", { headers: { "x-sprout-request-id": "req_spoofed" } });
      const second = new Request("http://localhost/api/health");
      initializeRequestContext(first);
      initializeRequestContext(second);
      console.log("EVIDENCE " + JSON.stringify({ written, rows, latest, other, failed, requestIds: [getRequestContext(first).requestId, getRequestContext(second).requestId], spoofed: first.headers.get("x-sprout-request-id") }));
      const { sqlite } = await import("./src/db/index.ts");
      sqlite.close();
    `,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: join(directory, "diagnostics.sqlite"),
          NODE_ENV: "test",
        },
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    evidence = JSON.parse(
      output
        .split("\n")
        .find((line) => line.startsWith("EVIDENCE "))!
        .slice(9),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 35000);

describe("诊断记录与请求关联", () => {
  it("诊断写入真实 SQLite 后按 requestId 查回 ISO 时间和结构化数据", () => {
    expect(evidence.written).toBe(true);
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({
      event: "test.event",
      requestId: "req_first",
      message: "可查询的诊断",
      data: { answer: 42 },
    });
    expect(evidence.rows[0].id).toMatch(/^diag_/);
    expect(new Date(evidence.rows[0].at).toISOString()).toBe(evidence.rows[0].at);
    expect(evidence.other).toEqual([]);
    expect(evidence.latest[0].event).toBe("test.other");
  });

  it("诊断外键写入失败只返回 false，不抛出业务异常", () => {
    expect(evidence.failed).toBe(false);
    expect(evidence.rows).toHaveLength(1);
  });

  it("请求边界生成不同 requestId，并覆盖客户端伪造值", () => {
    expect(new Set(evidence.requestIds).size).toBe(2);
    for (const id of evidence.requestIds) expect(id).toMatch(/^req_/);
    expect(evidence.spoofed).toBe(evidence.requestIds[0]);
    expect(evidence.spoofed).not.toBe("req_spoofed");
  });
});
