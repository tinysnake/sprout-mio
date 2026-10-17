import { z } from "zod";
import type { AppResult } from "./result";

/** 边界校验拒绝空白名称与超长文本，description 可以省略，错误消息直接展示在输入旁。 */
export const createProjectInput = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(80, "名称最多 80 字"),
  description: z.string().max(500, "描述最多 500 字").optional(),
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

/** 字段级校验错误：键为输入字段名，值为可直接展示的消息。 */
export type FieldErrors = Record<string, string>;
/** Project 边界结果：AppResult 加可选的字段级错误，失败时供表单显示在输入旁。 */
export type ProjectResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };

/** 详情页与查询从 URL 取 id，空字符串在边界拒绝。 */
export const projectIdInput = z.object({ projectId: z.string().min(1) });

/** 同一字段只保留第一条消息，路径为空的错误归到 `form`。 */
export function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "form";
    errors[field] ??= issue.message;
  }
  return errors;
}
