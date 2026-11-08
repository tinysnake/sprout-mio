import { eq } from "drizzle-orm";
import type { AutomationSource } from "../contracts/automation";
import { db } from "../db";
import { webhookTrigger } from "../db/schema";

export function automationSourceFor(triggerId: string): AutomationSource {
  const trigger = db.select().from(webhookTrigger).where(eq(webhookTrigger.id, triggerId)).get();
  if (!trigger) throw new Error("automation_message_corrupt");
  if (trigger.source === "webhook") return { kind: "project_webhook", triggerId };
  if (!trigger.snapshot.cron) throw new Error("cron_receipt_corrupt");
  return {
    kind: "project_cron",
    triggerId,
    ...trigger.snapshot.cron,
    instruction: trigger.snapshot.instruction,
    mode: trigger.mode,
  };
}
