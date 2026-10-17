import { z } from "zod";

/** 边界校验拒绝空白名称与超长文本，description 可以省略。 */
export const createProjectInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
});
/** 由边界 schema 推导，输入规则与消费者的字段形状保持一致。 */
export type CreateProjectInput = z.infer<typeof createProjectInput>;

/** Project 的 ID 和 ISO 时间在边界解析，缺失字段或非法日期不能通过。 */
export const projectSchema = createProjectInput.extend({
  id: z.string().regex(/^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
/** 字段形状由 schema 推导，文本与日期约束在解析时保证。 */
export type Project = z.infer<typeof projectSchema>;
