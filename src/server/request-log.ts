import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RequestLogRecord = {
  requestId: string;
  method: string;
  path: string;
  fn: string | null;
  fnId: string | null;
  status: number;
  ms: number;
  bytes: number | null;
  complete: boolean;
};

export type ServerFnMeta = {
  id: string;
  name: string;
  filename: string;
};

// Nitro 输出把这段对象缩进成多行，rollup 的其它产线可能压成单行，两种都要认。
const SERVER_FN_META =
  /createServerRpc\(\s*\{\s*id:\s*"([0-9a-f]{64})",\s*name:\s*"([^"]+)",\s*filename:\s*"([^"]+)"/g;
const SERVER_FN_PATH = /^\/_serverFn\/([0-9a-f]{64})$/;

export function parseServerFnMetas(source: string): ServerFnMeta[] {
  const metas: ServerFnMeta[] = [];
  for (const match of source.matchAll(SERVER_FN_META)) {
    metas.push({ id: match[1], name: match[2], filename: match[3] });
  }
  return metas;
}

export function serverFunctionId(pathname: string): string | null {
  return SERVER_FN_PATH.exec(pathname)?.[1] ?? null;
}

let cachedNames: Map<string, string> | null = null;

// 共享模块可能被拆进 _chunks/，此时 import.meta.url 比 _output/server 深一层，两个根都试。
function buildDirectories(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const directories: string[] = [];
  for (const root of [here, resolve(here, "..")]) {
    for (const name of ["_ssr", "_chunks"]) {
      const directory = join(root, name);
      if (!directories.includes(directory)) directories.push(directory);
    }
  }
  return directories;
}

export function loadServerFnNames(): Map<string, string> {
  if (cachedNames) return cachedNames;
  const names = new Map<string, string>();
  cachedNames = names;
  try {
    for (const directory of buildDirectories()) {
      for (const file of readdirSync(directory)) {
        if (!file.endsWith(".mjs")) continue;
        const source = readFileSync(join(directory, file), "utf8");
        for (const meta of parseServerFnMetas(source)) names.set(meta.id, meta.name);
      }
    }
  } catch {
    // dev（vp dev）没有构建产物目录，扫码失败只意味着退化成只记 fnId。
  }
  return names;
}

function requestLogEnabled(): boolean {
  const value = process.env.SPROUT_REQUEST_LOG?.trim().toLowerCase();
  return value === "on" || value === "1" || value === "true";
}

export function logRequest(record: RequestLogRecord): void {
  if (!requestLogEnabled()) return;
  console.log("[request]", JSON.stringify(record));
}
