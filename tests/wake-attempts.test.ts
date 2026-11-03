import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Risk → evidence: 判定过程中的每次尝试必须自己留痕。判定不改消息、不改 run，
// 没有这份记录，页面只能停在「正在检查」，也说不清一次检查花了多久、烧了多少 token。
const directory = mkdtempSync(join(tmpdir(), "wake-attempts-"));
process.env.DATABASE_URL = join(directory, "attempts.sqlite");
process.env.SPROUT_PI_ENABLED = "false";

const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db/index");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { chatTopic, projectTopic } = await import("../src/contracts/change-stream");
const { publishChatAutomationChange, resetChangeFeed, subscribeChanges } =
  await import("../src/domain/change-feed");
const {
  beginWakeAttempt,
  closeAttemptsForChat,
  finishWakeAttempt,
  onScheduleChange,
  reconcileChatSchedule,
  wakeAttempts,
} = await import("../src/domain/chat-schedule");
const { claimDueMessageWake } = await import("../src/domain/message-wake");
const { getChatAutomation } = await import("../src/domain/chat-automation");

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const now = new Date("2026-11-03T10:00:00.000Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1_000);

/** 项目与聊天都挂在同一个人类账号下；外键是开着的，先建账号。 */
function seedOwner() {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Owner','owner@example.com',0,?,?)",
    )
    .run(now.getTime(), now.getTime());
}

function seedProjectChat() {
  seedOwner();
  const projectId = newId(ID_PREFIXES.project);
  const chatId = newId(ID_PREFIXES.chat);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,?,'owner')")
    .run(projectId, `Attempts ${projectId}`);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES (?,?,'dm','human','owner','owner')",
    )
    .run(chatId, projectId);
  // 读视图走 chat_effective_member：human 成员来自 chat_member 行，不是 chat.owner 隐含。
  sqlite
    .prepare(
      "INSERT INTO chat_member(chat_id,member_kind,member_id,added_at) VALUES (?,'human','owner',?)",
    )
    .run(chatId, now.getTime());
  return { projectId, chatId };
}

/** 群组 + 会触发小脑的消息，is the minimum a message claim needs. */
function seedGroupMessage() {
  seedOwner();
  const projectId = newId(ID_PREFIXES.project);
  const chatId = newId(ID_PREFIXES.chat);
  const messageId = newId(ID_PREFIXES.message);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,?,'owner')")
    .run(projectId, `Messages ${projectId}`);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by,wake_policy) VALUES (?,?,'group','human','owner','owner','contextual')",
    )
    .run(chatId, projectId);
  sqlite
    .prepare(
      "INSERT INTO chat_member(chat_id,member_kind,member_id,added_at) VALUES (?,'human','owner',?)",
    )
    .run(chatId, now.getTime());
  sqlite
    .prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body,created_at) VALUES (?,?,'human','owner','看一下这个',?)",
    )
    .run(messageId, chatId, now.getTime());
  sqlite
    .prepare(
      "INSERT INTO chat_message_wake(chat_id,project_id,trigger_message_id,first_due_at,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(chatId, projectId, messageId, now.getTime(), now.getTime(), now.getTime(), now.getTime());
  return { projectId, chatId, messageId };
}

/** 一条已 claim 的判定：attempt 是已经发生的次数，claim_token 与租约一起出现。 */
function seedClaimedEvaluation(chatId: string, projectId: string, attempt = 1) {
  const id = newId(ID_PREFIXES.wakeEvaluation);
  sqlite
    .prepare(
      "INSERT INTO wake_evaluation(id,project_id,chat_id,source,round,control_epoch,fingerprint,state,attempt,request_id,created_at) VALUES (?,?,?,'task_periodic',1,1,'fp','pending',0,'req_attempts',?)",
    )
    .run(id, projectId, chatId, now.getTime());
  sqlite
    .prepare(
      "UPDATE wake_evaluation SET state='claimed',attempt=?,claim_token=?,lease_until=? WHERE id=?",
    )
    .run(attempt, `worker:${id}`, later(120).getTime(), id);
  return id;
}

function attemptRows(evaluationId: string) {
  return sqlite
    .prepare(
      "SELECT attempt,started_at,finished_at,outcome,error_code,usage FROM wake_evaluation_attempt WHERE evaluation_id=? ORDER BY attempt",
    )
    .all(evaluationId) as {
    attempt: number;
    started_at: number;
    finished_at: number | null;
    outcome: string | null;
    error_code: string | null;
    usage: string | null;
  }[];
}

const usage = {
  inputTokens: 900,
  outputTokens: 32,
  inputCharacters: 3400,
  durationMs: 4200,
  resolvedModel: "fixture/model",
};

