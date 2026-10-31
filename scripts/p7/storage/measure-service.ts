// F8a/F8b 本地服务基线：生产构建、真实 HTTP、固定样本与并发。只测本地 handler 与 SQLite，
// 模型宿主显式关闭；任何把模型等待混进样本的采集都会越过本地包络而被门禁拒绝。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = mkdtempSync(join(tmpdir(), "p7-service-baseline-"));
const authSecret = randomBytes(32).toString("base64url");
const password = "snapshot-password-9f4c";
const SAMPLE_COUNT = 50;
const ROUNDS = 3;
const WARMUP = 5;
const CONCURRENCY = 1;
const LOCAL_MAX_P95_MS = 250;
const children: ReturnType<typeof spawn>[] = [];

function parseMarker(output: string, marker: string) {
  const line = output
    .split("\n")
    .find((entry) => entry.startsWith(`${marker} `));
  if (!line) throw new Error(`找不到 ${marker} 输出:\n${output}`);
  return JSON.parse(line.slice(marker.length + 1));
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 300_000,
  });
}

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return Math.round(sorted[index]! * 1000) / 1000;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("没有端口"));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // 继续等。
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`等待超时 ${timeoutMs}ms`);
}

async function httpJson(url: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
}

async function measureOnce(url: string, cookie: string) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: { cookie, "cache-control": "no-store" },
    signal: AbortSignal.timeout(10_000),
  });
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  return { elapsed, status: response.status };
}

