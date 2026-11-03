import { useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PageFrame } from "@/components/layout/page-frame";
import { ChatEmptyState, ChatListPanel } from "@/components/chat/chat-list";
import { ChatThread } from "@/components/chat/chat-thread";
import { ChatTitleEditor } from "@/components/chat/chat-title-editor";
import { ChatDraftProvider, useChatDraft } from "@/components/chat/chat-drafts";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { isRunActive, runStatusLabel, RunStatusPanel } from "@/components/chat/run-status";
import { ChatInspector } from "@/components/info-hub/chat-inspector";
import { ChatWorkspace } from "@/components/layout/chat-workspace";
import type { ChatAgent } from "@/components/chat/chat-loader";
import { demoProfiles as profiles, demoHumanName as HUMAN } from "../management/fixtures";
import { demoMachineDetails } from "../machine/fixtures";
import { demoExecutions, demoHolderNames, demoLeases } from "../machine/lease-fixtures";
import type { ChatMachineFacts } from "@/components/info-hub/chat-inspector";
import type { AgentRun, ChatRunState, RunActivity } from "../../../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, Message } from "../../../contracts/chat";
import type { ChatInfoView, TurnStartContext } from "../../../contracts/info-hub";
import type { AppError } from "../../../contracts/result";
import { ArrowLeftIcon, MessageSquareIcon } from "lucide-react";
import { ID_PREFIXES, newId } from "@/contracts/ids";

/** 场景数据全部是虚构样例；正式模块不导入本目录。 */
const PROJECT_ID = "prj_11111111";

function chat(id: string, title: string, updatedAt: string): Chat {
  return {
    id,
    projectId: PROJECT_ID,
    kind: "dm",
    title,
    owner: { kind: "human", id: "usr_demo" },
    wakePolicy: "owner_led",
    governanceRevision: 0,
    createdBy: "usr_demo",
    createdAt: "2026-06-18T02:00:00.000Z",
    updatedAt,
  };
}

const CANONICAL_CHAT_ID = "cnv_44444444";

const chats: Chat[] = [
  chat(CANONICAL_CHAT_ID, "仓库首页架构评审", "2026-06-18T02:28:00.000Z"),
  chat("cnv_55555555", "迁移顺序拆解", "2026-06-17T10:12:00.000Z"),
];

const chatAgents: ChatAgent[] = chats.map((item, index) => ({
  chatId: item.id,
  agentProfileId: profiles[index]!.id,
}));

const demoInstances: AgentInstance[] = [
  {
    id: "ins_aaaaaaaa",
    agentProfileId: profiles[0]!.id,
    chatId: "cnv_44444444",
    projectId: PROJECT_ID,
    createdAt: "2026-06-18T02:00:00.000Z",
    updatedAt: "2026-06-18T02:00:00.000Z",
  },
];

const members: ChatMember[] = [
  {
    chatId: chats[0]!.id,
    memberKind: "human",
    memberId: "usr_demo",
    addedAt: "2026-06-18T02:00:00.000Z",
  },
  {
    chatId: chats[0]!.id,
    memberKind: "agent",
    memberId: profiles[0]!.id,
    addedAt: "2026-06-18T02:00:00.000Z",
  },
];

/** 演示用 @ 候选：成员展示名来自同一批 fixture，多几个名字才看得出过滤。 */
const mentionMembers = [
  { memberId: "usr_demo", name: HUMAN },
  ...profiles.map((profile) => ({ memberId: profile.id, name: profile.name })),
];