describe("判定尝试的落库", () => {
  beforeEach(() => {
    sqlite.prepare("DELETE FROM wake_evaluation_attempt").run();
    sqlite.prepare("DELETE FROM wake_evaluation").run();
  });

  it("claim 开始一次尝试，判定结束后补上结果、错误码与用量", () => {
    const { projectId, chatId } = seedProjectChat();
    const id = seedClaimedEvaluation(chatId, projectId, 1);

    beginWakeAttempt(id, 1, now);
    expect(attemptRows(id)).toEqual([
      {
        attempt: 1,
        started_at: now.getTime(),
        finished_at: null,
        outcome: null,
        error_code: null,
        usage: null,
      },
    ]);

    finishWakeAttempt(id, 1, later(4.2), "decided", null, usage);
    const [row] = wakeAttempts([id]);
    expect(row).toMatchObject({
      evaluation_id: id,
      attempt: 1,
      started_at: now.getTime(),
      finished_at: later(4.2).getTime(),
      outcome: "decided",
      error_code: null,
      usage,
    });
  });

  it("写错次数不覆盖已有结果：先结束的那次才是事实", () => {
    const { projectId, chatId } = seedProjectChat();
    const id = seedClaimedEvaluation(chatId, projectId, 1);
    beginWakeAttempt(id, 1, now);
    finishWakeAttempt(id, 1, later(3), "decided", null, usage);

    beginWakeAttempt(id, 1, later(10));
    finishWakeAttempt(id, 1, later(20), "stale");

    const [row] = attemptRows(id);
    expect(row).toMatchObject({
      attempt: 1,
      started_at: now.getTime(),
      finished_at: later(3).getTime(),
      outcome: "decided",
    });
  });

  it("同一次尝试重开时，上一条没结束的记录先收尾为 stale，不留下永远进行中的行", () => {
    const { projectId, chatId } = seedProjectChat();
    const id = seedClaimedEvaluation(chatId, projectId, 1);
    beginWakeAttempt(id, 1, now);
    beginWakeAttempt(id, 1, later(30));

    const rows = attemptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      started_at: later(30).getTime(),
      finished_at: null,
      outcome: null,
    });
  });

  it("整片清扫按来源收尾：聊天关闭时消息与任务的尝试都算 stale", () => {
    const { projectId, chatId } = seedProjectChat();
    const id = seedClaimedEvaluation(chatId, projectId, 1);
    beginWakeAttempt(id, 1, now);

    closeAttemptsForChat(chatId, later(9), "stale");

    const [row] = attemptRows(id);
    expect(row).toMatchObject({
      finished_at: later(9).getTime(),
      outcome: "stale",
      error_code: null,
    });
  });

  it("reconcile 把失效判定收尾时，进行中的尝试一起结束", () => {
    const { projectId, chatId } = seedProjectChat();
    const id = seedClaimedEvaluation(chatId, projectId, 1);
    beginWakeAttempt(id, 1, now);
    sqlite
      .prepare(
        "INSERT INTO chat_schedule(chat_id,project_id,next_due_at,round,fingerprint,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(chatId, projectId, later(30).getTime(), 0, "fp", now.getTime());

    // 没有指派任务就不该继续检查：判定失效，尝试必须留下结束时间。
    reconcileChatSchedule(chatId, later(12));

    const [row] = attemptRows(id);
    expect(row.outcome).toBe("stale");
    expect(row.finished_at).toBe(later(12).getTime());
    expect(sqlite.prepare("SELECT state FROM wake_evaluation WHERE id=?").get(id)).toEqual({
      state: "stale",
    });
  });
});

describe("判定读视图", () => {
  beforeEach(() => {
    sqlite.prepare("DELETE FROM wake_evaluation_attempt").run();
    sqlite.prepare("DELETE FROM wake_evaluation").run();
  });

  // Risk → evidence: provider 的高精度时钟给出小数毫秒；读视图若只收整数，
  // 一次真实判定就会让整份 automation 视图解析失败，页面退化成「读出服务尚未接入」。
  it("小数耗时照样解析出判定与逐次尝试", () => {
    const { projectId, chatId } = seedProjectChat();
    const id = seedClaimedEvaluation(chatId, projectId, 1);
    beginWakeAttempt(id, 1, now);
    finishWakeAttempt(id, 1, later(4.2), "decided", null, { ...usage, durationMs: 4199.734 });
    sqlite
      .prepare(
        "UPDATE wake_evaluation SET state='decided',evaluated_at=?,claim_token=NULL,lease_until=NULL WHERE id=?",
      )
      .run(later(4.2).getTime(), id);

    const data = getChatAutomation(projectId, chatId, {
      userId: "owner",
      requestId: "req_attempts",
    });
    expect(data.view.latestEvaluation?.usage?.durationMs).toBeCloseTo(4199.734);
    expect(data.view.recentRounds[0]?.attempts[0]).toMatchObject({
      attempt: 1,
      outcome: "decided",
      usage: { durationMs: 4199.734 },
    });
  });
});

describe("自动接续变更推送", () => {
  beforeEach(() => resetChangeFeed());

  it("判定变化按 chat 反查项目，两个主题都发", () => {
    vi.useFakeTimers();
    const { projectId, chatId } = seedProjectChat();
    const seen: string[] = [];
    const off = subscribeChanges({
      topics: [projectTopic(projectId), chatTopic(chatId)],
      send: (event) => seen.push(event.topic),
    });

    publishChatAutomationChange(chatId);
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([projectTopic(projectId), chatTopic(chatId)]);
    off();
    vi.useRealTimers();
  });

  it("human message 被 claim 的瞬间就推送，页面不必等判定结果", () => {
    vi.useFakeTimers();
    const { projectId, chatId } = seedGroupMessage();
    const seen: string[] = [];
    const off = subscribeChanges({
      topics: [projectTopic(projectId), chatTopic(chatId)],
      send: (event) => seen.push(event.topic),
    });

    const claimed = claimDueMessageWake({ now, requestId: "req_claim", workerId: "gate" });
    vi.advanceTimersByTime(200);
    expect(claimed?.state).toBe("claimed");
    expect(seen).toEqual([projectTopic(projectId), chatTopic(chatId)]);
    off();
    vi.useRealTimers();
  });
});

describe("调度信号", () => {
  // Risk → evidence: 构建产物里服务入口与 SSR 路由是两套模块图，同一个文件有两份实例。
  // 监听者表不挂 process 时，发消息那份实例的信号传不到调度器那份，判定只能等 15 秒心跳。
  it("另一个模块实例的信号也唤醒本实例注册的监听者", async () => {
    const seen: string[] = [];
    const off = onScheduleChange(() => seen.push("hit"));
    vi.resetModules();
    const second = await import("../src/domain/chat-schedule");
    second.signalScheduleChange();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["hit"]);
    off();
  });
});
