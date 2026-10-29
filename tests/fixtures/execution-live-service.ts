// Private IPC harness for the p4c live e2e fixture: starts the actual production
// service, and exposes only server-owned operations to the fixture process:
// grant issuance/revocation and the Web cancel boundary with a real session cookie.
// No public endpoint is added and no private row is written by hand.
import { PiSessionProcess } from "../../src/server/pi-host/process";
import { issueRemoteToolGrant, revokeRemoteToolGrant } from "../../src/server/remote-agent-gateway";
import { machineRuntimeContext } from "../../src/server/runtime";
import { newId, ID_PREFIXES } from "../../src/contracts/ids";

const runners = new Map<string, PiSessionProcess>();
type Message = {
  id: string;
  action: "issue" | "revoke" | "cleanup" | "human_cancel";
  runId?: string;
  raw?: unknown;
  cookie?: string;
  requestId?: string;
};
process.on("message", async (message: Message) => {
  try {
    if (message.action === "human_cancel") {
      // 与 Web 页面同一条服务端入口：真实登录 cookie → requireSession → cancelExecution。
      const { cancelExecutionBoundary } = await import("../../src/server/functions/remote");
      const headers = new Headers(message.cookie ? { cookie: message.cookie } : {});
      const result = await cancelExecutionBoundary(
        message.raw,
        headers,
        message.requestId ?? newId(ID_PREFIXES.request),
      );
      process.send?.({ id: message.id, ok: true, result });
      return;
    }
    const ctx = { ...(await machineRuntimeContext()), requestId: newId(ID_PREFIXES.request) };
    if (message.action === "issue" && message.runId) {
      // Fixture grants are issued while queued just like production executeRun;
      // the controller then explicitly transitions the fixture run to running.
      const runner = new PiSessionProcess(message.runId);
      const grant = issueRemoteToolGrant(message.runId, runner, ctx);
      runners.set(message.runId, runner);
      process.send?.({ id: message.id, ok: true, grant });
    } else if (message.action === "revoke" && message.runId) {
      revokeRemoteToolGrant(message.runId, ctx);
      process.send?.({ id: message.id, ok: true });
    } else if (message.action === "cleanup") {
      for (const [runId, runner] of runners) {
        revokeRemoteToolGrant(runId, ctx);
        await runner.close();
      }
      runners.clear();
      process.send?.({ id: message.id, ok: true });
    } else process.send?.({ id: message.id, ok: false });
  } catch {
    process.send?.({ id: message.id, ok: false });
  }
});
const entry = new URL("../../.output/server/index.mjs", import.meta.url);
await import(entry.href);
