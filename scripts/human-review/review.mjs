import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const supportedVersion = "0.1.90";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
/** review 默认从登录页进入；入口只在显式给出路径或 URL 时改变。 */
export const defaultEntry = "/login";

/** 回环、私有网段与 mDNS 名都视为本机可达地址；公网域名不进入预览。 */
export function localHostname(hostname) {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
  if (name === "::1" || name.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(name)) return true;
  if (name.startsWith("127.") || name.startsWith("10.") || name.startsWith("192.168.")) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(name)) return true;
  // Tailscale 等 CGNAT 网段同属内网可达。
  return /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name);
}

/** 应用 origin 依次取进程环境、仓库 env 文件与本地开发默认端口。 */
export async function appOrigin() {
  if (process.env.SPROUT_HUMAN_REVIEW_APP) return process.env.SPROUT_HUMAN_REVIEW_APP;
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  for (const file of [".env.local", ".env"]) {
    let text;
    try {
      text = await readFile(path.join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    const match = text.match(/^\s*(?:export\s+)?APP_ORIGIN\s*=\s*(.*)$/m);
    const value = match?.[1].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  return "http://localhost:3000";
}

/** 把入口解析成应用 URL：空值走登录页，`/path` 相对应用 origin，完整 URL 原样校验。 */
export async function resolveAppUrl(entry = "") {
  const value = entry.trim();
  if (!value) return localAppUrl(new URL(defaultEntry, await appOrigin()).href).href;
  if (/^https?:\/\//i.test(value)) return localAppUrl(value).href;
  if (value.startsWith("/")) return localAppUrl(new URL(value, await appOrigin()).href).href;
  throw new Error(`入口需是 URL、以 / 开头的路径或留空，收到：${entry}`);
}

export function localAppUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !localHostname(url.hostname) || url.username || url.password)
    throw new Error("预览只接受 http 的本机或内网应用 URL（回环、私有网段、CGNAT 或 .local）");
  return url;
}

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error("Lavish 结构已变化，停止适配；请核对支持的版本");
  }
  return source.replace(before, () => after);
}

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function adaptHtml(html, appUrl, key) {
  const original = `<iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" data-artifact-src="/artifact/${key}/index.html"></iframe>`;
  html = replaceOnce(
    html,
    original,
    `<iframe id="artifact" title="Sprout 本地应用预览" data-artifact-src="${escapeAttribute(appUrl)}" allow="clipboard-read; clipboard-write"></iframe>`,
  );
  html = replaceOnce(
    html,
    '<script src="/chrome-client.js"',
    '<link rel="stylesheet" href="/sprout-human-review.css"><script src="/sprout-human-review.js"></script><script src="/chrome-client.js"',
  );
  return html;
}

export function adaptClient(source) {
  const start = source.indexOf("function artifactFrameSrcForLoad(load) {");
  const end = source.indexOf("\nfunction escapeHtml(value) {", start);
  if (start < 0 || end < start) throw new Error("Lavish iframe 加载接口已变化");
  source =
    source.slice(0, start) +
    "function artifactFrameSrcForLoad() { return artifactSrc; }\n" +
    source.slice(end);
  return replaceOnce(
    source,
    'postToFrame({ type: "lavish:requestSnapshot", snapshot_request_id: requestId });',
    'completeSnapshotRequest(requestId, "");',
  );
}

async function executable(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error(`找不到 ${name}；请安装 lavish-axi@${supportedVersion}`);
}