const messages: Message[] = [
  {
    id: "msg_66666666",
    chatId: chats[0]!.id,
    senderKind: "human",
    senderId: "usr_demo",
    body: "仓库首页的分析入口应该怎么记录分析依据？我希望以后能知道结论来自哪个 commit。",
    createdAt: "2026-06-18T02:24:00.000Z",
    mentions: [],
  },
  {
    id: "msg_77777777",
    chatId: chats[0]!.id,
    senderKind: "agent",
    senderId: profiles[0]!.id,
    body: "建议把分析依据绑定到每次 run，而不是只写进首页文案。首页可以展示最新结论，但不应该成为证据的唯一存放位置。",
    createdAt: "2026-06-18T02:26:00.000Z",
    mentions: [],
  },
  {
    id: "msg_88888888",
    chatId: chats[0]!.id,
    senderKind: "agent",
    senderId: profiles[0]!.id,
    body: "取舍是：保存快照引用，不复制整个仓库。",
    createdAt: "2026-06-18T02:28:00.000Z",
    mentions: [],
  },
  {
    // 点名样例：连续 chip、多个 chip、行尾 chip、行首 chip，以及没被点名的普通 @。
    id: "msg_99999999",
    chatId: chats[0]!.id,
    senderKind: "human",
    senderId: "usr_demo",
    body: "评审顺序：@林澈@Amenda 先看首页信息层级，再由 @Repo 分析员 核对证据链。\n@前端审阅 麻烦确认 390 宽下不会挤成两行；邮箱 hi@example.com 只是普通文字。",
    createdAt: "2026-06-18T02:30:00.000Z",
    mentions: [
      { memberKind: "human", memberId: "usr_demo", start: 5, end: 8 },
      { memberKind: "agent", memberId: profiles[0]!.id, start: 8, end: 15 },
      { memberKind: "agent", memberId: profiles[1]!.id, start: 28, end: 37 },
      { memberKind: "agent", memberId: profiles[2]!.id, start: 45, end: 50 },
    ],
  },
  {
    id: "msg_aaaaaaaa",
    chatId: chats[0]!.id,
    senderKind: "agent",
    senderId: profiles[0]!.id,
    body: "行尾与换行分开验：先说结论 @Amenda\n@Repo 分析员 接着补证据，最后 @林澈",
    createdAt: "2026-06-18T02:31:00.000Z",
    mentions: [
      { memberKind: "agent", memberId: profiles[0]!.id, start: 14, end: 21 },
      { memberKind: "agent", memberId: profiles[1]!.id, start: 22, end: 31 },
      { memberKind: "human", memberId: "usr_demo", start: 41, end: 44 },
    ],
  },
];

const scenarioRun: AgentRun = {
  id: "run_99999999",
  instanceId: "ins_demo",
  chatId: chats[0]!.id,
  projectId: PROJECT_ID,
  requestId: "req_sm_demo",
  status: "running",
  queuedAt: "2026-06-18T02:28:00.000Z",
  startedAt: "2026-06-18T02:28:01.000Z",
  sessionId: "ses_demo",
};

const scenarioRunInputs = [
  {
    runId: scenarioRun.id,
    messageId: messages[0]!.id,
    disposition: "pending" as const,
  },
];

const scenarioActivity: RunActivity = {
  current: {
    id: "call_demo_4",
    kind: "bash",
    label: "Bash 命令",
    detail: "pnpm test",
    toolName: "bash",
    startedAt: "2026-06-18T02:28:20.000Z",
    status: "running",
  },
  entries: [
    {
      id: "call_demo_4",
      kind: "bash",
      label: "Bash 命令",
      detail: "pnpm test",
      toolName: "bash",
      startedAt: "2026-06-18T02:28:20.000Z",
      status: "running",
    },
    {
      id: "call_demo_3",
      kind: "file",
      label: "编辑文件",
      detail: "src/components/chat/run-activity.tsx",
      toolName: "edit",
      startedAt: "2026-06-18T02:28:12.000Z",
      finishedAt: "2026-06-18T02:28:19.000Z",
      status: "done",
      durationMs: 7000,
    },
    {
      id: "call_demo_2",
      kind: "file",
      label: "读取文件",
      detail: "src/contracts/agent-run.ts",
      toolName: "read",
      startedAt: "2026-06-18T02:28:08.000Z",
      finishedAt: "2026-06-18T02:28:10.000Z",
      status: "done",
      durationMs: 2000,
    },
    {
      id: "call_demo_1",
      kind: "mcp",
      label: "MCP 调用",
      detail: "sentry · list_issues · is:unresolved",
      toolName: "mcp__sentry__list_issues",
      startedAt: "2026-06-18T02:28:02.000Z",
      finishedAt: "2026-06-18T02:28:07.000Z",
      status: "error",
      durationMs: 5000,
    },
  ],
  updatedAt: "2026-06-18T02:28:20.000Z",
};

const scenarioSecondRun: AgentRun = {
  ...scenarioRun,
  id: "run_88888888",
  instanceId: "ins_demo_b",
  queuedAt: "2026-06-18T02:28:05.000Z",
  startedAt: "2026-06-18T02:28:06.000Z",
  sessionId: "ses_demo_b",
};

