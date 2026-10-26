import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const directory = resolve(".verify/drain-http");
mkdirSync(directory, { recursive: true });
const port = Number(process.env.SPROUT_VERIFY_DRAIN_PORT ?? 3144);
const origin = `http://127.0.0.1:${port}`;
const evidence = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();
const sockets = new Set();
async function until(predicate, message, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(message);
}
function log(name) {
  return readFileSync(join(directory, `${name}.log`), "utf8");
}
function pass(check, output) {
  evidence.push({ check, ...output });
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`PASS ${check} ${JSON.stringify(output)}`);
}
async function connect() {
  const socket = net.connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.setEncoding("utf8");
  socket.output = "";
  socket.on("data", (data) => (socket.output += data));
  socket.on("error", () => {});
  socket.completion = new Promise((resolve) => socket.once("close", resolve));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}
async function scenario(name, signal, timeout, ci) {
  const databaseUrl = join(directory, `${name}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(databaseUrl + suffix, { force: true });
  const fd = openSync(join(directory, `${name}.log`), "w");
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: origin,
    PORT: String(port),
    NITRO_PORT: String(port),
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    SERVER_SHUTDOWN_TIMEOUT: "1", // Entry must coordinate even a shorter deployment value.
  };
  delete env.TEST;
  delete env.CI;
  if (ci) env.CI = "true";
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    env,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  children.add(child);
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let database;
  try {
    const health = await until(
      async () => {
        assert.equal(child.exitCode, null, log(name));
        try {
          const response = await fetch(`${origin}/api/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.status === 200) return response.json();
        } catch {}
      },
      "production health not ready",
      15000,
    );
    database = new Database(databaseUrl);
    const boot = () =>
      database
        .prepare("SELECT phase, stopped_at FROM runtime_boot WHERE id = ?")
        .get(health.bootId);
    const email = `${name}@example.test`;
    const body = JSON.stringify({ email, password: randomBytes(24).toString("base64url"), name });
    const slow = await connect();
    slow.write(
      `POST /api/auth/sign-up/email HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n` +
        body.slice(0, 1),
    );
    // A connection with partial headers predates close(), but its request only
    // enters the application after the signal. No verify-only production hook.
    const late = await connect();
    late.write(`POST /api/auth/sign-up/email HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    await delay(150);
    const started = Date.now();
    child.kill(signal);
    await until(() => {
      assert.equal(
        child.exitCode,
        null,
        `process exited with an unfinished auth upload; boot=${JSON.stringify(boot())}; response=${JSON.stringify(slow.output)}`,
      );
      return /\[runtime\] draining .*"activeRequests":1/.test(log(name));
    }, "signal did not retain one in-flight request");
    await until(() => boot().phase === "stopping", "boot never entered stopping");
    assert.equal(boot().stopped_at, null);
    const diagnosticsBefore = database
      .prepare("SELECT count(*) AS count FROM diagnostic_event")
      .get().count;
    const rejectedBody = JSON.stringify({
      email: "rejected@example.test",
      password: "LongPassword123456!",
      name: "Rejected",
    });
    late.write(
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(rejectedBody)}\r\nConnection: close\r\n\r\n${rejectedBody}`,
    );
    await until(() => late.output.includes("503"), "new work was not rejected with 503");
    await late.completion;
    writeFileSync(join(directory, `${name}-rejected.http`), late.output);
    assert.match(late.output, /^HTTP\/1.1 503 /);
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM user WHERE email = 'rejected@example.test'")
        .get().count,
      0,
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM diagnostic_event").get().count,
      diagnosticsBefore,
    );
    assert.deepEqual(boot(), { phase: "stopping", stopped_at: null });
    assert.equal(child.exitCode, null, "process exited before slow request completed");
    pass(`${name}: draining rejects new work without DB writes`, {
      status: 503,
      boot: boot(),
      ci,
      signal,
    });
    if (!timeout) {
      // Hold the real auth upload through drain; then allow parsing, scrypt,
      // inserts and the response to complete normally.
      await delay(350);
      assert.deepEqual(boot(), { phase: "stopping", stopped_at: null });
      slow.write(body.slice(1));
      await until(() => /^HTTP\/1.1 200\b/.test(slow.output), "in-flight signup was interrupted");
      await slow.completion;
      writeFileSync(join(directory, `${name}-signup.http`), slow.output);
      assert.match(slow.output, /^HTTP\/1.1 200 /);
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM user WHERE email = ?").get(email).count,
        1,
      );
    }
    // The product drains for 8s and only then shuts down; the outer observation
    // window must outlast that budget plus the in-flight work it is meant to
    // observe, otherwise a loaded machine reports a harness timeout for correct
    // product behaviour. Timeout runs settle at the product deadline, so they
    // keep the tighter window.
    const observationMs = timeout ? 10000 : 20000;
    const result = await Promise.race([
      completion,
      delay(observationMs).then(() => {
        throw new Error(`shutdown exceeded ${observationMs / 1000} seconds`);
      }),
    ]);
    children.delete(child);
    const durationMs = Date.now() - started;
    assert.equal(result.signal, null);
    assert.equal(result.code, timeout ? 1 : 0);
    const output = log(name);
    if (timeout) {
      assert.deepEqual(boot(), { phase: "stopping", stopped_at: null });
      assert.match(output, /\[runtime\] 失败 stopping HTTP 排空超时/);
      assert(!output.includes("scope-disposed"));
      assert(!output.includes('"phase":"stopped"'));
      pass(`${name}: deadline fails without disposing DB or claiming stopped`, {
        ...result,
        durationMs,
        boot: boot(),
        error: "HTTP 排空超时 (8000ms)",
      });
    } else {
      assert.equal(boot().phase, "stopped");
      assert(boot().stopped_at > 0);
      const markers = [
        '"phase":"stopping"',
        "[runtime] drained",
        "[runtime] scope-disposed",
        '"phase":"stopped"',
      ];
      const positions = markers.map((marker) => output.indexOf(marker));
      assert(
        positions.every(
          (position, index) => position >= 0 && (index === 0 || position > positions[index - 1]),
        ),
      );
      assert(!output.includes("[diagnostics] 写入失败"));
      pass(`${name}: in-flight signup completes before stopped and exit 0`, {
        ...result,
        durationMs,
        boot: boot(),
        order: markers,
      });
    }
  } finally {
    database?.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (children.has(child)) child.kill("SIGKILL");
  }
}
try {
  await scenario("term", "SIGTERM", false, false);
  await scenario("int-ci", "SIGINT", false, true);
  await scenario("timeout", "SIGTERM", true, false);
  pass("drain HTTP all checks passed", { evidence: join(directory, "evidence.json") });
} catch (error) {
  console.error("FAIL drain-http", error.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const socket of sockets) socket.destroy();
}
