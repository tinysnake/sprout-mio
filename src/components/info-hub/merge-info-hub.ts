import type { ChatInfoView, ProjectInfoHub } from "../../contracts/info-hub";
import type { InfoHubView } from "../../contracts/info-hub-query";

/**
 * 刷新结果只覆盖它真正回答的那一节，其余事实继续来自 loader。
 *
 * 这里刻意不做「拼合出一个看起来更完整的新视图」：`refreshInfoHub` 一次只回答一个
 * 有界的视角 + 节，缺的部分如果拿旧事实填空又不标注，读者会以为它们一起刷新过。
 * 所以两个 merge 都只替换同 scope 的那一部分，并用 scope 校验挡住越界的结果。
 */

/** Chat 页刷新的是「活动 run」：只替换 `runs.active`，历史 run 与成员/消息仍取 loader。 */
export function mergeChatRuns(info: ChatInfoView, view: InfoHubView | null): ChatInfoView {
  if (
    !view ||
    view.view !== "chat" ||
    view.section !== "runs" ||
    view.chatId !== info.chatId ||
    view.projectId !== info.projectId ||
    !Array.isArray(view.data)
  )
    return info;
  return { ...info, runs: { ...info.runs, available: true, active: view.data } };
}

/** Chats 列表页刷新的是「Chats」一节：会话聚合（活动 run、状态分布、任务计数）随它更新。 */
export function mergeProjectChats(hub: ProjectInfoHub, view: InfoHubView | null): ProjectInfoHub {
  if (
    !view ||
    view.view !== "project" ||
    view.section !== "chats" ||
    view.projectId !== hub.projectId ||
    !Array.isArray(view.data)
  )
    return hub;
  return { ...hub, chats: view.data };
}

/**
 * Project settings 刷新的是「Machines」一节：每台 Machine 自带它当前的租约摘要。
 * 刷新结果里没有出现的租约行继续沿用 loader，避免一次局部刷新把别的租约抹掉。
 */
export function mergeProjectMachines(
  hub: ProjectInfoHub,
  view: InfoHubView | null,
): ProjectInfoHub {
  if (
    !view ||
    view.view !== "project" ||
    view.section !== "machines" ||
    view.projectId !== hub.projectId ||
    !Array.isArray(view.data)
  )
    return hub;
  const machines = view.data;
  const refreshed = new Set(machines.map((machine) => machine.machineId));
  const carried = hub.leases.items.filter((lease) => !refreshed.has(lease.machineId));
  return {
    ...hub,
    machines,
    leases: { available: true, items: [...machines.map((machine) => machine.lease), ...carried] },
  };
}
