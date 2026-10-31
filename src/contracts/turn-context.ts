import { z } from "zod";
import { runIdSchema } from "./agent-run";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { turnStartContextSchema } from "./info-hub";

/** The host resolves the remaining identity from agent_run, never from a Chat's first instance. */
export const turnContextReadInputSchema = z.strictObject({
  projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
  runId: runIdSchema,
});
export type TurnContextReadInput = z.infer<typeof turnContextReadInputSchema>;

/** One record per run, immutable text/hash/identity; only its delivery receipt can advance. */
export const turnContextRecordSchema = turnStartContextSchema;
export type TurnContextRecord = z.infer<typeof turnContextRecordSchema>;

export const turnContextReadResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("captured"), record: turnContextRecordSchema }),
  turnContextReadInputSchema.extend({ kind: z.literal("not_captured") }),
]);
export type TurnContextReadResult = z.infer<typeof turnContextReadResultSchema>;

/** The runner prepends this once to the admitted run input at the SDK prompt boundary. */
export const turnContextPromptInputSchema = z.strictObject({
  runId: runIdSchema,
  contentHash: turnStartContextSchema.shape.contentHash,
  serializedText: turnStartContextSchema.shape.serializedText,
});
export type TurnContextPromptInput = z.infer<typeof turnContextPromptInputSchema>;

export const turnContextSubmissionReceiptSchema = z.strictObject({
  runId: runIdSchema,
  contentHash: turnStartContextSchema.shape.contentHash,
  submittedAt: z.iso.datetime(),
});
export type TurnContextSubmissionReceipt = z.infer<typeof turnContextSubmissionReceiptSchema>;
export const turnContextSubmittedEventSchema = turnContextSubmissionReceiptSchema.extend({
  type: z.literal("turn_context_submitted"),
});
export type TurnContextSubmittedEvent = z.infer<typeof turnContextSubmittedEventSchema>;

export const turnContextConfirmedSubmissionSchema = z
  .strictObject({
    record: turnContextRecordSchema,
    receipt: turnContextSubmissionReceiptSchema,
  })
  .refine(
    ({ record, receipt }) =>
      record.deliveryState === "submitted" &&
      record.runId === receipt.runId &&
      record.contentHash === receipt.contentHash &&
      record.submittedAt === receipt.submittedAt,
    "Submitted snapshot must match the SDK receipt's run, fingerprint and time",
  );
export type TurnContextConfirmedSubmission = z.infer<typeof turnContextConfirmedSubmissionSchema>;
