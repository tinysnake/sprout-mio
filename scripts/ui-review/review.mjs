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

export function localAppUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("预览只接受 http://localhost、127.0.0.1 或 [::1] 的本地应用 URL");
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
    '<script src="/sprout-review.js"></script><script src="/chrome-client.js"',
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

function allowedRequest(req, origin) {
  return (
    req.headers.host === new URL(origin).host &&
    (!req.headers.origin || req.headers.origin === origin)
  );
}

export async function startReview({
  url,
  port = 4400,
  lavishPort = 4401,
  stateDir,
  onStatus = () => {},
}) {
  const app = localAppUrl(url);
  for (const number of [port, lavishPort]) {
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new Error("端口必须在 1–65535 之间");
  }
  if (new Set([port, lavishPort, Number(app.port || 80)]).size !== 3)
    throw new Error("应用、review 和 Lavish 必须使用不同端口");
  const origin = `http://${app.hostname}:${port}`;
  const upstream = `http://127.0.0.1:${lavishPort}`;
  const state = path.resolve(stateDir || `.verify/ui-review/${port}`);
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
    activePoll,
    pollLoop,
    closed = false;
  let key = "",
    reviewUrl = "";
  const sockets = new Set();
  const stop = async () => {
    if (closed) return;
    closed = true;
    await terminate(activePoll?.child);
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await terminate(backend?.child);
  };
  const cli = async (args) => {
    const result = await exec(bin, args, { env, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return decode(result.stdout);
  };
  try {
    try {
      await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(500) });
      throw new Error(`Lavish 端口 ${lavishPort} 已占用；请换端口，不接管其他进程`);
    } catch (error) {
      if (!error.cause && error.name !== "TimeoutError") throw error;
      if (error.name === "TimeoutError")
        throw new Error(`Lavish 端口 ${lavishPort} 未响应；请换端口`);
    }
    server = createServer(async (req, res) => {
      if (!allowedRequest(req, origin)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const pathname = new URL(req.url, origin).pathname;
      if (pathname === "/") {
        res.writeHead(302, { location: reviewUrl }).end();
        return;
      }
      if (pathname === "/sprout-review.js") {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        res.end(await readFile(path.join(here, "browser.js"), "utf8"));
        return;
      }
      const headers = {
        ...req.headers,
        host: new URL(upstream).host,
        "accept-encoding": "identity",
      };
      if (headers.origin) headers.origin = upstream;
      if (headers.referer?.startsWith(origin + "/"))
        headers.referer = upstream + headers.referer.slice(origin.length);
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
      if (!allowedRequest(req, origin)) {
        socket.destroy();
        return;
      }
      const remote = connect(lavishPort, "127.0.0.1", () => {
        const headers = { ...req.headers, host: new URL(upstream).host, origin: upstream };
        remote.write(
          `${req.method} ${req.url} HTTP/1.1\r\n` +
            Object.entries(headers)
              .map(([k, v]) => `${k}: ${v}`)
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
      server.once("error", reject);
      server.listen(port, app.hostname.replace(/^\[|\]$/g, ""), resolve);
    });
    backend = spawnCaptured(bin, ["server", "--port", String(lavishPort)], env);
    for (let attempt = 0; ; attempt++) {
      if (backend.child.exitCode !== null) await backend.done;
      try {
        const result = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(500) });
        if (result.ok) break;
      } catch {}
      if (attempt >= 60) throw new Error("Lavish 启动未就绪");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await access(file);
    } catch {
      await writeFile(
        file,
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Sprout UI Review</title></head><body><main><h1>Sprout UI Review</h1><p>可信本地应用预览的会话锚点，页面实现在 Sprout 仓库。</p></main></body></html>',
      );
    }
    const opened = await cli([file, "--no-open", "--no-gate"]);
    if (!opened.session?.url)
      throw new Error("Lavish 会话没有返回 URL；可能已由用户结束，请显式创建新 review");
    key = new URL(opened.session.url).pathname.split("/").pop();
    reviewUrl = `${origin}/session/${key}?no-gate=1`;
    const descriptor = {
      url: reviewUrl,
      appUrl: app.href,
      file,
      stateDir: state,
      env: {
        LAVISH_AXI_HOST: env.LAVISH_AXI_HOST,
        LAVISH_AXI_PORT: env.LAVISH_AXI_PORT,
        LAVISH_AXI_STATE_DIR: env.LAVISH_AXI_STATE_DIR,
      },
    };
    await writeFile(path.join(state, "session.json"), JSON.stringify(descriptor, null, 2) + "\n");
    const watch = (onFeedback) => {
      if (pollLoop) throw new Error("当前 review 已有监听器");
      pollLoop = (async () => {
        while (!closed) {
          activePoll = spawnCaptured(bin, ["poll", file], env);
          let result;
          try {
            result = await activePoll.done;
          } catch (error) {
            if (!closed) onStatus(error.message);
            break;
          }
          if (closed) break;
          const response = decode(result.stdout);
          const receipt = path.join(state, `feedback-${Date.now()}.json`);
          await writeFile(receipt, JSON.stringify(response, null, 2) + "\n");
          await onFeedback(response, receipt);
          if (response.session?.status !== "feedback" || response.session?.session_ended) break;
        }
      })().catch((error) => onStatus(error.message));
      return pollLoop;
    };
    return {
      ...descriptor,
      stop,
      watch,
      reply: (text) => cli(["reply", file, "--agent-reply", text]),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
