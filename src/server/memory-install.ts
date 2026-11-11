import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  HINDSIGHT_EXTENSION_INTEGRITY,
  HINDSIGHT_EXTENSION_VERSION,
  type MemoryInstallStatus,
} from "../contracts/memory";
import type { DatabaseConnection } from "../db/connection";
import { memoryInstall } from "../db/schema";
import { config } from "../lib/config";

type MemoryDatabase = DatabaseConnection["db"];
export type MemoryInstallRow = typeof memoryInstall.$inferSelect;

/** 首版只有一个组件；主键是 `(machine_id, component)`。 */
export const MEMORY_INSTALL_COMPONENT = "hindsight-extension";

/** 官方 registry 上钉死版本的 tarball；版本号同时来自 `HINDSIGHT_EXTENSION_VERSION`。 */
const TARBALL_URL = `https://registry.npmjs.org/@vectorize-io/hindsight-coding-agents/-/hindsight-coding-agents-${HINDSIGHT_EXTENSION_VERSION}.tgz`;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
/** 超过这个时长的锁视为持有者已崩溃，可以被后来者接管。 */
const STALE_LOCK_MS = 10 * 60_000;
const LOCK_POLL_MS = 50;
const MAX_ERROR_CHARS = 200;

export type MemoryInstallErrorCode =
  | "fetch_failed"
  | "integrity_mismatch"
  | "extract_failed"
  | "timeout"
  | "locked"
  | "io_failed";

export class MemoryInstallError extends Error {
  constructor(
    readonly code: MemoryInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemoryInstallError";
  }
}

/** 只保留 `url` 与 `signal`，测试可以直接注入一个最小 stub，不必实现完整 `fetch` 重载。 */
export type MemoryFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "follow" },
) => Promise<Response>;

export type ProvisionMemoryExtensionOptions = {
  db: MemoryDatabase;
  machineId: string;
  dataDir?: string;
  fetchImpl?: MemoryFetch;
  timeoutMs?: number;
  now?: () => number;
  /**
   * 本地 tarball 路径，供离线安装与测试使用；不传则读
   * `SPROUT_HINDSIGHT_EXTENSION_TARBALL`，两者都为空才走 registry。
   */
  tarballPath?: string;
  /**
   * 期望的 sha512 integrity。默认是 `HINDSIGHT_EXTENSION_INTEGRITY`；
   * 测试与离线安装用它指认本地 fixture tarball 的真实摘要。
   */
  integrity?: string;
};

export type ProvisionedMemoryExtension = { path: string; version: string };

/** 同一进程内按 `dataDir + machineId` 单飞，避免并发重复下载与解压。 */
const inFlight = new Map<string, Promise<ProvisionedMemoryExtension>>();

