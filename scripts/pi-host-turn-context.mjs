import { createHash } from "node:crypto";

/** The SDK's agent_start event acknowledges admission; a rejected prompt has no receipt. */
export async function promptWithTurnContext(session, command, schema, submitted, onReceipt) {
  const context = schema.parse(command.turnContext);
  const hash = createHash("sha256").update(context.serializedText).digest("hex");
  if (context.runId !== command.id || context.contentHash !== hash || submitted.has(context.runId))
    throw new Error("Invalid or repeated turn context");
  let acknowledged = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "agent_start" || acknowledged) return;
    acknowledged = true;
    submitted.add(context.runId);
    onReceipt({
      type: "turn_context_submitted",
      id: command.id,
      runId: context.runId,
      contentHash: context.contentHash,
      submittedAt: new Date().toISOString(),
    });
  });
  try {
    await session.prompt(`${context.serializedText}\n\n${command.text}`, {
      expandPromptTemplates: false,
      source: "rpc",
    });
    if (!acknowledged) throw new Error("SDK did not acknowledge turn context");
  } finally {
    unsubscribe();
  }
}
