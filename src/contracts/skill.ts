import { z } from "zod";
import { isSkillName } from "../lib/skill-token";

export const skillNameSchema = z.string().refine(isSkillName, "无法表示的技能名称");
export type SkillName = z.infer<typeof skillNameSchema>;
export const skillOptionSchema = z.object({ name: skillNameSchema, description: z.string() });
export type SkillOption = z.infer<typeof skillOptionSchema>;
export const messageSkillSpanSchema = z.object({
  name: skillNameSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).refine((span) => span.end > span.start);
export type MessageSkillSpan = Readonly<z.infer<typeof messageSkillSpanSchema>>;
export const chatSkillChoicesSchema = z.object({
  state: z.enum(["ready", "disabled", "unavailable"]),
  items: z.array(skillOptionSchema),
});
export type ChatSkillChoices = z.infer<typeof chatSkillChoicesSchema>;
export type InheritedResources =
  | { kind: "disabled" }
  | { kind: "enabled"; skillRevision: string; skillPaths: readonly string[]; promptPaths: readonly string[] };
