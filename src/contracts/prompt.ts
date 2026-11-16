import { z } from "zod";
import { projectKindSchema } from "./project";

export const projectContextSchema = z.object({ kind: projectKindSchema });
export type ProjectContext = z.infer<typeof projectContextSchema>;

/**
 * 一次运行的处境：它是 `profile` 的兄弟字段，由服务端在 open 边界从 run 自身的
 * 记录认定，不由队列里的选择或调用方声明。字段里不带任何项目信息。
 *
 * - `assistant`：个人助理运行；
 * - `dm_worker`：DM 或 Crew 之外的工作 Agent 运行；
 * - `crew_lead`：Crew 里对得上当前 lead 的运行，带 Crew 展示名；
 * - `delegation_worker`：某次委派的 worker 运行，带委派 id 与 lead 名。
 *
 * `crewName` 可能为空（Crew 标题可选，读模型回落到参与者名字），读取侧要用
 * 同一份回落链归一后再展示。
 */
export const situationSchema = z.object({
  kind: z.enum(["assistant", "dm_worker", "crew_lead", "delegation_worker"]),
  crewName: z.string().optional(),
  leadName: z.string().optional(),
  delegationId: z.string().optional(),
});
export type Situation = z.infer<typeof situationSchema>;