const scenarioSecondActivity: RunActivity = {
  current: {
    id: "call_demo_b1",
    kind: "search",
    label: "搜索内容",
    detail: "runStatusLabel",
    toolName: "ffgrep",
    startedAt: "2026-06-18T02:28:24.000Z",
    status: "running",
  },
  entries: [
    {
      id: "call_demo_b1",
      kind: "search",
      label: "搜索内容",
      detail: "runStatusLabel",
      toolName: "ffgrep",
      startedAt: "2026-06-18T02:28:24.000Z",
      status: "running",
    },
    {
      id: "call_demo_b2",
      kind: "file",
      label: "读取文件",
      detail: "src/components/chat/chat-thread.tsx",
      toolName: "read",
      startedAt: "2026-06-18T02:28:18.000Z",
      finishedAt: "2026-06-18T02:28:20.000Z",
      status: "done",
      durationMs: 2000,
    },
  ],
  updatedAt: "2026-06-18T02:28:24.000Z",
};

const scenarioRunState: Record<string, ChatRunState> = {
  idle: { enabled: true, active: [], latest: null, inputs: [] },
  running: {
    enabled: true,
    active: [{ ...scenarioRun, activity: scenarioActivity }],
    latest: scenarioRun,
    inputs: scenarioRunInputs,
  },
  group: {
    enabled: true,
    active: [
      { ...scenarioRun, activity: scenarioActivity },
      { ...scenarioSecondRun, activity: scenarioSecondActivity },
    ],
    latest: scenarioSecondRun,
    inputs: [],
  },
  failed: {
    enabled: true,
    active: [],
    latest: {
      ...scenarioRun,
      requestId: "req_sm_demo_failed",
      status: "failed",
      settledAt: "2026-06-18T02:28:30.000Z",
      errorCode: "UPSTREAM_TIMEOUT",
      errorMessage: "上游响应超时，已保留本轮消息与仓库快照。",
    },
    inputs: [],
  },
  disabled: { enabled: false, active: [], latest: null, inputs: [] },
};

function demoError(
  code: Exclude<AppError["code"], "project_member_removal_blocked">,
  message: string,
): AppError {
  return { code, message, requestId: "req_demo_0000" };
}

/** Chat 与 Machine 详情共用同一份租约与执行样例。 */
const demoMachineFacts: ChatMachineFacts = {
  projectId: PROJECT_ID,
  machines: demoMachineDetails,
  leases: demoLeases,
  executions: demoExecutions,
  holderNames: demoHolderNames,
};

const infoView: ChatInfoView = {
  tasks: { available: true, items: [] },
  chatId: chats[0]!.id,
  projectId: PROJECT_ID,
  kind: "dm",
  archived: false,
  members: [
    { memberKind: "human", memberId: "usr_demo", displayName: HUMAN },
    {
      memberKind: "agent",
      memberId: profiles[0]!.id,
      displayName: profiles[0]!.name,
      status: "idle",
      error: null,
    },
  ],
  owner: { kind: "human", id: "usr_demo" },
  instances: [
    {
      instanceId: "ins_aaaaaaaa",
      agentProfileId: profiles[0]!.id,
      profileName: profiles[0]!.name,
      leases: [],
    },
  ],
  messages: { count: messages.length, latestAt: messages[2]!.createdAt },
  runs: {
    available: true,
    hostEnabled: true,
    active: [],
    recent: [
      {
        runId: "run_99999999",
        chatId: chats[0]!.id,
        instanceId: "ins_aaaaaaaa",
        agentProfileId: profiles[0]!.id,
        status: "completed",
        queuedAt: "2026-06-18T02:28:00.000Z",
        startedAt: "2026-06-18T02:28:01.000Z",
        settledAt: "2026-06-18T02:28:30.000Z",
        requestId: "req_sm_demo",
        pendingInputs: 0,
      },
    ],
  },
};

