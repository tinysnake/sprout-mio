import { z } from "zod";
import type { AppResult } from "./result";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { projectWakePolicySchema, wakeProviderSchema } from "./wake-evaluation";

const projectIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.project));

/** 边界校验拒绝空白名称与超长文本，description 可以省略，错误消息直接展示在输入旁。 */
export const createProjectInput = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(80, "名称最多 80 字"),
  description: z.string().max(500, "描述最多 500 字").optional(),
});
/** 由边界 schema 推导，输入规则与消费者的字段形状保持一致。 */
export type CreateProjectInput = z.infer<typeof createProjectInput>;

/** 改名与改描述，两者都可单独提交；空对象在边界被拒，避免无意义的事务。 */
export const updateProjectInput = z
  .object({
    name: z.string().trim().min(1, "名称不能为空").max(80, "名称最多 80 字").optional(),
    description: z.string().max(500, "描述最多 500 字").nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "至少提交一个字段",
  });
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

/** Public provider readiness, without credentials or configuration secrets. */
export const wakeProviderAvailabilitySchema = z
  .strictObject({
    provider: wakeProviderSchema,
    configured: z.boolean(),
    available: z.boolean(),
    unavailableReason: z
      .enum(["missing_credentials", "missing_model", "provider_unavailable"])
      .nullable(),
  })
  .refine(
    (value) =>
      value.available
        ? value.configured && value.unavailableReason === null
        : value.unavailableReason !== null,
    "Unavailable provider requires a reason; available provider must be configured",
  );
export type WakeProviderAvailability = z.infer<typeof wakeProviderAvailabilitySchema>;

/** Model and credentials are server configuration; Human selects only the provider. */
export const updateProjectWakePolicyInputSchema = z.strictObject({
  projectId: projectIdSchema,
  provider: wakeProviderSchema,
  expectedConfigRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().regex(appIdPattern(ID_PREFIXES.request)),
});
export type UpdateProjectWakePolicyInput = z.infer<typeof updateProjectWakePolicyInputSchema>;

/** Project 的 ID 和 ISO 时间在边界解析，缺失字段或非法日期不能通过。 */
export const projectSchema = createProjectInput.extend({
  id: projectIdSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  wakePolicy: projectWakePolicySchema.optional(),
  wakeProviderAvailability: z.array(wakeProviderAvailabilitySchema).optional(),
});
/** 字段形状由 schema 推导，文本与日期约束在解析时保证。 */
export type Project = z.infer<typeof projectSchema>;

/** 字段级校验错误：键为输入字段名，值为可直接展示的消息。 */
export type FieldErrors = Record<string, string>;
/** Project 边界结果：AppResult 加可选的字段级错误，失败时供表单显示在输入旁。 */
export type ProjectResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };

/** 详情页与查询从 URL 取 id，使用完整 Project 相同的 ID 格式。 */
export const projectIdInput = z.object({ projectId: projectIdSchema });

/** 同一字段只保留第一条消息，路径为空的错误归到 `form`。 */
export function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "form";
    errors[field] ??= issue.message;
  }
  return errors;
}
