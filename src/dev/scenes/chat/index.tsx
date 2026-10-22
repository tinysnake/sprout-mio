import { useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PageFrame } from "@/components/layout/page-frame";
import { ChatEmptyState, ChatListPanel } from "@/components/chat/chat-list";
import { ChatThread } from "@/components/chat/chat-thread";
import { ChatDraftProvider, useChatDraft } from "@/components/chat/chat-drafts";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { RunStatusPanel } from "@/components/chat/run-status";
import { ChatInspector } from "@/components/info-hub/chat-inspector";
import { ChatWorkspace } from "@/components/layout/chat-workspace";
import type { ChatAgent } from "@/components/chat/chat-loader";
import type { AgentProfile } from "../../../contracts/agent";
import type { ChatRunState } from "../../../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, Message } from "../../../contracts/chat";
import type { ChatInfoView, TurnStartContext } from "../../../contracts/info-hub";
import type { AppError } from "../../../contracts/result";
import { ArrowLeftIcon, MessageSquareIcon } from "lucide-react";

/** 场景数据全部是虚构样例；正式模块不导入本目录。 */
const PROJECT_ID = "prj_11111111-1111-4111-8111-111111111111";
const HUMAN = "林澈";
const profiles: AgentProfile[] = [
  {
    id: "agt_22222222-2222-4222-8222-222222222222",
    name: "闻序",
    jobTitle: "全能秘书",
    persona: "把讨论整理成可执行的边界，先固定证据再迁移入口。",
    harness: "pi",
    createdBy: "usr_demo",
    createdAt: "2026-06-18T02:00:00.000Z",
    updatedAt: "2026-06-18T02:00:00.000Z",
  },
  {
    id: "agt_33333333-3333-4333-8333-333333333333",
    name: "夜白",
    jobTitle: "代码审阅",
    persona: "只在证据不足时提出反对意见。",
    harness: "pi",
    createdBy: "usr_demo",
    createdAt: "2026-06-18T02:00:00.000Z",
    updatedAt: "2026-06-18T02:00:00.000Z",
  },
];

function chat(id: string, title: string, updatedAt: string): Chat {
  return {
    id,
    projectId: PROJECT_ID,
    kind: "dm",
    title,
    createdBy: "usr_demo",
    createdAt: "2026-06-18T02:00:00.000Z",
    updatedAt,
  };
}

const CANONICAL_CHAT_ID = "cnv_44444444-4444-4444-8444-444444444444";

const chats: Chat[] = [
  chat(CANONICAL_CHAT_ID, "仓库首页架构评审", "2026-06-18T02:28:00.000Z"),
  chat("cnv_55555555-5555-4555-8555-555555555555", "迁移顺序拆解", "2026-06-17T10:12:00.000Z"),
];

const chatAgents: ChatAgent[] = chats.map((item, index) => ({
  chatId: item.id,
  agentProfileId: profiles[index]!.id,
}));

