import type { ChatActiveRun, ChatSession } from "../contracts/chat";
import { PUBLIC_CHANNEL_DISPLAY_TITLE } from "../contracts/chat";
import type { ProjectContext } from "./access";
import { getAgentProfile } from "./agent";
import { listAgentRunInputs, listAgentRuns } from "./agent-run";
import { actorFromContext } from "./chat-actor";
import { chatGovernanceFacts } from "./chat-capabilities";
import {
  ChatError,
  chatGovernanceScope,
  getChat,
  listChatMembers,
  listInstancesForChat,
} from "./chat";

/**
 * 会话读模型（P5a 第四步）：一个会话可以返回多个分身与它们各自的活跃 run。
 *
 * 扇出之后一个群或频道会同时有多个 Agent 的 run，所以读法必须按会话聚合，而不是假设
 * 「一个会话一个 instance」。成员一律读 `chat_effective_member`（裁定 d7）：频道成员来自
 * Project 成员，Project 级移除后立即消失；分身行按裁定保留，`activeRun` 才代表它此刻在跑。
 *
 * 形状按 kind 分形（`ChatSession`）：DM 与改造前的 `ChatDetail` 逐字段一致，只多出判别字段
 * `kind`；群与频道各带自己的成员与分身集合，不共用 DM 的 `{ chat, instance }`。
 */
export function getChatSession(chatId: string, ctx: ProjectContext): ChatSession {
  const chat = getChat(chatId, ctx);
  // 治理事实由领域层一次算好（裁定 d45）：页面只读 `governance`，不再自己拼 facts 或比身份。
  const governance = chatGovernanceFacts(chatGovernanceScope(chat), actorFromContext(ctx));
  const members = listChatMembers(chatId, ctx);
  const instances = listInstancesForChat(chatId, ctx);
  if (chat.kind === "dm") {
    const instance = instances.at(0);
    // DM 建立时就在同一事务里建好唯一分身；缺失说明数据被破坏，不静默返回半截视图。
    if (!instance) throw new ChatError("not_found", "对话分身不存在");
    return { kind: "dm", chat, instance, governance };
  }
  const activeRuns = activeRunByInstance(chatId, ctx);
  const participants = instances.map((instance) => {
    const active = activeRuns.get(instance.id);
    return {
      instanceId: instance.id,
      agentProfileId: instance.agentProfileId,
      profileName: getAgentProfile(instance.agentProfileId, ctx).name,
      ...(active ? { activeRun: active } : {}),
    };
  });
  if (chat.kind === "group")
    return { kind: "group", chat, members, instances: participants, governance };
  return {
    kind: "public_channel",
    chat,
    displayTitle: PUBLIC_CHANNEL_DISPLAY_TITLE,
    members,
    instances: participants,
    governance,
  };
}

/**
 * 本会话每个分身的活跃 run：一次 `listAgentRuns` 取齐后按 instance 收口，不在分身循环里逐条查库。
 * 同一分身至多一条活跃 run，由 `agent_run_one_active_instance` 局部唯一索引保证。
 */
function activeRunByInstance(chatId: string, ctx: ProjectContext): Map<string, ChatActiveRun> {
  const active = listAgentRuns(chatId, ctx).filter(
    (run) => run.status === "queued" || run.status === "running",
  );
  return new Map(
    active.map((run) => [
      run.instanceId,
      {
        runId: run.id,
        status: run.status as ChatActiveRun["status"],
        queuedAt: run.queuedAt,
        pendingInputs: listAgentRunInputs(run.id, ctx).filter(
          (input) => input.disposition === "pending",
        ).length,
      },
    ]),
  );
}
