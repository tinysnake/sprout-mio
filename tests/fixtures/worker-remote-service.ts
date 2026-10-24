// Private IPC harness: starts the actual production service and calls only the
// server-owned grant issuer. No public grant-issuance endpoint is introduced.
import { PiSessionProcess } from "../../src/server/pi-host/process";
import { issueRemoteToolGrant, revokeRemoteToolGrant } from "../../src/server/remote-agent-gateway";
import { machineRuntimeContext } from "../../src/server/runtime";
import { newId, ID_PREFIXES } from "../../src/contracts/ids";

const runners = new Map<string, PiSessionProcess>();
process.on(
  "message",
  async (message: { id: string; action: "issue" | "revoke" | "cleanup"; runId?: string }) => {
    try {
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
  },
);
const entry = new URL("../../.output/server/index.mjs", import.meta.url);
await import(entry.href);
