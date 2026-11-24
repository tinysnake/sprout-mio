import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  classifyKind,
  detectPort,
  formatElapsed,
  isForeignHost,
  isProjectRuntime,
  liveRunOwners,
  parseElapsed,
  parseProcessTable,
  protectedProcesses,
  selectStrays,
  verifyRunState,
} from "../scripts/maintenance/stray-processes.mjs";

const repository = "/Users/snake/workspace/sprout-mio";
const worktree = "/Users/snake/.t3/worktrees/sprout-mio/t3-abc";
const roots = [repository, worktree];
const scriptPath = fileURLToPath(
  new URL("../scripts/maintenance/stray-processes.mjs", import.meta.url),
);

type Row = {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  state: string;
  elapsed: number | null;
  command: string;
};

let lastPid = 900_000;
function row(command: string, overrides: Partial<Row> = {}): Row {
  lastPid += 1;
  return {
    pid: lastPid,
    ppid: 1,
    pgid: lastPid,
    uid: 501,
    state: "S",
    elapsed: 90,
    command,
    ...overrides,
  };
}

test("etime 覆盖秒、时、天三种形状，认不出的形状返回 null", () => {
  assert.equal(parseElapsed("00:13"), 13);
  assert.equal(parseElapsed("31:07"), 1_867);
  assert.equal(parseElapsed("01:13:38"), 4_418);
  assert.equal(parseElapsed("16-21:45:00"), 1_460_700);
  assert.equal(parseElapsed("12-09:29:16"), 1_070_956);
  assert.equal(parseElapsed("garbage"), null);
  assert.equal(parseElapsed("12"), null);
});

test("进程表按 ps 的列解析，命令行里的空格不被拆开", () => {
  const table = parseProcessTable(
    [
      "  4672     1  4672   501 S    12-09:29:16 node /w/node_modules/vite/bin/vite.js --host 0.0.0.0",
      "  PID  PPID",
      "",
    ].join("\n"),
  );
  assert.equal(table.length, 1);
  assert.deepEqual(table[0], {
    pid: 4672,
    ppid: 1,
    pgid: 4672,
    uid: 501,
    state: "S",
    elapsed: 1_070_956,
    command: "node /w/node_modules/vite/bin/vite.js --host 0.0.0.0",
  });
});

test("启动它的运行已经退出的 dev server 被判定为残留", () => {
  const command = `node ${worktree}/node_modules/vite/bin/vite.js --host 0.0.0.0 --port 3000`;
  const result = selectStrays({ rows: [row(command)], roots });
  assert.equal(result.strays.length, 1);
  assert.equal(result.strays[0]?.kind, "dev-server");
  assert.equal(result.strays[0]?.port, 3000);
  assert.equal(result.strays[0]?.elapsedSeconds, 90);
});

test("父进程还活着的进程不算残留", () => {
  const command = `node ${worktree}/node_modules/vite/bin/vite.js --port 3000`;
  const result = selectStrays({ rows: [row(command, { ppid: 4321 })], roots });
  assert.equal(result.related.length, 0);
  assert.equal(result.strays.length, 0);
});

test("部署实例（sprout-bin 下的 prod/drill）与本仓库无关，不算残留", () => {
  const app = row("node /Users/snake/workspace/sprout-bin/prod/app/.output/server/index.mjs");
  const worker = row(
    "/opt/homebrew/bin/node /Users/snake/workspace/sprout-bin/prod/worker/app/dist/worker/main.js run --state-dir /x",
  );
  const result = selectStrays({ rows: [app, worker], roots });
  assert.equal(result.related.length, 0);
  assert.equal(result.strays.length, 0);
});

