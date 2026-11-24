// 诊断模块：记录进程内的监听与连接目标地址，用于定位 prerender 在容器里连不上
// `http://localhost:3000/` 的原因（服务器绑定的地址族 vs 客户端连接的地址族）。
//
// 启用方式（只在诊断轮次使用，正常验证流程不受影响）：
//   SPROUT_DIAG_NET=1 NODE_OPTIONS="--import ./scripts/verify/lib/diag-net.mjs" \
//     node scripts/verify/prepare.mjs server --fresh
//
// 不设 SPROUT_DIAG_NET 时本模块什么都不做。容器问题定位完成后应删除本文件。
import dns from "node:dns";
import net from "node:net";
import os from "node:os";

const enabled = process.env.SPROUT_DIAG_NET === "1";
const interestedPort = Number(process.env.SPROUT_DIAG_NET_PORT ?? 3000);
const tag = `[net ${process.pid}]`;

function describe(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function callSite() {
  const lines = (new Error().stack ?? "").split("\n").slice(2, 6).map((line) => line.trim());
  return lines.join(" | ");
}

function report(message) {
  console.log(`${tag} ${message}`);
}

// listen() 支持 (port)、({port, host})、(port, host)、(port, host, backlog) 等形式。
function readListenTarget(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return { port: first.port, host: first.host ?? first.path ?? null };
  }
  if (typeof first === "number") {
    return { port: first, host: typeof args[1] === "string" ? args[1] : null };
  }
  return { port: null, host: typeof first === "string" ? first : null };
}

// connect() 支持 ({port, host})、(port, host)、(path) 等形式。
function readConnectTarget(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return { port: first.port, host: first.host ?? first.path ?? null, family: first.family };
  }
  if (typeof first === "number") {
    return { port: first, host: typeof args[1] === "string" ? args[1] : null, family: undefined };
  }
  return { port: null, host: typeof first === "string" ? first : null, family: undefined };
}

function instrument() {
  report(
    `start cpus=${os.cpus().length} resultOrder=${dns.getDefaultResultOrder?.() ?? "unknown"} autoSelectFamily=${describe(net.getDefaultAutoSelectFamily?.())} HOST=${describe(process.env.HOST ?? null)} PORT=${describe(process.env.PORT ?? null)} NITRO_HOST=${describe(process.env.NITRO_HOST ?? null)} NITRO_PORT=${describe(process.env.NITRO_PORT ?? null)}`,
  );
  dns.lookup("localhost", { all: true, verbatim: true }, (error, addresses) => {
    report(`dns.lookup(localhost, verbatim) ${error ? String(error) : describe(addresses)}`);
  });
  dns.lookup("localhost", { all: true }, (error, addresses) => {
    report(`dns.lookup(localhost) ${error ? String(error) : describe(addresses)}`);
  });

  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(...args) {
    const target = readListenTarget(args);
    report(`listen(${args.map(describe).join(", ")}) [${this.constructor?.name}] target=${describe(target)} <- ${callSite()}`);
    // prepend：Vite 的探测套接字会在自己的 'listening' 处理器里立刻 close()，晚挂的处理器只会读到 null。
    this.prependOnceListener("listening", () => report(`listening ${describe(this.address())}`));
    this.once("error", (error) => report(`listen error ${error?.code} ${error?.message}`));
    return originalListen.apply(this, args);
  };

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    const target = readConnectTarget(args);
    const host = typeof target.host === "string" ? target.host : "";
    if (target.port === interestedPort || host.toLowerCase().includes("localhost")) {
      report(`connect ${describe(target)} <- ${callSite()}`);
      this.once("connect", () => report(`connected ${describe(this.remoteAddress)}:${describe(this.remotePort)}`));
      this.once("error", (error) =>
        report(`connect error target=${describe(target)} code=${error?.code} address=${describe(error?.address)} port=${describe(error?.port)} message=${error?.message}`),
      );
    }
    return originalConnect.apply(this, args);
  };

  // 兜底：如果 Node 的 net/undici 在加载时就绑定了 dns.lookup，这个包装不会生效，但不会有副作用。
  const originalLookup = dns.lookup;
  dns.lookup = function patchedLookup(hostname, options, callback) {
    let lookupOptions = options;
    let lookupCallback = callback;
    if (typeof options === "function") {
      lookupCallback = options;
      lookupOptions = {};
    }
    if (String(hostname).toLowerCase().includes("localhost")) {
      report(`dns.lookup(${describe(hostname)}, ${describe(lookupOptions)}) <- ${callSite()}`);
      const wrapped = (...result) => {
        report(`dns.lookup result ${describe(hostname)} -> ${describe(result[0] ?? null)} ${describe(result[1] ?? null)}`);
        return lookupCallback(...result);
      };
      return originalLookup.call(dns, hostname, lookupOptions, wrapped);
    }
    return originalLookup.call(dns, hostname, lookupOptions, lookupCallback);
  };
}

if (enabled) {
  try {
    instrument();
  } catch (error) {
    console.log(`${tag} diag-net failed`, error);
  }
}
