#!/usr/bin/env node
/** Trigger one real operation for the private review environment's running-color check. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
process.env.NO_PROXY = "127.0.0.1,localhost,::1";
process.env.no_proxy = process.env.NO_PROXY;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireStart = createRequire(import.meta.resolve("@tanstack/react-start"));
const requireClient = createRequire(
  requireStart.resolve("@tanstack/start-client-core/package.json"),
);
const { fromCrossJSON, toJSON } = requireClient("seroval");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const signal = AbortSignal.timeout(240_000);

function serverFunctionIds(directory, ids = new Map()) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) serverFunctionIds(path, ids);
    else if (/\.(?:m?js)$/.test(entry)) {
      for (const match of readFileSync(path, "utf8").matchAll(
        /id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g,
      ))
        ids.set(match[2], match[1]);
    }
  }
  return ids;
}

async function probe() {
  const infoPath = resolve(process.argv[2]);
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  const { runningProbe, origin, project } = info;
  const url = new URL(origin);
  if (!runningProbe || url.hostname !== "127.0.0.1" || url.port === "3000")
    throw new Error("Requires a private review environment");
  const login = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: info.login.email, password: info.login.password }),
    signal,
  });
  if (!login.ok) throw new Error("Login failed");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("No login session");
  const ids = serverFunctionIds(join(repo, ".output/server"));
  async function call(name, data) {
    const id = ids.get(name);
    if (!id) throw new Error("Missing built server function");
    const response = await fetch(`${origin}/_serverFn/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tsr-serverfn": "true", origin, cookie },
      body: JSON.stringify(toJSON({ data })),
      signal,
    });
    if (!response.ok) throw new Error("Server function HTTP failure");
    const raw = await response.json();
    const decoded = raw?.t !== undefined ? fromCrossJSON(raw, { refs: new Map() }) : raw;
    const result = decoded.result ?? decoded;
    if (!result.ok) throw new Error("Server function rejected");
    return result.data;
  }
  const runState = await call("getChatRunStateFn", { chatId: runningProbe.chatId });
  if (runState.runs.some((run) => ["queued", "running"].includes(run.status)))
    throw new Error("Probe Chat is busy; wait for its run to finish");
  const requestId = `req_${randomUUID()}`;
  const pidPath = join(runningProbe.pidDirectory, `${requestId}.pid`);
  const command = `printf '%s' "$$" > ${quote(pidPath)}; exec /bin/sleep 20`;
  await call("sendMessageFn", {
    chatId: runningProbe.chatId,
    body: [
      "Use ONLY Sprout tools, never local tools. Perform exactly one remote shell operation; never retry it.",
      `Call sprout_lease_get with explicit machineId=${runningProbe.machineId}.`,
      `Then sprout_remote_shell on machineId=${runningProbe.machineId}, authorizationGeneration from the held lease, requestId=${requestId}, cwd=${runningProbe.cwd}, waitMs=10000, exact command: ${command}`,
      "Do not acquire, release or handoff. Do not print commands, credentials, results or output. Reply only OK.",
    ].join("\n"),
  });
  while (!signal.aborted) {
    const executions = await call("listProjectExecutionsFn", {
      projectId: project.id,
      machineId: runningProbe.machineId,
      limit: 100,
    });
    const execution = executions.find((item) => item.requestId === requestId);
    if (execution?.state === "running" && existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid probe process identity");
      process.kill(pid, 0);
      const observation = {
        executionId: execution.executionId,
        requestId,
        state: execution.state,
        observedAt: new Date().toISOString(),
        pid,
        confirmedBy:
          "Authenticated listProjectExecutionsFn returned state=running; the real shell's PID marker exists and kill(pid, 0) succeeds. No remote result or output is recorded.",
      };
      const current = JSON.parse(readFileSync(infoPath, "utf8"));
      current.runningProbe.lastObservation = observation;
      const document = `${JSON.stringify(current, null, 2)}\n`;
      writeFileSync(infoPath, document, { mode: 0o600 });
      const aliasPath = join(dirname(infoPath), "review-info.json");
      if (
        aliasPath !== infoPath &&
        existsSync(aliasPath) &&
        JSON.parse(readFileSync(aliasPath, "utf8")).stateDir === current.stateDir
      ) {
        writeFileSync(aliasPath, document, { mode: 0o600 });
      }
      console.log(
        `[p4b-review] running confirmed: ${observation.executionId}; observe the lease page immediately (10-second maximum window; only a few seconds may remain; refresh is every 5 seconds)`,
      );
      return;
    }
    if (execution && !["queued", "dispatched", "running"].includes(execution.state))
      throw new Error("Missed running window; wait for Chat to finish and retry");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Running probe timed out");
}

try {
  await probe();
} catch {
  console.error(
    "[p4b-review] Running probe failed; check environment availability and Chat idle state. No remote output logged.",
  );
  process.exitCode = 1;
}