test("环境里带 SPROUT_RUNTIME_ROOT 的实例不归本检查管", () => {
  const entry = row(`node ${worktree}/.output/server/index.mjs`);
  const facts = new Map([
    [entry.pid, { environment: "SPROUT_RUNTIME_ROOT=/Users/snake/workspace/sprout-bin" }],
  ]);
  const result = selectStrays({ rows: [entry], roots, facts });
  assert.equal(result.related.length, 0);
  assert.equal(result.strays.length, 0);
});

test("仍在运行的 verify 运行里的进程只是相关，不是残留", () => {
  const runDirectory = `${worktree}/.verify/runs/run-1`;
  const entry = row(`node ${worktree}/scripts/verify/runner.mjs`);
  const facts = new Map([[entry.pid, { environment: `SPROUT_VERIFY_RUN_DIR=${runDirectory}` }]]);
  const runs = new Map([[entry.pid, { state: "live", directory: runDirectory, root: worktree }]]);
  const result = selectStrays({ rows: [entry], roots, facts, runs });
  assert.equal(result.related.length, 1);
  assert.equal(result.strays.length, 0);
});

test("已经结束的 verify 运行留下的 harness 进程算残留，即使命令行里没有仓库路径", () => {
  const runDirectory = "/private/var/folders/zz/verify-runner-WmxzGr/.verify/runs/run-1";
  const entry = row("node launcher.mjs u");
  const facts = new Map([
    [entry.pid, { environment: `SPROUT_VERIFY_RUN_DIR=${runDirectory} INIT_CWD=${worktree}` }],
  ]);
  const runs = new Map([[entry.pid, { state: "stale", directory: runDirectory, root: worktree }]]);
  const result = selectStrays({ rows: [entry], roots, facts, runs });
  assert.equal(result.related.length, 1);
  assert.equal(result.strays.length, 1);
  assert.equal(result.strays[0]?.runState, "stale");
});

test("并发 verify 沙箱私有树里的进程不会被误判", () => {
  const entry = row(`node ${worktree}/scripts/verify/runner.mjs`);
  const facts = new Map([
    [
      entry.pid,
      { environment: `SPROUT_VERIFY_SANDBOX_ID=abc PWD=${worktree}/.verify/sandboxes/a-base-123` },
    ],
  ]);
  const result = selectStrays({ rows: [entry], roots, facts });
  assert.equal(result.related.length, 1);
  assert.equal(result.strays.length, 0);
});

test("agent 与 MCP 宿主进程一律不碰", () => {
  const command =
    "/opt/homebrew/bin/node /Users/snake/workspace/vestigio/packages/daemon/dist/daemon.js serve";
  const entry = row(command);
  const facts = new Map([[entry.pid, { environment: `PWD=${repository}` }]]);
  const result = selectStrays({ rows: [entry], roots, facts });
  assert.equal(result.related.length, 0);
  assert.equal(result.strays.length, 0);
  assert.equal(isForeignHost(command), true);
  assert.equal(isForeignHost(`node ${worktree}/node_modules/vite/bin/vite.js`), false);
});

test("--min-age 以内的残留只算相关，不算失败", () => {
  const command = `node ${worktree}/node_modules/vite/bin/vite.js --port 3000`;
  const result = selectStrays({
    rows: [row(command, { elapsed: 5 })],
    roots,
    minimumAgeSeconds: 60,
  });
  assert.equal(result.strays.length, 1);
  assert.equal(result.failing.length, 0);
});

test("默认只把存活超过一小时的残留判为失败", () => {
  const command = `node ${worktree}/node_modules/vite/bin/vite.js --port 3000`;
  assert.equal(selectStrays({ rows: [row(command, { elapsed: 59 })], roots }).failing.length, 0);
  assert.equal(selectStrays({ rows: [row(command, { elapsed: 3_600 })], roots }).failing.length, 1);
});

test("活着的 verify 运行属主不判残留（nohup 起的 runner 自己 ppid 也是 1）", () => {
  const runner = row(`node ${worktree}/scripts/verify/runner.mjs --only b-tooling`);
  const result = selectStrays({ rows: [runner], roots, protectedPids: new Set([runner.pid]) });
  assert.equal(result.related.length, 0);
  assert.equal(result.strays.length, 0);
});