const turnStart: TurnStartContext = {
  schemaVersion: 1,
  runId: "run_aaaaaaaa",
  capturedAt: "2026-06-18T02:28:00.000Z",
  basisRevision: "demo-snapshot-1",
  serializedText: "Demo turn context",
  contentHash: "bce9baafc87a7b907e4e0dcd03f70e35f08f7bb6218e83279a1b56bb6f7d1488",
  deliveryState: "prepared",
  submittedAt: null,
  failureCode: null,
  truncated: false,
  omittedCounts: { members: 0, runs: 0, tasks: 0, leases: 0, pendingLeaseRequests: 0 },
  projectName: "Mio",
  chatTitle: "项目协作",
  chatKind: "dm",
  chatArchived: false,
  owner: infoView.owner,
  members: infoView.members,
  status: "running",
  heldMachines: [],
  pendingLeaseRequests: [],
  taskCounts: { proposed: 0, assigned: 0, finished: 0, canceled: 0 },
  projectSummary: { agentCount: 1, chatCount: 2, machineCount: 0 },
  chatRuns: [
    {
      runId: "run_aaaaaaaa",
      chatId: chats[0]!.id,
      instanceId: "ins_aaaaaaaa",
      agentProfileId: profiles[0]!.id,
      status: "running",
      isSelf: true,
    },
  ],
  tasks: [],
  projectId: PROJECT_ID,
  chatId: chats[0]!.id,
  instanceId: "ins_aaaaaaaa",
  agentProfileId: profiles[0]!.id,
  profileName: profiles[0]!.name,
  hostEnabled: true,
  workspace: null,
  activeRun: {
    runId: "run_aaaaaaaa",
    status: "running",
    pendingInputs: 0,
  },
  injectedIntoPrompt: false,
};

function workspaceFixture(chat: Chat, currentMessages: Message[]) {
  const first = chat.id === chats[0]!.id;
  const profile = profiles[first ? 0 : 1]!;
  const instance: AgentInstance = {
    ...demoInstances[0]!,
    id: first ? demoInstances[0]!.id : "ins_bbbbbbbb",
    chatId: chat.id,
    agentProfileId: profile.id,
  };
  const chatMembers = members.map((member) => ({
    ...member,
    chatId: chat.id,
    memberId: member.memberKind === "agent" ? instance.id : member.memberId,
  }));
  const threadMessages = currentMessages.map((message) => ({
    ...message,
    chatId: chat.id,
    senderId: message.senderKind === "agent" ? instance.id : message.senderId,
  }));
  const state: ChatRunState = first
    ? {
        enabled: true,
        active: [],
        latest: {
          ...scenarioRun,
          chatId: chat.id,
          instanceId: instance.id,
          status: "completed",
          settledAt: "2026-06-18T02:28:30.000Z",
        },
        inputs: [],
      }
    : scenarioRunState.idle!;
  const info: ChatInfoView = {
    ...infoView,
    chatId: chat.id,
    members: chatMembers.map((member) =>
      member.memberKind === "human"
        ? { memberKind: "human", memberId: member.memberId, displayName: HUMAN }
        : {
            memberKind: "agent",
            memberId: profile.id,
            displayName: profile.name,
            status: "idle",
            error: null,
          },
    ),
    instances: [
      {
        instanceId: instance.id,
        agentProfileId: profile.id,
        profileName: profile.name,
        leases: [],
      },
    ],
    messages: { count: threadMessages.length, latestAt: threadMessages.at(-1)?.createdAt },
    runs: first ? infoView.runs : { ...infoView.runs, active: [], recent: [] },
  };
  const context: TurnStartContext = {
    ...turnStart,
    chatId: chat.id,
    instanceId: instance.id,
    agentProfileId: profile.id,
    profileName: profile.name,
    members: info.members,
    owner: info.owner,
    chatRuns: turnStart.chatRuns.map((run) => ({
      ...run,
      chatId: chat.id,
      instanceId: instance.id,
      agentProfileId: profile.id,
    })),
  };
  return {
    profile,
    members: chatMembers,
    instances: [instance],
    messages: threadMessages,
    state,
    info,
    context,
  };
}

function Frame({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <PageFrame
      title={title}
      description={note}
      back={
        <a href="./" className="inline-flex min-h-6 items-center gap-2 text-foreground">
          <Icon as={ArrowLeftIcon} />
          开发演示入口
        </a>
      }
      actions={<ThemeToggle />}
      testId="chat-scene"
    >
      {children}
    </PageFrame>
  );
}

