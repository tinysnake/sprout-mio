import { createHash } from "node:crypto";

export function delegationClientRequestId(
  leadRunId: string,
  workerProfileId: string,
  request: string,
): string {
  // Within one lead run, identical text + member means the same dispatch intent.
  // Changing request creates a new intent; an explicit clientRequestId can override this.
  return createHash("sha256")
    .update(JSON.stringify([leadRunId, workerProfileId, request]))
    .digest("hex");
}
