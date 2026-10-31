import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

export { fieldErrorsFrom } from "./field-errors";

export const agentProfileIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.agentProfile));
const name = z.string().trim().min(1, "名称不能为空").max(80, "名称最多 80 字");
const jobTitle = z.string().trim().max(40, "职位最多 40 字");
const persona = z.string().max(2000, "人设最多 2000 字");
const harness = z.literal("pi");
const option = z.string().trim().min(1).max(200);

export const createAgentProfileInput = z.object({
  name,
  jobTitle: jobTitle.optional(),
  persona: persona.default(""),
  harness: harness.default("pi"),
  model: option.optional(),
  effort: option.optional(),
});
export type CreateAgentProfileInput = z.infer<typeof createAgentProfileInput>;

export const updateAgentProfileInput = z.object({
  name: name.optional(),
  jobTitle: jobTitle.nullable().optional(),
  persona: persona.optional(),
  harness: harness.optional(),
  model: option.nullable().optional(),
  effort: option.nullable().optional(),
});
export type UpdateAgentProfileInput = z.infer<typeof updateAgentProfileInput>;

export const agentProfileSchema = createAgentProfileInput.extend({
  id: agentProfileIdSchema,
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const addProjectMemberInput = z.object({
  projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
  agentProfileId: agentProfileIdSchema,
});
export const projectMemberSchema = addProjectMemberInput.extend({
  addedBy: z.string().min(1),
  addedAt: z.iso.datetime(),
});
export type AddProjectMemberInput = z.infer<typeof addProjectMemberInput>;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type AgentResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