/** 消息区与输入区的演示：状态切换只改本地样例，不调用任何服务。 */
function MessagesScene() {
  const [scene, setScene] = useState<"idle" | "running" | "group" | "failed" | "disabled">(
    "running",
  );
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<Message[]>([]);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const [stoppedRuns, setStoppedRuns] = useState<string[]>([]);
  const visibleMessages = [...messages, ...sent];
  const base = scenarioRunState[scene]!;
  const state: ChatRunState = stoppedAt
    ? {
        enabled: true,
        active: [],
        latest: { ...scenarioRun, status: "aborted", settledAt: stoppedAt },
        inputs: scenarioRunState.running!.inputs,
      }
    : {
        ...base,
        active: base.active.filter((row) => !stoppedRuns.includes(row.id)),
      };
  const agentNames =
    scene === "group"
      ? new Map([
          [scenarioRun.instanceId, profiles[0]!.name],
          [scenarioSecondRun.instanceId, profiles[1]!.name],
        ])
      : undefined;
  return (
    <Frame
      title="消息与输入"
      note="消息层级、追加语义、运行状态与未投递输入。全部为演示样例，提交只在本地回显。"
    >
      <div className="mb-5 flex flex-wrap gap-2">
        {(["idle", "running", "group", "failed", "disabled"] as const).map((value) => (
          <Button
            key={value}
            variant={scene === value ? "default" : "secondary"}
            size="sm"
            onClick={() => {
              setScene(value);
              setStoppedAt(null);
              setStoppedRuns([]);
            }}
          >
            {value}
          </Button>
        ))}
      </div>
      <div className="rounded-container border border-border bg-background p-5">
        <MessageList
          messages={visibleMessages}
          profile={{ ok: true, data: profiles[0]!, requestId: "req_demo" }}
          humanName={HUMAN}
        />
        <RunStatusPanel
          state={state}
          messages={visibleMessages}
          onRestoreDraft={setDraft}
          chatKind={scene === "group" ? "group" : "dm"}
          agentNames={agentNames}
          onStopRun={(runId) => setStoppedRuns((ids) => [...ids, runId])}
        />
        <div className="mt-5">
          <MessageComposer
            agentName={profiles[0]!.name}
            members={mentionMembers}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={() => {
              if (!draft.trim()) return;
              const message: Message = {
                id: newId(ID_PREFIXES.message),
                chatId: chats[0]!.id,
                senderKind: "human",
                senderId: "usr_demo",
                body: draft,
                createdAt: new Date().toISOString(),
                mentions: [],
              };
              setSent((all) => [...all, message]);
              setDraft("");
            }}
            pending={false}
            error={null}
            fieldErrors={{}}
            runActive={isRunActive(state)}
            runStatusLabel={runStatusLabel(state)}
            stopping={false}
            stopError={null}
            onStop={scene === "group" ? undefined : () => setStoppedAt(new Date().toISOString())}
          />
        </div>
        {sent.length > 0 && (
          <p
            role="status"
            data-testid="chat-scene-sent"
            className="mt-2 text-xs text-muted-foreground"
          >
            演示：已回显 {sent.length} 条消息。
          </p>
        )}
      </div>
    </Frame>
  );
}

/** 错误与空态的独立场景，便于在演示里复现失败呈现。 */
function StatesScene() {
  return (
    <Frame
      title="错误与空态"
      note="列表空、搜索无结果、加载失败与 Chat 读取失败分别呈现，不互相代替。"
    >
      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-sm font-medium">列表空态</h2>
          <div className="h-64 overflow-hidden rounded-container border border-border bg-secondary">
            <ChatListPanel projectId={PROJECT_ID} chats={[]} chatAgents={[]} profiles={profiles} />
          </div>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium">选中态与搜索栏</h2>
          <div className="h-64 overflow-hidden rounded-container border border-border bg-secondary">
            <ChatListPanel
              projectId={PROJECT_ID}
              chats={chats}
              chatAgents={chatAgents}
              profiles={profiles}
              selectedChatId={chats[1]!.id}
            />
            <p className="mt-2 px-3 text-[11px] text-muted-foreground">
              搜索无结果由搜索框自身呈现，不会替换整个列表。
            </p>
          </div>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium">列表错误</h2>
          <div className="h-48 overflow-y-auto rounded-container border border-border bg-secondary p-3">
            <ChatListPanel projectId={PROJECT_ID} chats={[]} chatAgents={[]} profiles={profiles} />
            <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              chats-error 由路由在列表上方呈现，不替换列表本身。
            </p>
          </div>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium">消息读取失败</h2>
          <div className="rounded-container border border-border bg-background p-5">
            <ChatEmptyState
              title="这条 Chat 不存在"
              body="请从左侧选择已有对话，或创建新的对话。"
            />
          </div>
        </section>
      </div>
    </Frame>
  );
}