function spawnCaptured(bin, args, env) {
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  const done = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Lavish ${args[0]} 退出 (${code ?? signal}): ${stderr || stdout}`));
    });
  });
  done.catch(() => {});
  return { child, done };
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

export function allowedRequest(req, port) {
  const header = req.headers.host;
  if (!header) return false;
  let requested;
  try {
    requested = new URL("http://" + header);
  } catch {
    return false;
  }
  if (requested.port !== String(port) || !localHostname(requested.hostname)) return false;
  return !req.headers.origin || req.headers.origin === "http://" + header;
}

/** 能否连上该端口；连得上（含连上但不响应）都算被占用，避免只绑定检测的误判。 */
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(500, () => settle(true));
  });
}

/** 端口能否被绑定；false 表示已被其他进程占用。 */
async function portOpen(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
  });
}

/** 端口可用 = 没有进程在应答，也不存在只绑定在回环地址上的监听。 */
async function portFree(port) {
  if (await canConnect(port)) return false;
  return portOpen(port);
}

/**
 * 探测本机 HTTP 服务：ok 有响应、stale 能连但不回、down 连不上。
 * 用 node:http 而不是 fetch：agent 宿主可能给全局 fetch 装代理 dispatcher，
 * 回环请求被迫经过代理后会超时，端口因此被误判成僵死实例。
 */
export function probeHealth(port, timeout = 1500) {
  return new Promise((resolve) => {
    const probe = request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", agent: false },
      (response) => {
        response.resume();
        response.on("end", () => resolve("ok"));
        response.on("error", () => resolve("down"));
      },
    );
    probe.setTimeout(timeout, () => {
      probe.destroy();
      resolve("stale");
    });
    probe.on("error", () => resolve("down"));
    probe.end();
  });
}

/** Lavish 端口状态：free（连接被拒）、occupied（有响应的实例）、stale（能连但不回 HTTP）。 */
async function lavishState(port) {
  const state = await probeHealth(port);
  return state === "ok" ? "occupied" : state === "stale" ? "stale" : "free";
}

/** 从请求端口起挑一对空闲端口，避开应用、已有服务与僵死监听。 */
export async function choosePorts({ port, lavishPort, exclude = [], limit = 40 }) {
  for (let offset = 0; offset < limit; offset++) {
    const candidate = { port: port + offset, lavishPort: lavishPort + offset, shifted: offset > 0 };
    if (candidate.port > 65535 || candidate.lavishPort > 65535) break;
    if (candidate.port === candidate.lavishPort) continue;
    if (exclude.includes(candidate.port) || exclude.includes(candidate.lavishPort)) continue;
    if (!(await portFree(candidate.port))) continue;
    if ((await lavishState(candidate.lavishPort)) !== "free") continue;
    return candidate;
  }
  throw new Error(`从 ${port}/${lavishPort} 起找不到可用的 review / Lavish 端口`);
}

export async function startReview({
  url,
  port = 4400,
  lavishPort = 4401,
  autoPorts = false,
  stateDir,
}) {
  const app = new URL(await resolveAppUrl(url));
  for (const number of [port, lavishPort]) {
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new Error("端口必须在 1–65535 之间");
  }
  const chosen = autoPorts
    ? await choosePorts({ port, lavishPort, exclude: [Number(app.port || 80)] })
    : { port, lavishPort, shifted: false };
  ({ port, lavishPort } = chosen);
  if (new Set([port, lavishPort, Number(app.port || 80)]).size !== 3)
    throw new Error("应用、review 和 Lavish 必须使用不同端口");
  /** 预览代理监听全部接口，便于通过 LAN / VPN 地址访问；Lavish 后端仍只在本机回环。 */
  const host = "0.0.0.0";
  const origin = `http://${app.hostname}:${port}`;
  const upstream = `http://127.0.0.1:${lavishPort}`;
  const state = path.resolve(stateDir || `.verify/human-review/${port}`);
  const file = path.join(state, "review.html");
  const bin = await executable("lavish-axi");
  const version = (await exec(bin, ["--version"], { timeout: 10000 })).stdout.trim();
  if (version !== supportedVersion)
    throw new Error(`此适配器支持 Lavish ${supportedVersion}，当前为 ${version}`);
  const require = createRequire(bin);
  const { decode } = await import(pathToFileURL(require.resolve("@toon-format/toon")).href);
  const env = {
    ...process.env,
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_PORT: String(lavishPort),
    LAVISH_AXI_STATE_DIR: path.join(state, "lavish"),
    LAVISH_AXI_NO_OPEN: "1",
  };
  await mkdir(state, { recursive: true });
  let backend,
    server,
    closed = false;
  let key = "",
    reviewUrl = "";
  const sockets = new Set();
  /** 异常退出（未走到 stop）时尽量收拾自有子进程，避免留下占端口的 Lavish。 */
  const emergency = () => {
    if (backend && backend.child.exitCode === null && !backend.child.signalCode)
      backend.child.kill("SIGKILL");
  };
  process.on("exit", emergency);
  const stop = async () => {
    if (closed) return;
    closed = true;
    process.off("exit", emergency);
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await terminate(backend?.child);
  };
  const cli = async (args) => {
    const result = await exec(bin, args, { env, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return decode(result.stdout);
  };
  try {
    const inspect = (number) => `lsof -nP -iTCP:${number} -sTCP:LISTEN`;
    const existing = await probeHealth(lavishPort);
    if (existing === "ok")
      throw new Error(
        `Lavish 端口 ${lavishPort} 已占用（实例在响应 /health）；不接管其他进程。` +
          `先 ${inspect(lavishPort)} 确认归属，或改用 CLI 默认的自动端口选择。`,
      );
    if (existing === "stale")
      throw new Error(
        `Lavish 端口 ${lavishPort} 已占用，但 1.5 秒内没有响应 /health（常见于上次 review 留下的僵死进程）。` +
          `用 ${inspect(lavishPort)} 查 PID，确认是 lavish-axi 后 kill；或改用 CLI 默认的自动端口选择。`,
      );
    server = createServer(async (req, res) => {
      if (!allowedRequest(req, port)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const requestedOrigin = "http://" + req.headers.host;
      const pathname = new URL(req.url, requestedOrigin).pathname;
      if (pathname === "/") {
        res.writeHead(302, { location: `${requestedOrigin}/session/${key}?no-gate=1` }).end();
        return;
      }
      const asset = {
        "/sprout-human-review.js": ["browser.js", "text/javascript"],
        "/sprout-human-review.css": ["browser.css", "text/css"],
      }[pathname];
      if (asset) {
        res.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
        res.end(await readFile(path.join(here, asset[0]), "utf8"));
        return;
      }
      const headers = {
        ...req.headers,
        host: new URL(upstream).host,
        "accept-encoding": "identity",
      };
      if (headers.origin) headers.origin = upstream;
      if (headers.referer?.startsWith(requestedOrigin + "/"))
        headers.referer = upstream + headers.referer.slice(requestedOrigin.length);
      const outgoing = request(upstream + req.url, { method: req.method, headers }, (incoming) => {
        const transform =
          incoming.statusCode === 200 &&
          (pathname === `/session/${key}` || pathname === "/chrome-client.js");
        const responseHeaders = { ...incoming.headers, "cache-control": "no-store" };
        if (!transform) {
          res.writeHead(incoming.statusCode, responseHeaders);
          incoming.pipe(res);
          return;
        }
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () => {
          try {
            const output =
              pathname === "/chrome-client.js" ? adaptClient(body) : adaptHtml(body, app.href, key);
            delete responseHeaders["content-length"];
            delete responseHeaders.etag;
            res.writeHead(200, responseHeaders);
            res.end(output);
          } catch (error) {
            res.writeHead(502).end(error.message);
          }
        });
      });
      outgoing.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Lavish 未运行");
      });
      req.on("aborted", () => outgoing.destroy());
      res.on("close", () => {
        if (!res.writableFinished) outgoing.destroy();
      });
      req.pipe(outgoing);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (req, socket, head) => {
      if (!allowedRequest(req, port)) {
        socket.destroy();
        return;
      }
      const remote = connect(lavishPort, "127.0.0.1", () => {
        const headers = { ...req.headers, host: new URL(upstream).host, origin: upstream };
        remote.write(
          `${req.method} ${req.url} HTTP/1.1\r\n` +
            Object.entries(headers)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join("\r\n") +
            "\r\n\r\n",
        );
        if (head.length) remote.write(head);
        remote.pipe(socket);
        socket.pipe(remote);
      });
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      socket.on("close", () => remote.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once("error", (error) =>
        reject(
          error.code === "EADDRINUSE"
            ? new Error(
                `review 端口 ${port} 已被占用；用 lsof -nP -iTCP:${port} -sTCP:LISTEN 确认，或用 --port <空闲端口>。`,
              )
            : error,
        ),
      );
      server.listen(port, host, resolve);
    });
    backend = spawnCaptured(bin, ["server", "--port", String(lavishPort)], env);
    for (let attempt = 0; ; attempt++) {
      if (backend.child.exitCode !== null) await backend.done;
      if ((await probeHealth(lavishPort, 500)) === "ok") break;
      if (attempt >= 60) throw new Error("Lavish 启动未就绪");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await access(file);
    } catch {
      await writeFile(
        file,
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Sprout Human Review</title></head><body><main><h1>Sprout Human Review</h1><p>可信本地应用预览的会话锚点，页面实现在 Sprout 仓库。</p></main></body></html>',
      );
    }
    const opened = await cli([file, "--no-open", "--no-gate"]);
    if (!opened.session?.url)
      throw new Error("Lavish 会话没有返回 URL；可能已由用户结束，请显式创建新 review");
    key = new URL(opened.session.url).pathname.split("/").pop();
    reviewUrl = `${origin}/session/${key}?no-gate=1`;
    const descriptor = {
      pid: process.pid,
      lavishBin: bin,
      url: reviewUrl,
      appUrl: app.href,
      ports: { port, lavishPort, adjusted: chosen.shifted },
      file,
      stateDir: state,
      env: {
        LAVISH_AXI_HOST: env.LAVISH_AXI_HOST,
        LAVISH_AXI_PORT: env.LAVISH_AXI_PORT,
        LAVISH_AXI_STATE_DIR: env.LAVISH_AXI_STATE_DIR,
      },
    };
    await writeFile(path.join(state, "session.json"), JSON.stringify(descriptor, null, 2) + "\n");
    return { ...descriptor, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