const demoInstances: AgentInstance[] = [
  {
    id: "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agentProfileId: profiles[0]!.id,
    chatId: "cnv_44444444-4444-4444-8444-444444444444",
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

const messages: Message[] = [
  {
    id: "msg_66666666-6666-4666-8666-666666666666",
    chatId: chats[0]!.id,
    senderKind: "human",
    senderId: "usr_demo",
    body: "仓库首页的分析入口应该怎么记录分析依据？我希望以后能知道结论来自哪个 commit。",
    createdAt: "2026-06-18T02:24:00.000Z",
  },
  {
    id: "msg_77777777-7777-4777-8777-777777777777",
    chatId: chats[0]!.id,
    senderKind: "agent",
    senderId: profiles[0]!.id,
    body: "建议把分析依据绑定到每次 run，而不是只写进首页文案。首页可以展示最新结论，但不应该成为证据的唯一存放位置。",
    createdAt: "2026-06-18T02:26:00.000Z",
  },
  {
    id: "msg_88888888-8888-4888-8888-888888888888",
    chatId: chats[0]!.id,
    senderKind: "agent",
    senderId: profiles[0]!.id,
    body: "取舍是：保存快照引用，不复制整个仓库。",
    createdAt: "2026-06-18T02:28:00.000Z",
  },
];

const scenarioRunState: Record<string, ChatRunState> = {
  idle: { enabled: true, runs: [], inputs: [] },
  running: {
    enabled: true,
    runs: [
      {
        id: "run_99999999-9999-4999-8999-999999999999",
        instanceId: "ins_demo",
        chatId: chats[0]!.id,
        projectId: PROJECT_ID,
        requestId: "req_sm_demo",
        status: "running",
        queuedAt: "2026-06-18T02:28:00.000Z",
        startedAt: "2026-06-18T02:28:01.000Z",
        sessionId: "ses_demo",
      },
    ],
    inputs: [
      {
        runId: "run_99999999-9999-4999-8999-999999999999",
        messageId: messages[2]!.id,
        disposition: "pending",
      },
    ],
  },
  failed: {
    enabled: true,
    runs: [
      {
        id: "run_99999999-9999-4999-8999-999999999999",
        instanceId: "ins_demo",
        chatId: chats[0]!.id,
        projectId: PROJECT_ID,
        requestId: "req_sm_demo_failed",
        status: "failed",
        queuedAt: "2026-06-18T02:28:00.000Z",
        startedAt: "2026-06-18T02:28:01.000Z",
        settledAt: "2026-06-18T02:28:30.000Z",
        errorCode: "UPSTREAM_TIMEOUT",
        errorMessage: "上游响应超时，已保留本轮消息与仓库快照。",
        sessionId: "ses_demo",
      },
    ],
    inputs: [],
  },
  disabled: { enabled: false, runs: [], inputs: [] },
};

function demoError(code: AppError["code"], message: string): AppError {
  return { code, message, requestId: "req_demo_0000" };
}

const infoView: ChatInfoView = {
  chatId: chats[0]!.id,
  projectId: PROJECT_ID,
  kind: "dm",
  archived: false,
  members: [
    { memberKind: "human", memberId: "usr_demo", displayName: HUMAN },
    { memberKind: "agent", memberId: profiles[0]!.id, displayName: profiles[0]!.name },
  ],
  instance: {
    instanceId: "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agentProfileId: profiles[0]!.id,
    profileName: profiles[0]!.name,
  },
  messages: { count: messages.length, latestAt: messages[2]!.createdAt },
  runs: {
    available: true,
    hostEnabled: true,
    active: [],
    recent: [
      {
        runId: "run_99999999-9999-4999-8999-999999999999",
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
  projectId: PROJECT_ID,
  chatId: chats[0]!.id,
  instanceId: "ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agentProfileId: profiles[0]!.id,
  profileName: profiles[0]!.name,
  hostEnabled: true,
  workspace: null,
  activeRun: null,
  previousRun: {
    runId: "run_99999999-9999-4999-8999-999999999999",
    status: "completed",
    requestId: "req_sm_demo",
    settledAt: "2026-06-18T02:28:30.000Z",
  },
  injectedIntoPrompt: false,
};

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
  const [scene, setScene] = useState<"idle" | "running" | "failed" | "disabled">("running");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);

  return (
    <Frame
      title="消息与输入"
      note="消息层级、追加语义、运行状态与未投递输入。全部为演示样例，提交只在本地回显。"
    >
      <div className="mb-5 flex flex-wrap gap-2">
        {(["idle", "running", "failed", "disabled"] as const).map((value) => (
          <Button
            key={value}
            variant={scene === value ? "default" : "secondary"}
            size="sm"
            onClick={() => setScene(value)}
          >
            {value}
          </Button>
        ))}
      </div>
      <div className="rounded-container border border-border bg-background p-5">
        <MessageList
          messages={messages}
          profile={{ ok: true, data: profiles[0]!, requestId: "req_demo" }}
          humanName={HUMAN}
        />
        <RunStatusPanel
          state={scenarioRunState[scene]!}
          messages={messages}
          onRestoreDraft={(body) => setDraft(body)}
        />
        <div className="mt-5">
          <MessageComposer
            agentName={profiles[0]!.name}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={() => {
              setSent((all) => [...all, draft]);
              setDraft("");
            }}
            pending={false}
            error={null}
            fieldErrors={{}}
            runActive={scene === "running"}
            runStatusLabel={scene === "disabled" ? "宿主未启用" : "运行中"}
            stopping={false}
            stopError={null}
            onStop={() => undefined}
          />
        </div>
        {sent.length > 0 && (
          <p
            role="status"
            data-testid="chat-scene-sent"
            className="mt-2 text-xs text-muted-foreground"
          >
            演示回显：{sent.join(" / ")}
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
  inspectorOpen,
  onToggleInspector,
}: {
  chat: Chat;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
  const [draft, setDraft] = useChatDraft(chat.id);
  const [sent, setSent] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  return (
    <>
      <ChatThread
        back={
          <Link
            to="/projects/$projectId/chats"
            params={{ projectId: chat.projectId }}
            aria-label="返回 Chat 列表"
            data-testid="back-to-chats"
            className="hidden size-8.5 shrink-0 place-items-center rounded-control border border-transparent text-foreground hover:border-input max-desktop:grid"
          >
            <Icon as={ArrowLeftIcon} />
          </Link>
        }
        chat={chat}
        agentName={profiles[0]!.name}
        profile={{ ok: true, data: profiles[0]!, requestId: "req_demo" }}
        humanName={HUMAN}
        messages={{ ok: true, data: messages, requestId: "req_demo" }}
        members={{ ok: true, data: members, requestId: "req_demo" }}
        instances={{ ok: true, data: demoInstances, requestId: "req_demo" }}
        runState={{
          ok: true,
          requestId: "req_demo",
          data: scenarioRunState[chat.id === chats[0]!.id ? "idle" : "running"]!,
        }}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => {
          if (!draft.trim() || pending) return;
          setPending(true);
          window.setTimeout(() => {
            setSent((all) => [...all, draft]);
            setDraft("");
            setPending(false);
          }, 300);
        }}
        sendPending={pending}
        sendError={null}
        fieldErrors={{}}
        onStop={() => undefined}
        stopPending={false}
        stopError={null}
        onRestoreDraft={setDraft}
      />
      {sent.length > 0 && (
        <p role="status" className="sr-only" data-testid="chat-scene-sent">
          已回显 {sent.length} 条消息
        </p>
      )}
    </>
  );
}

/**
 * 三栏工作区：选中对话与 inspector 都由路由 pathname / search 决定，
 * 列表链接、返回与 `?info=1` 走真实导航，与正式路由同一套语义。
 * 数据仍是 fixture；切换对话不保留草稿（每 Chat 一个实例）。
 */
function WorkspaceScene() {
  const { projectId, chatId } = useParams({ strict: false }) as {
    projectId?: string;
    chatId?: string;
  };
  const search = useSearch({ strict: false }) as { info?: number };
  const navigate = useNavigate();
  const inspector = search.info === 1;
  const selectedChat = chats.find((item) => item.id === chatId);
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
            chats={chats}
            chatAgents={chatAgents}
            profiles={profiles}
            selectedChatId={selectedChat?.id}
          />
        }
        chat={
          selectedChat ? (
            <DemoThread
              key={selectedChat.id}
              chat={selectedChat}
              inspectorOpen={inspector}
              onToggleInspector={() => openInspector(!inspector)}
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
          inspector && selectedChat ? (
            <ChatInspector
              key={selectedChat.id}
              chat={selectedChat}
              agentName={profiles[0]!.name}
              humanName={HUMAN}
              members={{ ok: true, data: members, requestId: "req_demo" }}
              instances={{ ok: true, data: demoInstances, requestId: "req_demo" }}
              profile={{ ok: true, data: profiles[0]!, requestId: "req_demo" }}
              info={{ ok: true, data: infoView, requestId: "req_demo" }}
              turnStart={{ ok: true, data: turnStart, requestId: "req_demo" }}
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
          turnStart={{ ok: true, data: turnStart, requestId: "req_demo" }}
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
          turnStart={{ ok: false, error: demoError("internal", "内部错误"), requestId: "req_demo" }}
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
