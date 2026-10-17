import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";

const gitRemote = z.url();
const defaultBranch = z.string().trim().min(1, "分支不能为空").max(200);
const workDirectory = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.startsWith("~") &&
      !value.split("/").includes(".."),
    "工作目录必须是相对路径，不能包含 ..、反斜杠、冒号或用户目录缩写",
  );

export const updateProjectProfileInput = z.object({
  gitRemote: gitRemote.nullable().optional(),
  defaultBranch: defaultBranch.optional(),
  workDirectory: workDirectory.nullable().optional(),
});
export type UpdateProjectProfileInput = z.infer<typeof updateProjectProfileInput>;

export const projectProfileSchema = z.object({
  projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
  gitRemote: gitRemote.optional(),
  defaultBranch,
  workDirectory: workDirectory.optional(),
  updatedAt: z.iso.datetime(),
});
export type ProjectProfile = z.infer<typeof projectProfileSchema>;
