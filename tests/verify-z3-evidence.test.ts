import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

// 门禁的判定逻辑长在 z3-mcp-acceptance.sh 的 RUNNER 里，没有可 import 的边界。这里从脚本
// 原文抽出那几段（不是抄一份），在桩环境里执行，钉住「缺调用记录」时的分类与可读消息。
const script = readFileSync("scripts/verify/z3-mcp-acceptance.sh", "utf8");

function slice(from: string, to: string) {
  const start = script.indexOf(from);
  if (start < 0) throw new Error(`找不到起点：${from}`);
  const end = script.indexOf(to, start);
  if (end < 0) throw new Error(`找不到终点：${to}`);
  return script.slice(start, end);
}

const callLogBlock = slice(
  "// 两份调用记录是 C 探针的产物",
  "// 由调用记录重算的三个值不跟随 observationState",
);
const callLogPaths = script.match(/const CALL_LOG_PATHS=new Set\(\[[^\]]*\]\);/)?.[0];
const resolvePathBlock = slice("const resolvePath = path =>", "let currentClause = 0;");
const evidenceAtBlock = slice("const evidenceAt = (field,path) => {", "const snapshot=JSON.parse");
if (!callLogPaths) throw new Error("找不到 CALL_LOG_PATHS");

class EvidenceUnavailable extends Error {}
class ObservationContract extends Error {}
class ClauseContract extends Error {}

interface Harness {
  callLogState: { status: "computed" | "unavailable" | "failed"; error: string | null };
  observed: Record<string, boolean>;
  projections: { field: string; path: string; value: unknown }[];
  evidenceAt(field: string, path: string): unknown;
}

interface Scenario {
  artifacts?: Record<string, string>;
  probeEvidence?: Record<string, { status: string; errorType?: string; failureSite?: string }>;
  execution?: { exitCode: number | null; signal: string | null; timedOut: boolean };
  missingExecution?: boolean;
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function harness(scenario: Scenario = {}) {
  const directory = mkdtempSync(join(tmpdir(), "z3-evidence-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(scenario.artifacts ?? {}))
    writeFileSync(join(directory, name), content);
  const state = {
    existsSync,
    readFileSync,
    join,
    projections: [] as Harness["projections"],
    dir: directory,
    executions: scenario.missingExecution
      ? {}
      : { c: scenario.execution ?? { exitCode: 0, signal: null, timedOut: false } },
    sources: { c: scenario.probeEvidence ?? {} },
    EvidenceUnavailable,
    ObservationContract,
    ClauseContract,
    observationState: { status: "computed", error: null },
    sdkState: { status: "computed", error: null },
    toolsMatch: true,
    configuredServiceExited: true,
  };
  const modulePath = join(directory, "harness.mjs");
  writeFileSync(
    modulePath,
    `export function evaluate(state) {\nconst {existsSync,readFileSync,join,dir,executions,sources,EvidenceUnavailable,ObservationContract,ClauseContract,observationState,sdkState,projections,toolsMatch,configuredServiceExited}=state;\n${callLogBlock}${callLogPaths}\n${resolvePathBlock}sources.observed=observed;\nlet currentClause = 3;\n${evidenceAtBlock}return {callLogState,observed,evidenceAt,projections};\n}\n`,
  );
  const module = (await import(pathToFileURL(modulePath).href)) as {
    evaluate(state: unknown): Harness;
  };
  const evaluated = module.evaluate(state);
  return { ...evaluated, projections: state.projections, directory };
}

describe("z3 gate call-log evidence", () => {
  it("按调用记录算出跨根与超时三项，并在 answers 里登记投影", async () => {
    const gate = await harness({
      artifacts: {
        "calls-root-a.log": '{"tool":"read","outcome":"rejected"}\n',
        "calls-root-b.log":
          '{"tool":"write","outcome":"rejected"}\n{"tool":"never_reply","outcome":"no_reply"}\n',
      },
      probeEvidence: { isolation: { status: "PASS" }, disappearance: { status: "PASS" } },
    });
    expect(gate.callLogState).toEqual({ status: "computed", error: null });
    expect(gate.observed.crossRootReadRejected).toBe(true);
    expect(gate.observed.crossRootWriteRejected).toBe(true);
    expect(gate.observed.timeoutRequestReachedServer).toBe(true);
    expect(gate.evidenceAt("crossRootReadRejected", "observed.crossRootReadRejected")).toBe(true);
    expect(gate.projections).toEqual([
      {
        clause: 3,
        field: "crossRootReadRejected",
        path: "observed.crossRootReadRejected",
        value: true,
      },
    ]);
  });

  it("探针失败且调用记录缺失时报无法判定，消息带上探针的失败原因而不是 ENOENT", async () => {
    const gate = await harness({
      probeEvidence: {
        setup: { status: "FAIL", errorType: "Error", failureSite: "    at open (c-live.mts:12:3)" },
      },
      execution: { exitCode: 1, signal: null, timedOut: false },
    });
    expect(gate.callLogState.status).toBe("unavailable");
    expect(gate.callLogState.error).toBe(
      "calls-root-a.log 缺失：C 探针失败于 setup Error at open (c-live.mts:12:3)",
    );
    expect(() =>
      gate.evidenceAt("crossRootReadRejected", "observed.crossRootReadRejected"),
    ).toThrow(EvidenceUnavailable);
    expect(() =>
      gate.evidenceAt("crossRootReadRejected", "observed.crossRootReadRejected"),
    ).toThrow(/C 探针失败于 setup Error/);
  });

  it("探针自称成功却没有留下调用记录时报失败（自相矛盾）", async () => {
    const gate = await harness({
      probeEvidence: { isolation: { status: "PASS" } },
      execution: { exitCode: 0, signal: null, timedOut: false },
    });
    expect(gate.callLogState).toEqual({
      status: "failed",
      error: "calls-root-a.log 缺失：C 探针以退出码 0 结束，但探针没有报告任何失败",
    });
    expect(() =>
      gate.evidenceAt("timeoutRequestReachedServer", "observed.timeoutRequestReachedServer"),
    ).toThrow(ObservationContract);
  });

  it("探针超时与没有运行记录都记成无法判定并说明原因", async () => {
    const timedOut = await harness({
      execution: { exitCode: null, signal: "SIGKILL", timedOut: true },
    });
    expect(timedOut.callLogState).toEqual({
      status: "unavailable",
      error: "calls-root-a.log 缺失：C 探针没有在时限内结束",
    });
    const neverRan = await harness({ missingExecution: true });
    expect(neverRan.callLogState).toEqual({
      status: "unavailable",
      error: "calls-root-a.log 缺失：C 探针以退出码 未知 结束",
    });
  });

  it("调用记录存在但为空时算成 false，交给断言报失败而不是报缺证据", async () => {
    const gate = await harness({
      artifacts: { "calls-root-a.log": "", "calls-root-b.log": "" },
      probeEvidence: { isolation: { status: "PASS" } },
    });
    expect(gate.callLogState.status).toBe("computed");
    expect(gate.observed.crossRootReadRejected).toBe(false);
    expect(gate.evidenceAt("crossRootReadRejected", "observed.crossRootReadRejected")).toBe(false);
  });

  it("调用记录缺失不影响其它门禁自算的观察值", async () => {
    const gate = await harness({
      probeEvidence: { setup: { status: "FAIL", errorType: "Error" } },
      execution: { exitCode: 1, signal: null, timedOut: false },
    });
    expect(gate.callLogState.status).toBe("unavailable");
    expect(gate.evidenceAt("configuredServiceExited", "observed.configuredServiceExited")).toBe(
      true,
    );
  });
});
