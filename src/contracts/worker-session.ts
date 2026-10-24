import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { machineIdSchema, positiveSafeIntegerSchema } from "./machine";

export const workerSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const workerSessionSchema = z.strictObject({
  machineId: machineIdSchema,
  generation: positiveSafeIntegerSchema,
  bootId: z.string().regex(appIdPattern(ID_PREFIXES.boot)),
  attemptId: z.uuidv4(),
});
export type WorkerSession = z.infer<typeof workerSessionSchema>;