export function provisionMemoryExtension(
  options: ProvisionMemoryExtensionOptions,
): Promise<ProvisionedMemoryExtension> {
  const dataDir = options.dataDir ?? config.SPROUT_PI_DATA_DIR;
  const key = `${dataDir}\u0000${options.machineId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = runProvision({ ...options, dataDir }).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Runner 起 run 时只读这一行，不等待安装。 */
export function readMemoryInstall(db: MemoryDatabase, machineId: string): MemoryInstallRow | null {
  return (
    db
      .select()
      .from(memoryInstall)
      .where(
        and(
          eq(memoryInstall.machineId, machineId),
          eq(memoryInstall.component, MEMORY_INSTALL_COMPONENT),
        ),
      )
      .get() ?? null
  );
}

async function runProvision(
  options: ProvisionMemoryExtensionOptions & { dataDir: string },
): Promise<ProvisionedMemoryExtension> {
  const version = HINDSIGHT_EXTENSION_VERSION;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineAt = now() + timeoutMs;
  /** 等锁、下载、解压共享同一个截止时间，任一阶段耗尽都算整体超时。 */
  const remaining = (stage: string): number => {
    const ms = deadlineAt - now();
    if (ms <= 0) throw new MemoryInstallError("timeout", `安装扩展超时（${stage}）`);
    return ms;
  };
  const integrity = options.integrity ?? HINDSIGHT_EXTENSION_INTEGRITY;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  const extensionsDir = join(options.dataDir, "extensions");
  const hindsightDir = join(extensionsDir, "hindsight");
  const targetDir = join(hindsightDir, version);
  const lockPath = join(hindsightDir, `${version}.lock`);

  const installed = installedEntry(targetDir);
  if (installed) {
    writeStatus(options.db, options.machineId, "ready", null, now());
    return { path: installed, version };
  }

  writeStatus(options.db, options.machineId, "installing", null, now());
  let releaseLock: (() => void) | undefined;
  let tempRoot: string | undefined;
  try {
    mkdirSync(hindsightDir, { recursive: true });
    releaseLock = await acquireLock(lockPath, deadlineAt, now);

    // 拿到锁后可能已有别的进程装好了，重新检查一次。
    const raced = installedEntry(targetDir);
    if (raced) {
      writeStatus(options.db, options.machineId, "ready", null, now());
      return { path: raced, version };
    }
    // 目标存在但 manifest 或入口损坏时，持锁清掉；否则 rename 会 ENOTEMPTY，重试永远失败。
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });

    tempRoot = mkdtempSync(join(extensionsDir, "hindsight-install-"));
    const extractDir = join(tempRoot, "extract");
    const archivePath = join(tempRoot, "package.tgz");
    mkdirSync(extractDir, { recursive: true });

    const localTarball = options.tarballPath ?? process.env.SPROUT_HINDSIGHT_EXTENSION_TARBALL;
    let bytes: Buffer;
    if (localTarball) {
      remaining("读取本地 tarball");
      if (statSync(localTarball).size > MAX_TARBALL_BYTES)
        throw new MemoryInstallError("fetch_failed", "本地 tarball 超过 50 MB");
      bytes = readFileSync(localTarball);
      remaining("读取本地 tarball");
    } else {
      bytes = await fetchTarball(fetchImpl, TARBALL_URL, remaining("下载"));
    }
    verifyIntegrity(bytes, integrity);
    writeFileSync(archivePath, bytes);
    await extractTarball(archivePath, extractDir, remaining("解压"));

    const path = installedEntry(extractDir);
    if (!path)
      throw new MemoryInstallError("extract_failed", "解压后的扩展缺少 package/dist/pi.js");

    remaining("发布");
    renameSync(extractDir, targetDir);
    writeStatus(options.db, options.machineId, "ready", null, now());
    return { path: join(targetDir, "package", "dist", "pi.js"), version };
  } catch (error) {
    const failure = toMemoryInstallError(error);
    try {
      writeStatus(options.db, options.machineId, "failed", shortMessage(failure.message), now());
    } catch {
      // 记状态是尽力而为；原始失败仍要抛给调用方。
    }
    throw failure;
  } finally {
    releaseLock?.();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 目标目录里已装好且版本一致时返回入口文件，否则返回 undefined。
 * 版本从包自己的 `package.json` 读，避免只凭目录名就认定内容正确。
 */
function installedEntry(directory: string): string | undefined {
  const entry = join(directory, "package", "dist", "pi.js");
  const manifest = join(directory, "package", "package.json");
  if (!existsSync(entry) || !existsSync(manifest)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return pkg.version === HINDSIGHT_EXTENSION_VERSION ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeStatus(
  db: MemoryDatabase,
  machineId: string,
  status: MemoryInstallStatus,
  error: string | null,
  at: number,
): void {
  const values = {
    machineId,
    component: MEMORY_INSTALL_COMPONENT,
    version: HINDSIGHT_EXTENSION_VERSION,
    status,
    error,
    updatedAtMs: at,
  };
  db.insert(memoryInstall)
    .values(values)
    .onConflictDoUpdate({
      target: [memoryInstall.machineId, memoryInstall.component],
      set: { version: values.version, status, error, updatedAtMs: at },
    })
    .run();
}

/** 目录锁：`mkdir` 原子独占；等待期间检测超过 10 分钟的残留锁并接管。 */
async function acquireLock(
  lockPath: string,
  deadlineAt: number,
  now: () => number,
): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!isCode(error, "EEXIST"))
        throw new MemoryInstallError("io_failed", `无法创建安装锁：${messageOf(error)}`);
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw new MemoryInstallError("io_failed", `无法读取安装锁：${messageOf(error)}`);
    }
    if (now() - mtimeMs > STALE_LOCK_MS) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (now() >= deadlineAt) throw new MemoryInstallError("locked", "等待安装锁超时");
    await delay(Math.min(LOCK_POLL_MS, Math.max(1, deadlineAt - now())));
  }
}

async function fetchTarball(
  fetchImpl: MemoryFetch,
  url: string,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = new MemoryInstallError("timeout", `下载扩展超时（${timeoutMs}ms）`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeout);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, { signal: controller.signal, redirect: "follow" }),
      deadline,
    ]);
    if (!response.ok) {
      controller.abort();
      await cancelBody(response);
      throw new MemoryInstallError("fetch_failed", `下载扩展失败：HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
      controller.abort();
      await cancelBody(response);
      throw new MemoryInstallError("fetch_failed", "扩展 tarball 超过 50 MB 上限");
    }
    return await Promise.race([readCapped(response), deadline]);
  } catch (error) {
    controller.abort();
    if (error instanceof MemoryInstallError) throw error;
    throw new MemoryInstallError("fetch_failed", `下载扩展失败：${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 提前拒绝时也要释放响应体，否则连接与流会挂在后台。 */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 取消失败不覆盖原始错误。
  }
}

async function readCapped(response: Response): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.from(await response.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TARBALL_BYTES) {
      await reader.cancel();
      throw new MemoryInstallError("fetch_failed", "扩展 tarball 超过 50 MB 上限");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function verifyIntegrity(bytes: Buffer, expected: string): void {
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== expected)
    throw new MemoryInstallError("integrity_mismatch", "扩展 tarball sha512 校验失败");
}

function extractTarball(tarballPath: string, extractDir: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarballPath, "-C", extractDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new MemoryInstallError("extract_failed", `无法启动 tar：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new MemoryInstallError("timeout", "解压扩展超时，进程已被终止"));
      else if (code !== 0)
        reject(
          new MemoryInstallError(
            "extract_failed",
            `解压扩展失败（exit ${code}）${firstLine(stderr)}`,
          ),
        );
      else resolve();
    });
  });
}

function toMemoryInstallError(error: unknown): MemoryInstallError {
  if (error instanceof MemoryInstallError) return error;
  return new MemoryInstallError("io_failed", `安装扩展失败：${messageOf(error)}`);
}

function shortMessage(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