/**
 * 演示用的对话线程：同一份 ChatThread，回调只在本地回显。
 * 草稿按 Chat 分开保存，另一条 Chat 的输入不会串到这条。
 */
function DemoThread({
  chat,
  fixture,
  inspectorOpen,
  onToggleInspector,
  onSend,
  onRename,
}: {
  chat: Chat;
  fixture: ReturnType<typeof workspaceFixture>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onSend: (body: string) => void;
  /** 演示用重命名：只改本地 fixture，写库走的仍是同一条正式 server function。 */
  onRename: (title: string | undefined) => void;
}) {
  const [draft, setDraft] = useChatDraft(chat.id);
  return (
    <ChatThread
      back={
        <Link
          to="/projects/$projectId/chats"
          params={{ projectId: chat.projectId }}
          aria-label="返回 Chat 列表"
          data-testid="back-to-chats"
          className="hidden size-8.5 shrink-0 place-items-center rounded-control border border-transparent text-foreground hover:border-input max-desktop:grid max-desktop:size-11"
        >
          <Icon as={ArrowLeftIcon} />
        </Link>
      }

      chat={chat}
      agentName={fixture.profile.name}
      members={fixture.info.members.map((member) => ({
        memberId: member.memberId,
        name: member.displayName,
      }))}
      profile={{ ok: true, data: fixture.profile, requestId: "req_demo" }}
      humanName={HUMAN}
      messages={{ ok: true, data: fixture.messages, requestId: "req_demo" }}
      runState={{ ok: true, data: fixture.state, requestId: "req_demo" }}
      inspectorOpen={inspectorOpen}
      onToggleInspector={onToggleInspector}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => {
        if (!draft.trim()) return;
        onSend(draft);
        setDraft("");
      }}
      sendPending={false}
      sendError={null}
      fieldErrors={{}}
      onStop={() => undefined}
      stopPending={false}
      stopError={null}
      onRestoreDraft={setDraft}
      titleEditor={
        <ChatTitleEditor
          chat={chat}
          currentName={fixture.profile.name}
          submit={async (title) => {
            onRename(title);
            return { ok: true, data: { ...chat, title }, requestId: "req_demo" };
          }}
          restore={async () => {
            onRename(undefined);
            const { title: _title, ...rest } = chat;
            return { ok: true, data: rest, requestId: "req_demo" };
          }}
          onChanged={() => undefined}
        />
      }
    />
  );
}

/**
 * 三栏工作区：选中对话与 inspector 都由路由 pathname / search 决定，
 * 列表链接、返回与 `?info=1` 走真实导航，与正式路由同一套语义。
 * 数据仍是 fixture；草稿与模拟消息按 Chat 隔离，模拟提交只在当前场景内回显。
 */
