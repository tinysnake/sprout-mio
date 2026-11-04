import { z } from "zod";

/**
 * 工具参数的 JSON Schema 归一化。OpenAI 兼容上游要求 `function.parameters` 的根是
 * `type: "object"`，否则整轮请求被 400 拒绝、Pi 报 `model_error`（magpie 的 babybus-hs
 * 上游即如此）。`z.discriminatedUnion` 经 `z.toJSONSchema` 只在根上输出 `oneOf`，
 * 这里补上缺失的根类型；分支各自仍是 strict object，联合语义不变。
 */
export function objectToolParameters(
  schema: z.ZodType,
  params: NonNullable<Parameters<typeof z.toJSONSchema>[1]> = {},
): Record<string, unknown> {
  const json: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { target: "draft-7", io: "input", ...params }),
  };
  const branches = (json.oneOf ?? json.anyOf) as Array<{ type?: unknown }> | undefined;
  const isObjectUnion =
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every((branch) => branch.type === "object");
  return json.type === undefined && isObjectUnion ? { ...json, type: "object" } : json;
}
