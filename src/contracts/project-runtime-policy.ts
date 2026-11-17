import { z } from "zod";

import { leaseTimeoutsSchema } from "./lease-timeout";
import { runAttentionPolicySchema } from "./run-attention";

/**
 * Project 级运行时限覆盖：只给部署与验收直接写库使用，不暴露产品界面。
 * 省略字段时，读取方分别回落到租约与运行注意力的默认时限。
 */
export const projectRuntimePolicySchema = z.strictObject({
  leaseTimeouts: leaseTimeoutsSchema.optional(),
  runAttention: runAttentionPolicySchema.optional(),
});
export type ProjectRuntimePolicy = z.infer<typeof projectRuntimePolicySchema>;