function WorkspaceScene() {
  const { projectId, chatId } = useParams({ strict: false }) as {
    projectId?: string;
    chatId?: string;
  };
  const search = useSearch({ strict: false }) as { info?: number };
  const navigate = useNavigate();
  const inspector = search.info === 1;
  const [localMessages, setLocalMessages] = useState<Record<string, Message[]>>({
    [chats[0]!.id]: messages,
  });
  const [localTitles, setLocalTitles] = useState<Record<string, string | undefined>>({});
  const selectedChat = chats.find((item) => item.id === chatId);
  const fixture = selectedChat
    ? workspaceFixture(selectedChat, localMessages[selectedChat.id] ?? [])
    : null;
  const viewChats = chats
    .map((item) => ({
      ...item,
      ...(item.id in localTitles
        ? localTitles[item.id] === undefined
          ? { title: undefined }
          : { title: localTitles[item.id] }
        : {}),
      updatedAt: localMessages[item.id]?.at(-1)?.createdAt ?? item.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const openInspector = (next: boolean) => {
    if (!projectId || !chatId) return;
    void navigate({
      to: "/projects/$projectId/chats/$chatId",
      params: { projectId, chatId },
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        info: next ? 1 : undefined,
      }),
      replace: !next,
    });
  };

  return (
    <ChatDraftProvider>
      <ChatWorkspace
        selected={Boolean(selectedChat)}
        list={
          <ChatListPanel
            projectId={projectId ?? PROJECT_ID}
            chats={viewChats}
            chatAgents={chatAgents}
            profiles={profiles}
            selectedChatId={selectedChat?.id}
          />
        }
        chat={
          selectedChat && fixture ? (
            <DemoThread
              key={selectedChat.id}
              chat={selectedChat}
              fixture={fixture}
              onSend={(body) => {
                const message: Message = {
                  id: newId(ID_PREFIXES.message),
                  chatId: selectedChat.id,
                  senderKind: "human",
                  senderId: "usr_demo",
                  body,
                  createdAt: new Date().toISOString(),
                  mentions: [],
                };
                setLocalMessages((previous) => ({
                  ...previous,
                  [selectedChat.id]: [...(previous[selectedChat.id] ?? []), message],
                }));
              }}
              inspectorOpen={inspector}
              onToggleInspector={() => openInspector(!inspector)}
              onRename={(title) =>
                setLocalTitles((previous) => ({ ...previous, [selectedChat.id]: title }))
              }
            />
          ) : (
            <ChatEmptyState
              title="选择一条 Chat"
              body="从左侧选择一条对话，与 Agent 一起推进 Project。"
              action={
                <Link
                  to="/projects/$projectId/chats/$chatId"
                  params={{ projectId: projectId ?? PROJECT_ID, chatId: chats[0]!.id }}
                  search={{ info: 1 }}
                  className="inline-flex min-h-8.5 items-center gap-2 rounded-control bg-primary px-2.75 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  <Icon as={MessageSquareIcon} />
                  打开示例对话
                </Link>
              }
            />
          )
        }
        inspector={
          inspector && selectedChat && fixture ? (
            <ChatInspector
              key={selectedChat.id}
              chat={selectedChat}
              agentName={fixture.profile.name}
              humanName={HUMAN}
              members={{ ok: true, data: fixture.members, requestId: "req_demo" }}
              instances={{ ok: true, data: fixture.instances, requestId: "req_demo" }}
              profile={{ ok: true, data: fixture.profile, requestId: "req_demo" }}
              info={{ ok: true, data: fixture.info, requestId: "req_demo" }}
              turnContext={{
                ok: true,
                data: { kind: "captured", record: fixture.context },
                requestId: "req_demo",
              }}
              machineFacts={demoMachineFacts}
              onClose={() => openInspector(false)}
            />
          ) : undefined
        }
      />
    </ChatDraftProvider>
  );
}

/** Info Hub 的独立场景：正常数据一份，失败数据一份。 */
function InspectorScene() {
  return (
    <Frame title="Info Hub" note="摘要常显，运行事实与 Chat 事实按需展开；诊断字段只折叠不删除。">
      <div className="h-[36rem] overflow-hidden rounded-container border border-border">
        <ChatInspector
          chat={chats[0]!}
          agentName={profiles[0]!.name}
          humanName={HUMAN}
          members={{ ok: true, data: members, requestId: "req_demo" }}
          instances={{ ok: true, data: demoInstances, requestId: "req_demo" }}
          profile={{ ok: true, data: profiles[0]!, requestId: "req_demo" }}
          info={{ ok: true, data: infoView, requestId: "req_demo" }}
          turnContext={{
            ok: true,
            data: { kind: "captured", record: turnStart },
            requestId: "req_demo",
          }}
          machineFacts={demoMachineFacts}
          onClose={() => undefined}
        />
      </div>
      <div className="mt-6 max-w-160">
        <h2 className="mb-3 text-sm font-medium">失败呈现</h2>
        <ChatInspector
          chat={chats[0]!}
          agentName={profiles[0]!.name}
          humanName={HUMAN}
          members={{ ok: true, data: members, requestId: "req_demo" }}
          instances={{ ok: false, error: demoError("internal", "内部错误"), requestId: "req_demo" }}
          profile={null}
          info={{ ok: false, error: demoError("internal", "内部错误"), requestId: "req_demo" }}
          turnContext={{
            ok: false,
            error: demoError("internal", "内部错误"),
            requestId: "req_demo",
          }}
          onClose={() => undefined}
        />
      </div>
    </Frame>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  workspace: WorkspaceScene,
  messages: MessagesScene,
  states: StatesScene,
  inspector: InspectorScene,
};

/**
 * Chat 场景入口：默认渲染三栏工作区，`?scene=` 切换其余场景。
 * 场景复用正式呈现组件，只有数据与回调是演示用的。
 */
export function ChatScenes({ scene }: { scene?: string }) {
  const Scene = SCENES[scene ?? "workspace"] ?? WorkspaceScene;
  return <Scene />;
}
