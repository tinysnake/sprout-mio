import { removeProjectMember } from "../../src/domain/agent";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
process.on("message", (input: { projectId: string; agentProfileId: string; userId: string }) => {
  try {
    removeProjectMember(input.projectId, input.agentProfileId, {
      userId: input.userId,
      requestId: newId(ID_PREFIXES.request),
    });
    process.send?.({ ok: true });
    process.disconnect();
  } catch (error) {
    process.send?.({ ok: false, error: String(error) });
    process.disconnect();
    process.exitCode = 1;
  }
});
process.send?.("ready");
