import { eq } from "drizzle-orm";
import { db, sqlite } from "../../src/db";
import { user } from "../../src/db/schema";
import { createProject } from "../../src/domain/project";
import { createAgentProfile, addProjectMember } from "../../src/domain/agent";
import { createDirectChat, createGroupChat, sendMessage, listChats } from "../../src/domain/chat";
import { createMachine } from "../../src/domain/machine";
import { createTask, mutateTask, getTaskDetail } from "../../src/domain/task";

const human = db.select().from(user).where(eq(user.email, "dev@sprout.test")).get();
if (!human) throw new Error("no dev human; open /dev-login once first");
const ctx = { userId: human.id, requestId: "req_review_seed" };

const project = createProject({ name: "体验评审", description: "P6 与 P7 页面评审用的场景" }, ctx);
const planner = createAgentProfile(
  { name: "协调者", persona: "负责拆任务与调度，说话简短。", harness: "pi", jobTitle: "调度" },
  ctx,
);
const builder = createAgentProfile(
  {
    name: "施工者",
    persona: "只做被指派的事，交付时贴命令输出。",
    harness: "pi",
    jobTitle: "实现",
  },
  ctx,
);
addProjectMember(project.id, planner.id, ctx);
addProjectMember(project.id, builder.id, ctx);

const group = createGroupChat(
  project.id,
  {
    projectId: project.id,
    title: "本周迭代",
    members: [
      { kind: "human", id: human.id },
      { kind: "agent", id: planner.id },
      { kind: "agent", id: builder.id },
    ],
    initialOwner: { kind: "agent", id: planner.id },
    wakePolicy: "owner_led",
  },
  { kind: "human", userId: human.id, ctx },
);
const dm = createDirectChat(project.id, builder.id, ctx).chat;
const channel = listChats(project.id, ctx).find((row) => row.kind === "public_channel");
if (!channel) throw new Error("seed expects the project public channel");

const machine = createMachine({ name: "本机 Mac" }, { ...ctx, bootId: "review", now: new Date() });

const humanTurn = (chatId: string, body: string) =>
  sendMessage(chatId, { senderKind: "human", senderId: human.id, body }, ctx);

humanTurn(group.id, "这周先把自动接续的关闭语义理清楚，别再出现程序性 abort 冻住整个 Chat。");
humanTurn(group.id, "另外 Info Hub 的轮初上下文要给 Agent 看到当前任务清单，不要只给聊天记录。");
humanTurn(dm.id, "你先把成员移除的四种阻塞整理成一份清单，我今天要看。");

const task = createTask(
  {
    projectId: project.id,
    title: "整理成员移除的阻塞清单",
    description: "四种阻塞各自举一个真实例子，并说明恢复路径。",
    constraints: "不要新增错误码，沿用 project_member_removal_blocked。",
    completionRequirements: "清单落地到 docs，并且能被门禁复跑。",
    checklist: [
      "列出 active_runs 阻塞",
      "列出 leases 阻塞",
      "列出 owner_duties 阻塞",
      "列出 dm_assigned_tasks 阻塞",
    ],
  },
  ctx,
);
const detail = getTaskDetail(task.detail.task.id, ctx);
mutateTask(
  "assign",
  { taskId: detail.task.id, expectedRevision: detail.task.revision, targetChatId: dm.id },
  ctx,
);
const second = createTask(
  {
    projectId: project.id,
    title: "给 Management 补诊断摘要",
    description: "迁移版本、日志位置、备份入口三块。",
  },
  ctx,
);

console.log(
  JSON.stringify(
    {
      projectId: project.id,
      groupId: group.id,
      dmId: dm.id,
      channelId: channel.id,
      machineId: machine.detail.machine.id,
      taskId: detail.task.id,
      secondTaskId: second.detail.task.id,
      plannerId: planner.id,
      builderId: builder.id,
    },
    null,
    1,
  ),
);
sqlite.close();
