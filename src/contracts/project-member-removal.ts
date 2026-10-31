import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";

const id = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(appIdPattern(prefix));

export const projectMemberRemovalBlockerKindSchema = z.enum([
  "active_runs",
  "leases",
  "owner_duties",
  "dm_assigned_tasks",
]);
export const projectMemberRemovalChatRefSchema = z.object({
  chatId: id(ID_PREFIXES.chat),
  chatKind: z.enum(["dm", "group", "public_channel"]),
  title: z.string().nullable(),
});
export const projectMemberRemovalRunRefSchema = z.object({
  runId: id(ID_PREFIXES.run),
  instanceId: id(ID_PREFIXES.instance),
  status: z.enum(["queued", "running"]),
  chat: projectMemberRemovalChatRefSchema,
});
export const projectMemberRemovalLeaseRefSchema = z.object({
  key: z.object({ projectId: id(ID_PREFIXES.project), machineId: id(ID_PREFIXES.machine) }),
  machineName: z.string(),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["held", "fencing"]),
  holderInstanceId: id(ID_PREFIXES.instance),
  pendingMutationId: id(ID_PREFIXES.leaseMutation).nullable(),
  relation: z.enum(["holder", "handoff_target"]),
});
export const projectMemberRemovalOwnerRefSchema = z.object({
  chat: projectMemberRemovalChatRefSchema.extend({ chatKind: z.enum(["group", "public_channel"]) }),
});
export const projectMemberRemovalTaskRefSchema = z.object({
  taskId: id(ID_PREFIXES.task),
  title: z.string(),
  status: z.literal("assigned"),
  chat: projectMemberRemovalChatRefSchema.extend({ chatKind: z.literal("dm") }),
});
export const projectMemberRemovalBlockerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("active_runs"),
    items: z.array(projectMemberRemovalRunRefSchema).nonempty(),
  }),
  z.object({
    kind: z.literal("leases"),
    items: z.array(projectMemberRemovalLeaseRefSchema).nonempty(),
  }),
  z.object({
    kind: z.literal("owner_duties"),
    items: z.array(projectMemberRemovalOwnerRefSchema).nonempty(),
  }),
  z.object({
    kind: z.literal("dm_assigned_tasks"),
    items: z.array(projectMemberRemovalTaskRefSchema).nonempty(),
  }),
]);
export const projectMemberRemovalBlockersSchema = z
  .object({
    projectId: id(ID_PREFIXES.project),
    agentProfileId: id(ID_PREFIXES.agentProfile),
    blockers: z.array(projectMemberRemovalBlockerSchema).nonempty(),
  })
  .superRefine((value, ctx) => {
    let previous = -1;
    for (const [index, blocker] of value.blockers.entries()) {
      const position = projectMemberRemovalBlockerKindSchema.options.indexOf(blocker.kind);
      if (position <= previous)
        ctx.addIssue({
          code: "custom",
          path: ["blockers", index, "kind"],
          message: "阻塞分组必须唯一且按固定顺序排列",
        });
      previous = position;
      if (blocker.kind === "leases")
        for (const [itemIndex, item] of blocker.items.entries())
          if (item.key.projectId !== value.projectId)
            ctx.addIssue({
              code: "custom",
              path: ["blockers", index, "items", itemIndex, "key", "projectId"],
              message: "租约必须属于当前 Project",
            });
    }
  });
export const projectMemberRemovalBlockedErrorSchema = z.object({
  code: z.literal("project_member_removal_blocked"),
  message: z.string(),
  requestId: z.string(),
  details: projectMemberRemovalBlockersSchema,
});
export type ProjectMemberRemovalBlockerKind = z.infer<typeof projectMemberRemovalBlockerKindSchema>;
export type ProjectMemberRemovalChatRef = z.infer<typeof projectMemberRemovalChatRefSchema>;
export type ProjectMemberRemovalRunRef = z.infer<typeof projectMemberRemovalRunRefSchema>;
export type ProjectMemberRemovalLeaseRef = z.infer<typeof projectMemberRemovalLeaseRefSchema>;
export type ProjectMemberRemovalOwnerRef = z.infer<typeof projectMemberRemovalOwnerRefSchema>;
export type ProjectMemberRemovalTaskRef = z.infer<typeof projectMemberRemovalTaskRefSchema>;
export type ProjectMemberRemovalBlocker = z.infer<typeof projectMemberRemovalBlockerSchema>;
export type ProjectMemberRemovalBlockers = z.infer<typeof projectMemberRemovalBlockersSchema>;
export type ProjectMemberRemovalBlockedError = z.infer<
  typeof projectMemberRemovalBlockedErrorSchema
>;
