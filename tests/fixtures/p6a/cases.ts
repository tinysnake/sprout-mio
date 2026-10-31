import { readFileSync } from "node:fs";
import { z } from "zod";
import { wakeEvaluationInputSchema } from "../../../src/contracts/wake-evaluation";
import type { WakeSnapshotFacts } from "../../../src/domain/wake-evaluation";

const fixtureSchema = z.strictObject({
  id: z.string(),
  source: z.strictObject({
    path: z.string(),
    id: z.string(),
    sha256: z.string(),
    adaptation: z.string(),
  }),
  covers: z.array(z.string()),
  now: z.iso.datetime(),
  facts: z.custom<WakeSnapshotFacts>(),
  input: wakeEvaluationInputSchema.nullable(),
  expected: z.strictObject({
    preparation: z.enum(["model", "rule", "skipped"]),
    candidates: z.array(z.string()),
    selected: z.array(z.string()),
    sideEffects: z.strictObject({
      runs: z.literal(0),
      messages: z.literal(0),
      inputs: z.literal(0),
    }),
    providerCalls: z.number().int().nonnegative(),
  }),
});
export const loadWakeCases = () =>
  z
    .array(fixtureSchema)
    .parse(JSON.parse(readFileSync(new URL("./zh-wake.json", import.meta.url), "utf8")));
