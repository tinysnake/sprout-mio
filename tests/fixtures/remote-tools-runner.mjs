import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(join(tmpdir(), "p4b-tools-runner-"));
const evidencePath =
  process.env.SPROUT_REMOTE_TOOLS_EVIDENCE ?? "/tmp/p4b-tools-runner-evidence.json";
const projectId = "prj_00000000-0000-4000-8000-000000000000";
const machineId = "mch_00000000-0000-4000-8000-000000000000";
const requestId = "req_00000000-0000-4000-8000-000000000000";
const executionId = "exe_00000000-0000-4000-8000-000000000000";
const secret = randomBytes(32).toString("base64url");
let validCalls = 0;
let identityInjected = false;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const request = JSON.parse(body);
    validCalls += 1;
    identityInjected =
      req.url === "/api/remote/agent" &&
      req.method === "POST" &&
      req.headers.authorization === `Bearer ${secret}` &&
      !req.headers.origin &&
      !req.headers.cookie &&
      request.call.input.projectId === projectId &&
      request.call.input.machineId === machineId &&
      !Object.hasOwn(request.call.input, "instanceId") &&
      !Object.hasOwn(request.call.input, "runId");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        requestId,
        data: {
          lease: {
            projectId,
            machineId,
            generation: 0,
            state: "free",
            holderInstanceId: null,
            changedAt: "2026-10-24T00:00:00.000Z",
            pendingMutationId: null,
          },
          mutation: null,
        },
      }),
    );
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const probePath = join(directory, "probe.mjs");
const resultPath = join(directory, "probe.json");
const actualEntry = pathToFileURL(join(root, "pi/sprout-extension.ts")).href;
// 期望工具名从契约推导（由 tsx 加载 TypeScript 契约），probe 只拿到名词表，不写死数量。
const { remoteToolInputSchemas } = await import(
  pathToFileURL(join(root, "src/contracts/remote.ts")).href
);
const { taskToolInputSchemas } = await import(
  pathToFileURL(join(root, "src/contracts/task.ts")).href
);
const expectedToolNames = [
  ...Object.keys(remoteToolInputSchemas),
  ...Object.keys(taskToolInputSchemas),
].sort();
const machineScopedToolNames = Object.keys(remoteToolInputSchemas).sort();
writeFileSync(
  probePath,
  `
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import actualEntry from ${JSON.stringify(actualEntry)};
const expectedToolNames = ${JSON.stringify(expectedToolNames)};
const machineScopedToolNames = ${JSON.stringify(machineScopedToolNames)};
export default function probe(pi) {
  actualEntry(pi);
  const registered = new Map();
  const register = pi.registerTool.bind(pi);
  pi.registerTool = (tool) => { registered.set(tool.name, tool); register(tool); };
  pi.on('session_start', async () => {
    const tools = [...registered.values()];
    // 工具面数量从契约推导，不写死常量：新增工具不会再让这里变成过期断言。
    assert.deepEqual(tools.map(tool=>tool.name).sort(), expectedToolNames);
    assert.ok(expectedToolNames.includes('sprout_remote_execution_cancel'));
    assert.ok(expectedToolNames.includes('sprout_remote_execution_log'));
    // Machine 作用域只属于 remote 工具；Task/Chat 工具从 run 的授权里取 Project 与 Chat。
    for (const tool of tools) {
      assert.equal(tool.parameters.additionalProperties, false);
      assert.equal(
        (tool.parameters.required ?? []).includes('machineId'),
        machineScopedToolNames.includes(tool.name),
        tool.name,
      );
    }
    for (const name of ['sprout_remote_execution_cancel', 'sprout_remote_execution_log']) {
      const schema = registered.get(name).parameters;
      assert.ok(schema.required.includes('machineId'), name + ' must require an explicit Machine');
      assert.equal(schema.additionalProperties, false);
      const missing = await registered.get(name).execute('missing', {executionId:${JSON.stringify(executionId)}});
      assert.equal(missing.isError, true);
      assert.equal(missing.details.error.code, 'validation_failed');
    }
    const shell = registered.get('sprout_remote_shell');
    const missing = await shell.execute('missing', {requestId:${JSON.stringify(requestId)},authorizationGeneration:1,command:'true'});
    assert.equal(missing.isError, true);
    assert.equal(missing.details.error.code, 'validation_failed');
    const get = registered.get('sprout_lease_get');
    for (const forged of [{projectId:'prj_11111111-1111-4111-8111-111111111111'}, {instanceId:'ins_11111111-1111-4111-8111-111111111111'}, {runId:'run_11111111-1111-4111-8111-111111111111'}]) {
      const denied = await get.execute('forged', {machineId:${JSON.stringify(machineId)},...forged});
      assert.equal(denied.isError, true);
      assert.equal(denied.details.error.code, 'validation_failed');
    }
    const valid = await get.execute('valid', {machineId:${JSON.stringify(machineId)}});
    assert.equal(valid.isError, false);
    assert.equal(valid.details.data.lease.projectId, ${JSON.stringify(projectId)});
    const cancel = registered.get('sprout_remote_execution_cancel');
    const cancelled = await cancel.execute('cancel', {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},requestId:${JSON.stringify(requestId)},authorizationGeneration:1,policy:'kill',termWaitMs:10001});
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.details.error.code, 'validation_failed');
    const log = registered.get('sprout_remote_execution_log');
    const oversized = await log.execute('log', {machineId:${JSON.stringify(machineId)},executionId:${JSON.stringify(executionId)},cursor:null,limitBytes:65537});
    assert.equal(oversized.isError, true);
    assert.equal(oversized.details.error.code, 'validation_failed');
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      toolNames: tools.map(tool=>tool.name).sort(),
      schemas: Object.fromEntries(tools.map(tool=>[tool.name,tool.parameters])),
      missingMachineRejected:true, forgedIdentityRejected:true, validCallSucceeded:true,
      termWaitRejected:true, limitBytesRejected:true
    }));
  });
}
`,
);
let runner;
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
  // Consume private runner streams without echoing any protocol or session content.
  let buffer = "";
  let ready;
  const opened = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("runner ready timed out")), 45000);
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
        }
        if (event.type === "failure") {
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
        name: "Remote tools verification",
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
  assert.equal(validCalls, 1);
  assert.equal(identityInjected, true);
  assert.ok(!JSON.stringify(ready).includes(secret));
  assert.ok(!Object.hasOwn(ready, "remote"));
  assert.ok(probe.toolNames.every((name) => ready.tools.includes(name)));
  const evidence = {
    ...probe,
    sdkVersion: ready.sdkVersion,
    identityInjected: true,
    httpCalls: validCalls,
    grantAbsentFromSnapshot: true,
    directLoopbackDespiteProxy: true,
    scope:
      "Real pi-host-runner and installed SDK; controlled real HTTP transport endpoint. Production grant authorization, SQLite, macOS Worker execution and Chromium are integration checks, not exercised by this transport probe.",
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `PASS real runner: ${probe.toolNames.length} tools (registry-derived); N12 missing Machine rejected; forged identity rejected; termWaitMs/limitBytes rejected; 1 HTTP call with injected Project; safe evidence ${evidencePath}`,
  );
} finally {
  if (runner && runner.exitCode === null) {
    runner.stdin.end(
      `${JSON.stringify({ type: "close", id: "run_00000000-0000-4000-8000-000000000000" })}\n`,
    );
    const timer = setTimeout(() => runner.kill("SIGKILL"), 3000);
    await once(runner, "exit");
    clearTimeout(timer);
  }
  server.closeAllConnections();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
