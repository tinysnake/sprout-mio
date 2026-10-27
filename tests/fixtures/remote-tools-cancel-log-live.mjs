import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remoteToolInputSchemas } from "../../src/contracts/remote.ts";

/**
 * 真实 Pi host runner + 真实 extension 注册流程，验证取消与日志两个新工具：
 * 工具面（session 的活动工具名 = tools/list）、参数边界拒绝、以及结果呈现不把
 * unknown / 不完整日志显示成成功或空。只写工具名、状态字与错误码，不写日志正文。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(join(tmpdir(), "p4c-tools-cancel-log-"));
const evidencePath =
  process.env.SPROUT_REMOTE_TOOLS_EVIDENCE ?? "/tmp/p4c-tools-cancel-log-evidence.json";
const projectId = "prj_00000000-0000-4000-8000-000000000000";
const machineId = "mch_00000000-0000-4000-8000-000000000000";
const requestId = "req_00000000-0000-4000-8000-000000000000";
const executionId = "exe_00000000-0000-4000-8000-000000000000";
const cancelId = "cnl_00000000-0000-4000-8000-000000000000";
const otherExecutionId = "exe_11111111-1111-4111-8111-111111111111";
const time = "2026-10-24T00:00:00.000Z";
const secret = randomBytes(32).toString("base64url");

const key = { projectId, machineId };
const cancelView = (state, overrides = {}) => ({
  ...key,
  cancelId,
  executionId,
  state,
  requestedAt: time,
  deliveredAt: state === "requested" ? null : time,
  exitedAt: state === "exited_observed" ? time : null,
  signalOutcome: state === "requested" ? "none" : "kill_delivered",
  failureReason: state === "failed" ? "signal_failed" : null,
  ...overrides,
});
const logView = (logState, overrides = {}) => ({
  ...key,
  executionId,
  frames:
    logState === "none"
      ? []
      : [
          {
            sequence: 1,
            stream: "stdout",
            byteStart: 0,
            byteEnd: 4,
            text: "ok\n",
            checksum: "a".repeat(64),
          },
        ],
  nextCursor: { executionId, nextSequence: logState === "none" ? 1 : 2 },
  availableFromSequence: logState === "gap" ? 5 : 1,
  acknowledgedThroughSequence: logState === "full" ? 1 : null,
  producedThroughSequence: logState === "none" ? null : logState === "gap" ? 9 : 1,
  gapRanges: logState === "gap" ? [{ fromSequence: 2, toSequence: 4 }] : [],
  logState,
  workerOnline: logState !== "truncated",
  ...overrides,
});

let calls = 0;
const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    calls += 1;
    const request = JSON.parse(body);
    const input = request.call.input;
    seen.push(request.call.type);
    const reply = (data) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, requestId, data }));
    };
    if (request.call.type === "execution_cancel") {
      // 按 policy 区分两种取消结果：delivered 不是已停，failed 是取消未成功。
      return input.policy === "kill"
        ? reply(cancelView("failed", { executionId: input.executionId }))
        : reply(cancelView("delivered", { executionId: input.executionId }));
    }
    if (request.call.type === "execution_log_read") {
      if (input.cursor === null)
        return reply(logView("truncated", { executionId: input.executionId }));
      if (input.cursor?.nextSequence === 9)
        return reply(logView("gap", { executionId: input.executionId }));
      if (input.cursor?.nextSequence === 42)
        return reply(logView("none", { executionId: input.executionId }));
      // 其余游标伪造一条别的执行，用来证明响应不能冒充本次请求。
      return reply(logView("full", { executionId: otherExecutionId }));
    }
    if (request.call.type === "lease_get") {
      return reply({
        lease: {
          ...key,
          generation: 0,
          state: "free",
          holderInstanceId: null,
          changedAt: time,
          pendingMutationId: null,
        },
        mutation: null,
      });
    }
    res.statusCode = 500;
    res.end("{}");
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

const probePath = join(directory, "probe.mjs");
const resultPath = join(directory, "probe.json");
const actualEntry = pathToFileURL(join(root, "pi/sprout-extension.ts")).href;
const expectedToolNames = Object.keys(remoteToolInputSchemas).sort();
writeFileSync(
  probePath,
  `
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import actualEntry from ${JSON.stringify(actualEntry)};
const expectedToolNames = ${JSON.stringify(expectedToolNames)};
export default function probe(pi) {
  actualEntry(pi);
  const registered = new Map();
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) => { registered.set(tool.name, tool); register(tool); };
  const required = (name) => {
    const schema = registered.get(name).parameters;
    assert.ok(schema.required.includes('machineId'), name + ' 必须显式指定 Machine');
    assert.equal(schema.additionalProperties, false, name + ' 不接受额外参数');
    return schema;
  };
  pi.on('session_start', async () => {
    const names = [...registered.keys()].sort();
    assert.deepEqual(names, expectedToolNames, '工具面必须与契约一致');
    const cancelSchema = required('sprout_remote_execution_cancel');
    const logSchema = required('sprout_remote_execution_log');
    assert.ok(cancelSchema.required.includes('executionId'));
    assert.ok(cancelSchema.required.includes('authorizationGeneration'));
    assert.ok(logSchema.required.includes('executionId'));
    const cancel = registered.get('sprout_remote_execution_cancel');
    const read = registered.get('sprout_remote_execution_log');
    const rejected = {};
    const expectRejected = async (label, tool, parameters) => {
      const result = await tool.execute(label, parameters);
      assert.equal(result.isError, true, label + ' 必须被拒');
      assert.equal(result.details.error.code, 'validation_failed', label + ' 的错误码');
      rejected[label] = result.details.error.code;
    };
    const base = {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},requestId:${JSON.stringify(requestId)},authorizationGeneration:1};
    await expectRejected('cancel_without_machine', cancel, {executionId:${JSON.stringify(executionId)},requestId:${JSON.stringify(requestId)},authorizationGeneration:1});
    await expectRejected('cancel_term_wait_too_long', cancel, {...base, termWaitMs:10001});
    await expectRejected('cancel_without_generation', cancel, {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},requestId:${JSON.stringify(requestId)}});
    await expectRejected('log_without_machine', read, {executionId:${JSON.stringify(executionId)},cursor:null});
    await expectRejected('log_limit_too_large', read, {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:null,limitBytes:65537});
    await expectRejected('log_limit_zero', read, {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:null,limitBytes:0});
    // 拒绝发生在构造请求之前：没有任何请求到达服务端。
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      toolNames: names, rejected, presentation: {}
    }, null, 2));
    const delivered = await cancel.execute('delivered', {...base, policy:'term_then_kill'});
    const failed = await cancel.execute('failed', {...base, policy:'kill'});
    const truncated = await read.execute('truncated', {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:null});
    const gap = await read.execute('gap', {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:{executionId:${JSON.stringify(executionId)},nextSequence:9}});
    const empty = await read.execute('empty', {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:{executionId:${JSON.stringify(executionId)},nextSequence:42}});
    const impostor = await read.execute('impostor', {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:{executionId:${JSON.stringify(executionId)},nextSequence:7}});
    const presentation = {
      // delivered 不等于已停：不算失败，但也不能显示为已停止。
      delivered: {isError: delivered.isError, stopped: delivered.details.stopped, state: delivered.details.outcome, message: delivered.details.message},
      failed: {isError: failed.isError, stopped: failed.details.stopped, state: failed.details.outcome},
      truncated: {isError: truncated.isError, incomplete: truncated.details.incomplete, logState: truncated.details.logState, frames: truncated.details.frames.length, message: truncated.details.message},
      gap: {isError: gap.isError, incomplete: gap.details.incomplete, logState: gap.details.logState, gapRanges: gap.details.gapRanges.length},
      empty: {isError: empty.isError, incomplete: empty.details.incomplete, logState: empty.details.logState, frames: empty.details.frames.length},
      impostor: {isError: impostor.isError, outcome: impostor.details.outcome, reason: impostor.details.reason},
    };
    assert.equal(presentation.delivered.isError, false);
    assert.equal(presentation.delivered.stopped, false, 'delivered 不得显示为已停');
    assert.equal(presentation.delivered.state, 'delivered');
    assert.match(presentation.delivered.message, /不表示进程已停/);
    assert.equal(presentation.failed.isError, true, '取消失败必须报错');
    assert.equal(presentation.failed.stopped, false);
    assert.equal(presentation.truncated.incomplete, true, 'truncated 必须显示为不完整');
    assert.equal(presentation.truncated.frames > 0, true);
    assert.match(presentation.truncated.message, /截断/);
    assert.equal(presentation.gap.incomplete, true);
    assert.equal(presentation.gap.gapRanges, 1);
    assert.equal(presentation.empty.incomplete, false);
    assert.equal(presentation.empty.logState, 'none');
    assert.equal(presentation.empty.frames, 0);
    assert.equal(presentation.impostor.outcome, 'unknown', '别的执行的日志不能被当作本次结果');
    assert.equal(presentation.impostor.reason, 'invalid_response');
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      toolNames: names, rejected, presentation
    }, null, 2));
  });
}
`,
);

let runner;
let evidence;
try {
  runner = spawn(process.execPath, ["--import", "tsx", join(root, "scripts/pi-host-runner.mjs")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_TELEMETRY: "0",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    },
  });
  let buffer = "";
  let ready;
  const opened = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("runner ready timed out")), 60000);
    runner.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (event.type === "ready") {
          ready = event.snapshot;
          clearTimeout(timer);
          done();
        } else if (event.type === "failure") {
          clearTimeout(timer);
          reject(new Error(`runner ${event.code}: ${event.message}`));
        }
      }
    });
    runner.stderr.on("data", () => {});
    runner.on("error", () => {
      clearTimeout(timer);
      reject(new Error("runner failed to spawn"));
    });
    runner.on("exit", () => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error("runner exited before ready"));
      }
    });
  });
  const runId = "run_00000000-0000-4000-8000-000000000000";
  runner.stdin.write(
    `${JSON.stringify({
      type: "open",
      id: runId,
      instanceId: "ins_00000000-0000-4000-8000-000000000000",
      sessionId: randomUUID(),
      sessionDirectory: join(directory, "sessions"),
      cwd: join(directory, "workspace"),
      agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      extensionPath: probePath,
      profile: {
        id: "cfg_00000000-0000-4000-8000-000000000000",
        name: "Cancellation and log tools verification",
        persona: "Verification only.",
        harness: "pi",
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
      remote: {
        endpoint: `http://127.0.0.1:${port}/api/remote/agent`,
        secret,
        projectId,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    })}\n`,
  );
  await opened;
  const probe = JSON.parse(readFileSync(resultPath, "utf8"));
  // 真实 Pi 的活动工具名就是模型看到的 tools/list。
  assert.ok(ready.tools.includes("sprout_remote_execution_cancel"), "tools/list 缺少取消工具");
  assert.ok(ready.tools.includes("sprout_remote_execution_log"), "tools/list 缺少日志工具");
  assert.ok(probe.toolNames.every((name) => ready.tools.includes(name)));
  // 6 次参数拒绝不应产生任何 HTTP 调用；到达服务端的是 2 次取消 + 4 次日志读取。
  assert.equal(calls, 6, "只有 2 次取消 + 4 次日志读取到达服务端，6 次参数拒绝未发请求");
  assert.deepEqual(
    seen.sort((a, b) => a.localeCompare(b)),
    [
      "execution_cancel",
      "execution_cancel",
      "execution_log_read",
      "execution_log_read",
      "execution_log_read",
      "execution_log_read",
    ],
  );
  assert.equal(JSON.stringify(ready).includes(secret), false, "grant 不出现在快照里");
  evidence = {
    toolsList: ready.tools,
    newToolsInToolsList: {
      cancel: ready.tools.includes("sprout_remote_execution_cancel"),
      log: ready.tools.includes("sprout_remote_execution_log"),
    },
    rejectedParameters: probe.rejected,
    presentation: probe.presentation,
    serverCalls: calls,
    requestTypes: seen,
    sdkVersion: ready.sdkVersion,
    scope:
      "真实 Pi host runner 与真实 extension 注册流程、真实 HTTP transport 到受控回环端点。服务端取消/日志业务实现（p4c-execution）与 macOS Worker 真实进程未在本单元参与。",
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `PASS tools/list: cancel=${evidence.newToolsInToolsList.cancel} log=${evidence.newToolsInToolsList.log} (${ready.tools.length} tools)`,
  );
  console.log(
    `PASS 参数边界: ${Object.keys(probe.rejected).join(", ")} 全部 validation_failed，0 次 HTTP 调用`,
  );
  console.log(
    `PASS 呈现: delivered 不算已停；failed 报错；truncated / gap 显示为不完整；none 才是空；跨执行响应判为 unknown`,
  );
} finally {
  if (runner && runner.exitCode === null) {
    runner.stdin.end(
      `${JSON.stringify({ type: "close", id: "run_00000000-0000-4000-8000-000000000000" })}\n`,
    );
    const timer = setTimeout(() => runner.kill("SIGKILL"), 5000);
    await once(runner, "exit");
    clearTimeout(timer);
  }
  server.closeAllConnections();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