test("沿 ppid 向上把属于活着的 verify 运行的包装 shell 一起保护", () => {
  const wrapper = row(`bash -c cd ${worktree} && bash scripts/verify.sh --only b-tooling`);
  const runner = row(`node ${worktree}/scripts/verify/runner.mjs --only b-tooling`, {
    ppid: wrapper.pid,
  });
  const ascending = (left: number, right: number) => left - right;
  assert.deepEqual(
    [...protectedProcesses([wrapper, runner], new Set([runner.pid]))].sort(ascending),
    [wrapper.pid, runner.pid],
  );
  assert.equal(protectedProcesses([wrapper, runner], new Set()).size, 0);
});

test("liveRunOwners 只认 context.json 里还活着的 ownerPid", () => {
  const owners = liveRunOwners([worktree], {
    list: () => [`${worktree}/.verify/runs/one`, `${worktree}/.verify/runs/two`],
    readContext: (directory) => ({
      ownerPid: directory.endsWith("one") ? 11 : 12,
      root: worktree,
    }),
    isAlive: (pid) => pid === 11,
  });
  assert.deepEqual([...owners], [11]);
});

test("存活时间读不出来的进程按失败处理", () => {
  const command = `node ${worktree}/node_modules/vite/bin/vite.js --port 3000`;
  const result = selectStrays({
    rows: [row(command, { elapsed: null })],
    roots,
    minimumAgeSeconds: 60,
  });
  assert.equal(result.failing.length, 1);
});

test("verify 运行状态按 context.json 的 ownerPid 判活", () => {
  const environment = "SPROUT_VERIFY_RUN_DIR=/run/one OTHER=1";
  const context = () => ({ ownerPid: 4242, root: repository });
  assert.deepEqual(verifyRunState(environment, { readContext: context, isAlive: () => true }), {
    state: "live",
    directory: "/run/one",
    root: repository,
  });
  assert.equal(
    verifyRunState(environment, { readContext: context, isAlive: () => false }).state,
    "stale",
  );
  assert.equal(verifyRunState(environment, { readContext: () => null }).state, "stale");
  assert.deepEqual(verifyRunState("OTHER=1"), { state: "none", directory: null, root: null });
});

test("分类与展示用的字段", () => {
  assert.equal(isProjectRuntime(`node ${worktree}/node_modules/vite/bin/vite.js`), true);
  assert.equal(isProjectRuntime("node /x/scripts/hooks/other.mjs"), false);
  assert.equal(classifyKind("node /x/node_modules/vite/bin/vite.js"), "dev-server");
  assert.equal(classifyKind("node /x/.output/server/index.mjs"), "app-server");
  assert.equal(classifyKind("node /x/scripts/human-review/cli.mjs"), "harness");
  assert.equal(detectPort("node /x/node_modules/vite/bin/vite.js --port 3121"), 3121);
  assert.equal(detectPort("node /x/node_modules/vite/bin/vite.js"), null);
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(13), "13s");
  assert.equal(formatElapsed(3_600 * 5), "5h");
  assert.equal(formatElapsed(86_400 * 9 + 60), "9d");
  assert.equal(formatElapsed(null), "未知");
});

test("CLI 在真实宿主上跑得完，--json 输出的形状稳定", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ok(
    result.status === 0 || result.status === 1,
    `意外退出码 ${result.status}: ${result.stderr}`,
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.counts.orphans, "number");
  assert.equal(typeof payload.counts.tolerated, "number");
  assert.ok(payload.roots.length > 0);
  assert.ok(Array.isArray(payload.orphans));
});

test("SPROUT_STRAY_SKIP=1 时跳过检查", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, SPROUT_STRAY_SKIP: "1" },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^SKIP stray-processes/);
});
