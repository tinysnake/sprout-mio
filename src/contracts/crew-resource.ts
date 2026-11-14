import { z } from "zod";

export const crewResourceScopeSchema = z
  .object({
    machineId: z.string().min(1),
    membershipEpoch: z.number().int().positive(),
    directoryRealPath: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => v.startsWith("/") && !v.includes("\0") && !v.split("/").includes("..")),
    directoryRevision: z.number().int().positive(),
    operations: z.array(z.enum(["shell", "file_read", "file_write", "file_edit"])).min(1),
  })
  .strict();
export const crewResourceRequestSchema = crewResourceScopeSchema
  .extend({
    crewChatId: z.string().min(1),
    crewEpoch: z.number().int().nonnegative(),
    subjectKind: z.enum(["delegation", "lead_run"]),
    delegationId: z.string().min(1).optional(),
    attempt: z.number().int().positive().optional(),
    runId: z.string().min(1),
    clientRequestId: z.string().min(1).max(256),
  })
  .strict();
export const crewResourceDecisionSchema = z
  .object({
    resourceRequestId: z.string().min(1),
    crewEpoch: z.number().int().nonnegative(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const crewResourceReleaseSchema = z
  .object({ resourceRequestId: z.string().min(1) })
  .strict();
export const crewResourceCallSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("request"), input: crewResourceRequestSchema }).strict(),
  z.object({ op: z.literal("approve"), input: crewResourceDecisionSchema }).strict(),
  z.object({ op: z.literal("revoke"), input: crewResourceDecisionSchema }).strict(),
  z.object({ op: z.literal("release"), input: crewResourceReleaseSchema }).strict(),
]);
export type CrewResourceRequestInput = z.infer<typeof crewResourceRequestSchema>;
export type CrewResourceDecisionInput = z.infer<typeof crewResourceDecisionSchema>;
