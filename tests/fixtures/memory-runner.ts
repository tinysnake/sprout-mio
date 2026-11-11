import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { MEMORY_TOOL_NAMES, type MemoryRuntime } from "../../src/contracts/memory";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const directory = mkdtempSync(join(tmpdir(), "memory-runner-"));
const cases = [
  "disabled",
  "unavailable",
  "ready",
  "import-throws",
  "factory-throws",
  "session-start-throws",
  "partial-tools",
  "assistant",
  "legacy",
];
try {
  for (const mode of cases) {
    const caseDir = join(directory, mode);
    mkdirSync(caseDir);
    const fixture = await startModelFixture({ privateDir: caseDir });
    let runner: ChildProcessWithoutNullStreams | undefined;
    try {
      const imported = join(caseDir, "imported");
      const hookRan = join(caseDir, "hook-ran");
      const probePath = join(caseDir, "probe.json");
      const exitPath = join(caseDir, "exit.json");
      const preload = join(caseDir, "preload.mjs");
      writeFileSync(
        preload,
        `
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
const env = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HINDSIGHT_')));
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  try {
    if (JSON.parse(String(chunk)).type === 'ready') {
      const config = process.env.HINDSIGHT_CONFIG;
      writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ env: env(), config: config ? JSON.parse(readFileSync(config,'utf8')) : null, fileMode: config ? statSync(config).mode & 0o777 : null, dirMode: config ? statSync(dirname(config)).mode & 0o777 : null }));
    }
  } catch {}
  return original(chunk, ...args);
};
process.on('exit', () => writeFileSync(${JSON.stringify(exitPath)}, JSON.stringify(env())));
`,
      );
      const bundlePath = join(caseDir, "bundle.mjs");
      writeFileSync(
        bundlePath,
        `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(imported)}, JSON.stringify({ config: JSON.parse(process.env.HINDSIGHT_CONFIG ? (await import('node:fs')).readFileSync(process.env.HINDSIGHT_CONFIG,'utf8') : '{}'), token: process.env.HINDSIGHT_API_TOKEN }));
${mode === "import-throws" ? "throw new Error('fixture import failure');" : ""}
export default function(pi) {
  ${mode === "session-start-throws" ? "pi.on('session_start', () => { throw new Error('fixture session start failure'); });" : ""}
  pi.on('before_agent_start', (event) => {
    writeFileSync(${JSON.stringify(hookRan)}, 'ran');
    return { systemPrompt: event.systemPrompt + '\\nMEMORY_FIXTURE_PROMPT' };
  });
  for (const name of ${JSON.stringify(mode === "partial-tools" ? MEMORY_TOOL_NAMES.slice(0, 7) : MEMORY_TOOL_NAMES)}) {
    pi.registerTool({ name, label: name, description: name, parameters: { type: 'object', properties: {} }, async execute() { return { content: [{type: 'text', text: 'fixture'}] }; } });
  }
  ${mode === "factory-throws" ? "throw new Error('fixture factory failure');" : ""}
}
`,
      );
      const skillPaths = ["ordinary", "hindsight-coding-agent"].map((name) => {
        const path = join(caseDir, "skills", name, "SKILL.md");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\nFixture skill.\n`,
        );
        return path;
      });
      let memory: MemoryRuntime = {
        state: "ready",
        apiUrl: "http://127.0.0.1:1",
        bank: "sprout::fixture",
        apiToken: "fixture-token",
        bundlePath,
      };
      if (mode === "disabled") memory = { state: "disabled" };
      if (mode === "unavailable") memory = { state: "unavailable", reason: "not_installed" };
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("HINDSIGHT_")),
      );
      runner = spawn(
        process.execPath,
        ["--import", "tsx", "--import", preload, join(root, "scripts/pi-host-runner.mjs")],
        {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...env,
            PI_TELEMETRY: "0",
            HINDSIGHT_CONFIG: "/host/secret-config",
            HINDSIGHT_API_TOKEN: "host-token",
            HINDSIGHT_BANK_ID: "host-bank",
            HINDSIGHT_ARBITRARY_NEW_SETTING: "host-setting",
          },
        },
      );
      const child = runner;
      const events: Record<string, any>[] = [];
      const waiters = new Set<() => void>();
      let buffer = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            events.push(JSON.parse(raw));
          } catch {}
        }
        for (const wake of waiters) wake();
      });
      const waitFor = (predicate: (event: Record<string, any>) => boolean) =>
        new Promise<Record<string, any>>((done, reject) => {
          const timer = setTimeout(
            () => finish(new Error(`${mode}: runner timed out ${stderr}`)),
            45000,
          );
          const finish = (error?: Error, event?: Record<string, any>) => {
            clearTimeout(timer);
            waiters.delete(check);
            child.off("exit", exited);
            if (error) reject(error);
            else done(event!);
          };
          const check = () => {
            const failure = events.find((event) => event.type === "failure");
            if (failure) return finish(new Error(`${mode}: ${JSON.stringify(failure)} ${stderr}`));
            const event = events.find(predicate);
            if (event) finish(undefined, event);
          };
          const exited = () => finish(new Error(`${mode}: runner exited ${stderr}`));
          waiters.add(check);
          child.once("exit", exited);
          check();
        });
      const send = (command: Record<string, unknown>) =>
        child.stdin.write(`${JSON.stringify(command)}\n`);
      const runId = "run_00000000";
      send({
        type: "open",
        id: runId,
        instanceId: "ins_00000000",
        sessionId: randomUUID(),
        sessionDirectory: join(caseDir, "sessions"),
        cwd: caseDir,
        agentDir: fixture.agentDir,
        extensionPath: join(root, "pi/sprout-extension.ts"),
        purpose: mode === "assistant" ? "assistant" : "worker",
        ...(mode === "legacy" ? {} : { memory }),
        resources: { kind: "enabled", skillPaths, promptPaths: [] },
        profile: {
          id: "cfg_00000000-0000-4000-8000-000000000000",
          name: "Memory fixture",
          persona: "Fixture only.",
          harness: "pi",
          model: fixture.model("status"),
          updatedAt: "2026-10-24T00:00:00.000Z",
        },
        remote: {
          endpoint: "http://127.0.0.1:1/api/remote/agent",
          secret: randomBytes(32).toString("base64url"),
          projectId: "prj_00000000",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
      const { snapshot } = await waitFor((event) => event.type === "ready");
      const ready = mode === "ready";
      assert.deepEqual(
        snapshot.memory,
        ready
          ? { state: "ready", bank: memory.state === "ready" ? memory.bank : "" }
          : ["import-throws", "factory-throws", "session-start-throws", "partial-tools"].includes(
                mode,
              )
            ? { state: "unavailable", reason: "extension_load_failed", bank: "sprout::fixture" }
            : mode === "unavailable"
              ? memory
              : { state: "disabled" },
        mode,
      );
      assert.equal(snapshot.extensions.includes("hindsight-memory"), ready, mode);
      for (const field of ["tools", "registeredTools"])
        assert.deepEqual(
          snapshot[field].filter((name: string) => name.startsWith("hindsight_")).sort(),
          ready ? [...MEMORY_TOOL_NAMES].sort() : [],
          `${mode}: ${field}`,
        );
      assert.deepEqual(
        snapshot.resources.skillPaths,
        mode === "assistant" ? [] : ready ? skillPaths : skillPaths.slice(0, 1),
      );
      assert.equal(snapshot.resources.skills.includes("hindsight-coding-agent"), ready);
      assert.equal(
        existsSync(imported),
        !["disabled", "unavailable", "assistant", "legacy"].includes(mode),
      );
      assert.equal(JSON.stringify(snapshot).includes("fixture-token"), false);
      assert.equal(JSON.stringify(snapshot).includes(bundlePath), false);
      const probe = JSON.parse(readFileSync(probePath, "utf8"));
      if (ready) {
        assert.deepEqual(probe.config, {
          serverMode: "self-hosted",
          apiUrl: "http://127.0.0.1:1",
          bankId: "sprout::fixture",
          dynamicBankId: false,
          autoUpdate: false,
        });
        assert.deepEqual(probe.env, {
          HINDSIGHT_CONFIG: probe.env.HINDSIGHT_CONFIG,
          HINDSIGHT_API_TOKEN: "fixture-token",
          HINDSIGHT_BANK_ID: "sprout::fixture",
          HINDSIGHT_API_URL: "http://127.0.0.1:1",
          HINDSIGHT_AUTO_UPDATE: "false",
        });
        assert.deepEqual(JSON.parse(readFileSync(imported, "utf8")), {
          config: probe.config,
          token: "fixture-token",
        });
        assert.equal(probe.fileMode, 0o600);
        assert.equal(probe.dirMode, 0o700);
      } else {
        assert.deepEqual(probe.env, {});
        assert.equal(probe.config, null);
      }
      if (mode !== "assistant") {
        fixture.arm("status", {
          expectedUserPrefix: "MEMORY_FIXTURE_CONTEXT",
          steps: [],
          reply: "Memory fixture completed.",
        });
        const serializedText = "MEMORY_FIXTURE_CONTEXT";
        send({
          type: "prompt",
          id: runId,
          messageId: "message-fixture",
          text: "Complete this fixture.",
          turnContext: {
            runId,
            serializedText,
            contentHash: createHash("sha256").update(serializedText).digest("hex"),
          },
        });
        const settled = await waitFor((event) => event.type === "settled");
        assert.equal(settled.text, "Memory fixture completed.");
        fixture.assertDrained();
      }
      assert.equal(existsSync(hookRan), ready, `${mode}: no leaked hook after fallback`);
      const exited = once(child, "exit");
      send({ type: "close", id: runId });
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(readFileSync(exitPath, "utf8")), {});
      if (ready) assert.equal(existsSync(dirname(probe.env.HINDSIGHT_CONFIG)), false);
      fixture.assertHealthy();
      console.log(`${mode}: PASS`);
    } finally {
      if (runner && runner.exitCode === null) runner.kill("SIGKILL");
      await fixture.close();
    }
  }
  console.log("memory runner: 9 gates PASS; paidModelCalls=0; Hindsight service calls=0");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