try {
  const database = join(directory, "baseline.sqlite");
  const seeded = parseMarker(
    runNode(["scripts/p7/storage/seed-baseline.ts"], {
      DATABASE_URL: database,
      BETTER_AUTH_SECRET: authSecret,
      NODE_ENV: "test",
      SPROUT_PI_ENABLED: "false",
      SEED_EMAIL: "baseline@sprout.test",
      SEED_PASSWORD: password,
    }),
    "SEED",
  ) as { email: string; userId: string; projectId: string; listRequestId: string };

  const port = await freePort();
  const log = join(directory, "production.log");
  const descriptor = openSync(log, "w");
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: database,
      PORT: String(port),
      NITRO_PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      BETTER_AUTH_SECRET: authSecret,
      SPROUT_PI_ENABLED: "false",
      AUTH_RATE_LIMIT_MAX: "1000",
      AUTH_RATE_LIMIT_HTTP_MAX: "1000",
      AUTH_RATE_LIMIT_GLOBAL_MAX: "10000",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
    detached: true,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  children.push(child);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (exited) throw new Error(`server 提前退出:\n${readFileSync(log, "utf8")}`);
      const response = await httpJson(`${base}/api/health`);
      return response.status === 200 && response.body.ready === true;
    }, 60_000);
  } catch (error) {
    console.error(readFileSync(log, "utf8"));
    throw error;
  }
  const spawnToReadyMs = Math.round((performance.now() - spawnedAt) * 1000) / 1000;

  const signIn = await httpJson(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    body: { email: seeded.email, password },
    origin: base,
  });
  assert.equal(signIn.status, 200, signIn.text);
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie.length > 0);

  const endpoints = [
    {
      name: "health",
      path: "/api/health",
      expected: (body: Record<string, unknown>) => body.ready === true,
      count: undefined,
    },
    {
      name: "auth-session",
      path: "/api/auth/get-session",
      expected: (body: Record<string, unknown>) => body.user !== null,
      count: undefined,
    },
    {
      name: "diagnostics-request-list",
      path: `/api/diagnostics?requestId=${seeded.listRequestId}&limit=50`,
      expected: (body: Record<string, unknown>) => Array.isArray(body.data) && body.data.length === 12,
      count: 12,
    },
    {
      name: "diagnostics-project-page-50",
      path: `/api/diagnostics?projectId=${seeded.projectId}&limit=50`,
      expected: (body: Record<string, unknown>) => Array.isArray(body.data) && body.data.length === 50,
      count: 50,
    },
    {
      name: "diagnostics-project-page-200",
      path: `/api/diagnostics?projectId=${seeded.projectId}&limit=200`,
      expected: (body: Record<string, unknown>) => Array.isArray(body.data) && body.data.length === 200,
      count: 200,
    },
  ] as const;

  const results = new Map<
    string,
    { roundP50: number[]; roundP95: number[]; roundMax: number[]; samples: number[] }
  >();
  for (const endpoint of endpoints) {
    const verification = await httpJson(`${base}${endpoint.path}`, { cookie });
    assert.equal(verification.status, 200, `${endpoint.name}: ${verification.text}`);
    assert(endpoint.expected(verification.body), `${endpoint.name} 返回形状不符合预期`);
    results.set(endpoint.name, { roundP50: [], roundP95: [], roundMax: [], samples: [] });
    for (let index = 0; index < WARMUP; index += 1) {
      const warm = await measureOnce(`${base}${endpoint.path}`, cookie);
      assert.equal(warm.status, 200);
    }
  }
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const endpoint of endpoints) {
      const samples: number[] = [];
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const sample = await measureOnce(`${base}${endpoint.path}`, cookie);
        assert.equal(sample.status, 200, `${endpoint.name} 第 ${index} 个样本失败`);
        samples.push(sample.elapsed);
      }
      const result = results.get(endpoint.name)!;
      result.roundP50.push(percentile(samples, 50));
      result.roundP95.push(percentile(samples, 95));
      result.roundMax.push(Math.max(...samples));
      result.samples.push(...samples);
      const p95 = result.roundP95.at(-1)!;
      const minP95 = Math.min(...result.roundP95);
      const maxP95 = Math.max(...result.roundP95);
      assert(
        maxP95 <= LOCAL_MAX_P95_MS,
        `${endpoint.name} 第 ${round + 1} 轮 p95=${maxP95}ms 超过本地包络 ${LOCAL_MAX_P95_MS}ms；模型等待不得混入本地耗时`,
      );
      assert(
        maxP95 <= Math.max(50, minP95 * 20),
        `${endpoint.name} 第 ${round + 1} 轮 p95 波动异常: ${JSON.stringify(result.roundP95)}`,
      );
      assert.equal(samples.length, SAMPLE_COUNT);
    }
  }

  const summary = endpoints.map((endpoint) => {
    const result = results.get(endpoint.name)!;
    return {
      name: endpoint.name,
      path: endpoint.path,
      expectedRows: endpoint.count ?? null,
      samples: result.samples.length,
      rounds: ROUNDS,
      samplesPerRound: SAMPLE_COUNT,
      p50MedianMs: percentile(result.roundP50, 50),
      p95MedianMs: percentile(result.roundP95, 50),
      p95PerRoundMs: result.roundP95,
      maxMs: Math.round(Math.max(...result.roundMax) * 1000) / 1000,
    };
  });

  const health = await httpJson(`${base}/api/health`, { cookie });
  assert.equal(health.body.activeBackgroundTasks, 0, "本地基线期间不得有模型后台任务");
  const databaseCheck = new Database(database, { readonly: true });
  let piHostDiagnostics: number;
  try {
    piHostDiagnostics = (
      databaseCheck
        .prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event LIKE 'pi_host.%'")
        .get() as { count: number }
    ).count;
  } finally {
    databaseCheck.close();
  }
  assert.equal(piHostDiagnostics, 0, "本地基线不得产生模型宿主诊断");

  const logDatabase = join(directory, "logs.sqlite");
  const logMeasurement = parseMarker(
    runNode(["scripts/p7/storage/measure-logs.ts"], {
      DATABASE_URL: logDatabase,
      BETTER_AUTH_SECRET: authSecret,
      NODE_ENV: "test",
      SPROUT_PI_ENABLED: "false",
    }),
    "RESULT",
  );

  const output = {
    scope: "local HTTP handlers and SQLite only; SPROUT_PI_ENABLED=false",
    method: {
      sampleCount: SAMPLE_COUNT,
      rounds: ROUNDS,
      samplesPerEndpoint: SAMPLE_COUNT * ROUNDS,
      warmupPerEndpoint: WARMUP,
      concurrency: CONCURRENCY,
      keepAlive: true,
      coldStart: {
        spawnToReadyMs,
        note: "进程启动到首个 200 ready；HTTP 样本在预热后采集，不含冷启动",
      },
      authRateLimitsRaised: true,
      authRateLimitNote: "auth-session 是单对象端点；测量时提高限流，避免 429 变成样本错误",
      localOnlyEnvelopeMs: LOCAL_MAX_P95_MS,
      envelopeNote:
        "识别把模型等待混入本地耗时的污染；不是产品 SLA，也不作为 CI 性能门槛",
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    endpoints: summary,
    logBacklog: logMeasurement,
    measuredAt: new Date().toISOString(),
  };
  const out = resolve(process.argv[2] ?? ".verify/p7-service-baseline.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`BASELINE ${out}`);
  for (const endpoint of summary)
    console.log(
      `ENDPOINT ${endpoint.name} p50=${endpoint.p50MedianMs}ms p95=${endpoint.p95MedianMs}ms samples=${endpoint.samples} p95Rounds=${endpoint.p95PerRoundMs.join(",")}`,
    );
  console.log(
    `LOGS frames=${logMeasurement.pagination.frameCount} bytes=${logMeasurement.pagination.totalBytes} pageP50=${logMeasurement.pagination.pageLatencyMs.p50}ms pageP95=${logMeasurement.pagination.pageLatencyMs.p95}ms fullP50=${logMeasurement.pagination.fullReadMs.p50}ms fullP95=${logMeasurement.pagination.fullReadMs.p95}ms outboxPausedAt=${logMeasurement.outbox.pausedAtBytes} resumedAt=${logMeasurement.outbox.resumedAtBytes}`,
  );
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await waitFor(() => exited, 10_000).catch(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    });
  }
  console.log(`EVIDENCE ${out}`);
} catch (error) {
  console.error("FAIL p7-service-baseline", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}
