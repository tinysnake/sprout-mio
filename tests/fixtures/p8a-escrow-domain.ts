// I-P8a 挂靠与领取的域层验收：真实 SQLite、真实 Project/Group/DM/Public Channel、
// 真实分身身份（instance + running run + remote_tool_grant）与真实授权代次。
// 私有库、真实会话数据都留在 mktemp 目录里，不落进仓库。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { leaseViewSchema } from "../../src/contracts/lease";
import { createGroupChatInput } from "../../src/contracts/chat";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import {
  chat,
  leaseAuthorization,
  leaseEscrow,
  leaseMutation,
  machineLease,
  remoteExecution,
} from "../../src/db/schema";
import { addProjectMember, createAgentProfile } from "../../src/domain/agent";
import { createDirectChat, createGroupChat, ensureInstance } from "../../src/domain/chat";
import { createMachine, hashCredential, saveProjectMachineBinding } from "../../src/domain/machine";
import { createProject } from "../../src/domain/project";
import type { AgentRemoteContext } from "../../src/server/lease";
import {
  acquireLease,
  assertExecutionContinuity,
  assertExecutionWrite,
  authorityNow,
  cancelLeaseEscrow,
  claimLease,
  escrowLease,
  getLease,
  handoffLease,
  leaseWhere,
  releaseLease,
} from "../../src/server/lease";
import { openInitialMembership } from "../../src/server/membership";

const humanId = "p8a-human";
type AuthorizationRow = typeof leaseAuthorization.$inferSelect;
type ExecutionRow = typeof remoteExecution.$inferSelect;
type EscrowRow = typeof leaseEscrow.$inferSelect;
const projectCtx = { userId: humanId, requestId: newId(ID_PREFIXES.request) };
const req = () => newId(ID_PREFIXES.request);
const at = () => new Date();

function pass(message: string) {
  console.log(`p8a-escrow-domain: PASS ${message}`);
}

/** 断言某次调用以指定错误码被拒；错误码本身就是「哪条边界拒的」的证据。 */
function expectCode(expected: string, operation: () => unknown, message: string) {
  let code = "no-throw";
  try {
    operation();
  } catch (error) {
    code = (error as { code?: string }).code ?? "no-code";
  }
  assert.equal(code, expected, message);
  pass(message);
}

function boot() {
  const id = newId(ID_PREFIXES.boot);
  sqlite
    .prepare(
      "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
    )
    .run(id);
  return id;
}

/** 一个真实分身身份：instance 在指定 chat，run running，grant 未过期未撤销。 */
function actor(projectId: string, chatId: string, profileId: string): AgentRemoteContext {
  const instance = ensureInstance(chatId, profileId, projectCtx);
  const runId = newId(ID_PREFIXES.run);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
    )
    .run(
      runId,
      instance.id,
      chatId,
      projectId,
      req(),
      Math.floor(Date.now() / 1000),
      randomBytes(16).toString("hex"),
    );
  const grantId = newId(ID_PREFIXES.remoteToolGrant);
  sqlite
    .prepare(
      "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      grantId,
      hashCredential(randomBytes(32).toString("base64url")),
      humanId,
      projectId,
      chatId,
      instance.id,
      runId,
      Date.now(),
      Date.now() + 3600000,
    );
  return {
    userId: humanId,
    projectId,
    chatId,
    instanceId: instance.id,
    runId,
    grantId,
    bootId: boot(),
    now: NOW,
    requestId: req(),
  };
}

migrateDatabase();
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(humanId, humanId, "p8a@example.test");

// —— 两个 Project：本 Project 一个 Group + 一个 DM + 一个 Public Channel；另一个 Project 一个 Group。
const project = createProject({ name: "P8a" }, projectCtx);
const other = createProject({ name: "P8a-other" }, projectCtx);
const holderAgent = createAgentProfile({ name: "Holder", persona: "", harness: "pi" }, projectCtx);
const claimerAgent = createAgentProfile(
  { name: "Claimer", persona: "", harness: "pi" },
  projectCtx,
);
const outsiderAgent = createAgentProfile(
  { name: "Outsider", persona: "", harness: "pi" },
  projectCtx,
);
const foreignAgent = createAgentProfile(
  { name: "Foreign", persona: "", harness: "pi" },
  projectCtx,
);
for (const profile of [holderAgent, claimerAgent, outsiderAgent])
  addProjectMember(project.id, profile.id, projectCtx);
addProjectMember(other.id, foreignAgent.id, projectCtx);

const group = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8a Group",
    initialOwner: { kind: "human", id: humanId },
    members: [
      { kind: "human", id: humanId },
      { kind: "agent", id: holderAgent.id },
      { kind: "agent", id: claimerAgent.id },
    ],
  }),
  { kind: "human", userId: humanId, ctx: projectCtx },
);
const groupOther = createGroupChat(
  other.id,
  createGroupChatInput.parse({
    projectId: other.id,
    title: "P8a Other Group",
    initialOwner: { kind: "human", id: humanId },
    members: [
      { kind: "human", id: humanId },
      { kind: "agent", id: foreignAgent.id },
    ],
  }),
  { kind: "human", userId: humanId, ctx: projectCtx },
);
const dm = createDirectChat(project.id, holderAgent.id, projectCtx);
const outsiderDm = createDirectChat(project.id, outsiderAgent.id, projectCtx);
const channel = db
  .select()
  .from(chat)
  .where(and(eq(chat.projectId, project.id), eq(chat.kind, "public_channel")))
  .get()!;

const machineCtx = { userId: humanId, bootId: boot(), requestId: req(), now: at() };
const enrolled = createMachine({ name: "P8a Machine" }, machineCtx);
const key = { projectId: project.id, machineId: enrolled.detail.machine.id };
saveProjectMachineBinding({ ...key, description: "", expectedRevision: null }, machineCtx);
openInitialMembership(db, { ...key, now: machineCtx.now });

// 授权表的 CHECK 要求 revoked_at >= issued_at，挂靠行要求 closed_at >= escrowed_at，
// 而这两处的另一侧都取自各自命令的 ctx.now；让所有分身共享同一个时刻，即以「等于」满足。
const NOW = new Date();
const holder = actor(project.id, group.id, holderAgent.id);
const claimer = actor(project.id, group.id, claimerAgent.id);
const channelClaimer = actor(project.id, channel.id, claimerAgent.id);
const outsider = actor(project.id, outsiderDm.chat.id, outsiderAgent.id);
const foreign = actor(other.id, groupOther.id, foreignAgent.id);

const leaseRow = () => db.select().from(machineLease).where(leaseWhere(key)).get()!;
const authorizations = () =>
  db
    .select()
    .from(leaseAuthorization)
    .where(
      and(
        eq(leaseAuthorization.projectId, key.projectId),
        eq(leaseAuthorization.machineId, key.machineId),
      ),
    )
    .all()
    .map(
      (row: AuthorizationRow) =>
        `${row.generation}:${row.state}:${row.reason}:${row.holderInstanceId ?? "-"}`,
    )
    .sort();
const escrowRows = () =>
  db
    .select()
    .from(leaseEscrow)
    .where(and(eq(leaseEscrow.projectId, key.projectId), eq(leaseEscrow.machineId, key.machineId)))
    .all();
/** 进程状态快照：挂靠与领取都不得让它在任何列上发生变化。 */
const executions = () =>
  db
    .select()
    .from(remoteExecution)
    .where(
      and(
        eq(remoteExecution.projectId, key.projectId),
        eq(remoteExecution.machineId, key.machineId),
      ),
    )
    .all()
    .map((row: ExecutionRow) => JSON.stringify(row))
    .sort();
const mutationCount = () =>
  db
    .select()
    .from(leaseMutation)
    .where(
      and(eq(leaseMutation.projectId, key.projectId), eq(leaseMutation.machineId, key.machineId)),
    )
    .all().length;

// —— 1) 持有者先取得租约，并在 Machine 上留下一个真实执行（进程状态的基线）。
acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
assert.equal(leaseRow().generation, 1);
assert.equal(authorityNow(key)!.state, "active");
const executionId = newId(ID_PREFIXES.execution);
const executionOrigin = { ...key, authorizationGeneration: 1, holderInstanceId: holder.instanceId };
// 执行行的 created_at 往前推，terminal_at >= created_at 的约束在释放时才成立；
// dispatch_deadline_at 留在未来，避免它先被当成超时执行。
const executionCreatedAt = new Date(Date.now() - 3600000);
db.insert(remoteExecution)
  .values({
    id: executionId,
    ...key,
    authorizationGeneration: 1,
    holderInstanceId: holder.instanceId,
    runId: holder.runId,
    chatId: holder.chatId,
    requestId: req(),
    payloadHash: "a".repeat(64),
    operationJson: { kind: "shell", command: "true" },
    state: "queued",
    createdAt: executionCreatedAt,
    dispatchDeadlineAt: new Date(Date.now() + 30000),
  })
  .run();
let executionSnapshot = executions();
const mutationBaseline = mutationCount();
pass("持有者取得租约并在 Machine 上留下一个真实执行作为进程状态基线");

// —— 2) DM 不支持挂靠（DM 展示分身持有的租约，但不是挂靠目标）。
expectCode(
  "lease_escrow_dm_unsupported",
  () =>
    escrowLease(
      { ...key, action: "escrow", requestId: req(), expectedGeneration: 1, chatId: dm.chat.id },
      holder,
    ),
  "挂靠到 DM 被拒（lease_escrow_dm_unsupported）",
);

// —— 3) 跨 Project 拒绝：目标 Group 属于另一个 Project。
expectCode(
  "lease_escrow_cross_project",
  () =>
    escrowLease(
      {
        ...key,
        action: "escrow",
        requestId: req(),
        expectedGeneration: 1,
        chatId: groupOther.id,
      },
      holder,
    ),
  "挂靠到别的 Project 的 Group 被拒（lease_escrow_cross_project）",
);

// —— 4) host 范围：非本 Project 的调用上下文看不到这台 Machine。
expectCode(
  "not_found",
  () =>
    escrowLease(
      { ...key, action: "escrow", requestId: req(), expectedGeneration: 1, chatId: group.id },
      foreign,
    ),
  "跨 Project 身份对本 Project 的租约发起挂靠被拒（not_found）",
);

// —— 5) 未持有的租约不能挂靠，不存在的挂靠也不能领取。
// 挂靠要求发起者已经是持有者，因此 expectedGeneration 至少是 1（generation 0 是未持有形态）：
// 与 release/handoff 用同一档校验，先在契约层被拒。
assert.throws(
  () =>
    escrowLease(
      { ...key, action: "escrow", requestId: req(), expectedGeneration: 0, chatId: group.id },
      holder,
    ),
  /expectedGeneration/,
);
pass("未持有的租约不能挂靠（generation 0 在契约层被拒）");
expectCode(
  "not_found",
  () =>
    claimLease(
      {
        ...key,
        action: "claim",
        requestId: req(),
        expectedGeneration: 1,
        escrowId: newId(ID_PREFIXES.leaseEscrow),
      },
      claimer,
    ),
  "领取不存在的挂靠被拒（not_found）",
);

// —— 6) 挂靠到 Group：Machine 仍被占用，发起者失去操作权，进程状态不变。
const escrowed = escrowLease(
  { ...key, action: "escrow", requestId: req(), expectedGeneration: 1, chatId: group.id },
  holder,
);
assert.equal(escrowed.escrow.state, "escrowed");
assert.equal(escrowed.escrow.chatId, group.id);
assert.equal(escrowed.escrow.targetAgentProfileId, null);
assert.equal(escrowed.escrow.escrowedByInstanceId, holder.instanceId);
assert.equal(escrowed.escrow.escrowGeneration, 2);
assert.equal(escrowed.lease.state, "held", "挂靠期间 Machine 仍是占用状态");
assert.equal(escrowed.lease.generation, 2);
assert.equal(escrowed.lease.holderInstanceId, holder.instanceId, "挂靠不换 machine_lease 的持有者");
assert.equal(escrowed.lease.pendingMutationId, null, "挂靠不进入 fencing");
assert.equal(escrowed.lease.escrow?.escrowId, escrowed.escrow.escrowId);
leaseViewSchema.parse(escrowed.lease);
assert.deepEqual(
  authorizations(),
  [
    `0:revoked:initial:-`,
    `1:revoked:acquire:${holder.instanceId}`,
    `2:escrowed:escrow:${holder.instanceId}`,
  ].sort(),
);
assert.equal(leaseRow().state, "held");
assert.deepEqual(executions(), executionSnapshot, "挂靠不改变任何执行行（进程状态）");
assert.equal(mutationCount(), mutationBaseline, "挂靠不写 lease_mutation 收据");
assert.deepEqual(authorityNow(key), {
  generation: 2,
  holderInstanceId: holder.instanceId,
  state: "escrowed",
});
assert.equal(
  getLease({ ...key }, machineCtx).lease.escrow?.chatId,
  group.id,
  "getLease 也如实投影挂靠目标",
);
pass("挂靠到 Group：machine_lease 仍 held、旧授权 revoked、新授权 escrowed、执行行不变");

// —— 7) 挂靠后原持有者下命令被拒（旧凭据失去操作权）。
expectCode(
  "lease_not_holder",
  () => assertExecutionWrite(key, 2, holder),
  "挂靠后原持有者下命令被拒（lease_not_holder）",
);
expectCode(
  "lease_stale_generation",
  () => assertExecutionWrite(key, 1, holder),
  "挂靠后原持有者用旧代次下命令被拒（lease_stale_generation）",
);
expectCode(
  "lease_not_holder",
  () => assertExecutionContinuity(executionOrigin, holder),
  "挂靠后原持有者连执行读连续性也被拒（lease_not_holder）",
);
expectCode(
  "lease_not_holder",
  () =>
    releaseLease({ ...key, action: "release", requestId: req(), expectedGeneration: 2 }, holder),
  "挂靠期间发起者不能释放（lease_not_holder）",
);
expectCode(
  "lease_not_holder",
  () =>
    handoffLease(
      {
        ...key,
        action: "handoff",
        requestId: req(),
        expectedGeneration: 2,
        targetInstanceId: claimer.instanceId,
      },
      holder,
    ),
  "挂靠期间发起者不能交接（lease_not_holder）",
);
expectCode(
  "lease_conflict",
  () =>
    acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 2 }, claimer),
  "挂靠期间其他分身不能抢占（lease_conflict）",
);
expectCode(
  "lease_conflict",
  () =>
    escrowLease(
      { ...key, action: "escrow", requestId: req(), expectedGeneration: 2, chatId: group.id },
      holder,
    ),
  "同一租约不能重复挂靠（lease_conflict）",
);

// —— 8) 撤销挂靠：代次继续推进，发起者拿回操作权。
const cancelled = cancelLeaseEscrow(
  {
    ...key,
    action: "escrow_cancel",
    requestId: req(),
    expectedGeneration: 2,
    escrowId: escrowed.escrow.escrowId,
  },
  holder,
);
assert.equal(cancelled.escrow.state, "cancelled");
assert.equal(cancelled.lease.escrow, null, "撤销后租约不再显示为挂靠中");
assert.equal(cancelled.lease.generation, 3);
assert.equal(cancelled.lease.holderInstanceId, holder.instanceId);
assert.equal(authorityNow(key)!.state, "active");
assert.equal(assertExecutionWrite(key, 3, holder).generation, 3);
assert.deepEqual(executions(), executionSnapshot);
// 撤销没有 request-id 收据列：同一次撤销的重放按同一张收据返回，不推进代次。
const cancelledAgain = cancelLeaseEscrow(
  {
    ...key,
    action: "escrow_cancel",
    requestId: req(),
    expectedGeneration: 2,
    escrowId: escrowed.escrow.escrowId,
  },
  holder,
);
assert.equal(cancelledAgain.escrow.state, "cancelled");
assert.equal(leaseRow().generation, 3, "撤销重放不推进代次");
assert.deepEqual(executions(), executionSnapshot);
pass("撤销挂靠：代次 2→3、授权回到发起者 active、执行行不变、重放幂等");
// 撤销之后，旧的挂靠代次不能再拿来发起新的挂靠。
expectCode(
  "lease_stale_generation",
  () =>
    escrowLease(
      { ...key, action: "escrow", requestId: req(), expectedGeneration: 2, chatId: group.id },
      holder,
    ),
  "用旧代次再次挂靠被拒（lease_stale_generation）",
);

// —— 9) 领取：领取者凭身份成为新持有者，代次继续推进，能看到并控制原有进程。
const claimerEscrow = escrowLease(
  { ...key, action: "escrow", requestId: req(), expectedGeneration: 3, chatId: group.id },
  holder,
);
const claimed = claimLease(
  {
    ...key,
    action: "claim",
    requestId: req(),
    expectedGeneration: 4,
    escrowId: claimerEscrow.escrow.escrowId,
  },
  claimer,
);
assert.equal(claimed.escrow.state, "claimed");
assert.equal(claimed.escrow.claimedByInstanceId, claimer.instanceId);
assert.equal(claimed.escrow.claimedGeneration, 5);
assert.equal(claimed.lease.generation, 5);
assert.equal(claimed.lease.holderInstanceId, claimer.instanceId);
assert.equal(claimed.lease.state, "held");
assert.equal(claimed.lease.escrow, null, "领取后租约不再显示为挂靠中");
leaseViewSchema.parse(claimed.lease);
assert.equal(authorityNow(key)!.state, "active");
assert.deepEqual(executions(), executionSnapshot, "领取不改变任何执行行（原有进程照旧运行）");
assert.equal(
  assertExecutionContinuity(executionOrigin, claimer)!.generation,
  5,
  "领取者看得见原有进程（跨代次的执行读连续性成立）",
);
assert.equal(assertExecutionWrite(key, 5, claimer).holderInstanceId, claimer.instanceId);
expectCode(
  "lease_not_holder",
  () => assertExecutionWrite(key, 5, holder),
  "领取后原持有者不再有操作权（lease_not_holder）",
);
pass("领取：领取者成为新持有者（代次 4→5），可查看并控制原有进程，执行行不变");

// —— 10) 重复领取与范围外领取都被拒。
expectCode(
  "lease_not_escrowed",
  () =>
    claimLease(
      {
        ...key,
        action: "claim",
        requestId: req(),
        expectedGeneration: 5,
        escrowId: claimerEscrow.escrow.escrowId,
      },
      claimer,
    ),
  "重复领取同一挂靠被拒（lease_not_escrowed）",
);
expectCode(
  "lease_not_escrowed",
  () =>
    claimLease(
      {
        ...key,
        action: "claim",
        requestId: req(),
        expectedGeneration: 5,
        escrowId: claimerEscrow.escrow.escrowId,
      },
      outsider,
    ),
  "已被领走的挂靠不能再被领取（lease_not_escrowed）",
);

// —— 11) 领取者可以继续释放；释放会按既有语义处置在途执行，之后的基线取释放后的样子。
releaseLease({ ...key, action: "release", requestId: req(), expectedGeneration: 5 }, claimer);
assert.equal(leaseRow().state, "free");
assert.equal(authorityNow(key)!.state, "free");
executionSnapshot = executions();
acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 6 }, holder);

// —— 12) 挂靠到 Group + 指定 Agent：只有被指定的分身能领。
const targeted = escrowLease(
  {
    ...key,
    action: "escrow",
    requestId: req(),
    expectedGeneration: 7,
    chatId: group.id,
    targetAgentProfileId: claimerAgent.id,
  },
  holder,
);
assert.equal(targeted.escrow.targetAgentProfileId, claimerAgent.id);
expectCode(
  "lease_claim_out_of_scope",
  () =>
    claimLease(
      {
        ...key,
        action: "claim",
        requestId: req(),
        expectedGeneration: 8,
        escrowId: targeted.escrow.escrowId,
      },
      // 这个分身也在同一个 Group 里，但不是被指定的那个 Agent。
      outsider,
    ),
  "不在挂靠 Group 里的分身不能领取（lease_claim_out_of_scope）",
);
expectCode(
  "lease_claim_out_of_scope",
  () =>
    claimLease(
      {
        ...key,
        action: "claim",
        requestId: req(),
        expectedGeneration: 8,
        escrowId: targeted.escrow.escrowId,
      },
      // 原持有者本人是 Group 成员，但不在「Group + 指定 Agent」的范围内。
      holder,
    ),
  "Group 内非指定 Agent 的分身不能领取（lease_claim_out_of_scope）",
);
expectCode(
  "lease_stale_generation",
  () =>
    claimLease(
      {
        ...key,
        action: "claim",
        requestId: req(),
        expectedGeneration: 7,
        escrowId: targeted.escrow.escrowId,
      },
      claimer,
    ),
  "用旧代次领取被拒（lease_stale_generation）",
);
assert.deepEqual(executions(), executionSnapshot, "被拒的领取不改变执行行");
const cancelledTargeted = cancelLeaseEscrow(
  {
    ...key,
    action: "escrow_cancel",
    requestId: req(),
    expectedGeneration: 8,
    escrowId: targeted.escrow.escrowId,
  },
  holder,
);
assert.equal(cancelledTargeted.lease.generation, 9);

// —— 13) Public Channel 是特殊 Group：同样支持挂靠与领取，且请求可幂等重放。
const channelEscrow = escrowLease(
  {
    ...key,
    action: "escrow",
    requestId: req(),
    expectedGeneration: 9,
    chatId: channel.id,
  },
  holder,
);
assert.equal(channelEscrow.escrow.chatId, channel.id);
assert.equal(leaseRow().generation, 10);
const claimRequestId = req();
const claimInput = {
  ...key,
  action: "claim" as const,
  requestId: claimRequestId,
  expectedGeneration: 10,
  escrowId: channelEscrow.escrow.escrowId,
};
const channelClaim = claimLease(claimInput, channelClaimer);
assert.equal(channelClaim.lease.holderInstanceId, channelClaimer.instanceId);
assert.equal(channelClaim.lease.generation, 11);
const replayed = claimLease(claimInput, channelClaimer);
assert.deepEqual(replayed, channelClaim, "同 requestId 的领取是幂等重放，不推进代次");
assert.equal(leaseRow().generation, 11);
assert.deepEqual(executions(), executionSnapshot);
pass("Public Channel 支持挂靠与领取，同 requestId 幂等重放不推进代次");

// —— 14) 结束时的整体形态：没有残留的活跃挂靠，挂靠只留自己的收据行。
assert.equal(escrowRows().filter((row: EscrowRow) => row.state === "escrowed").length, 0);
assert.equal(leaseRow().state, "held");
assert.equal(leaseRow().holderInstanceId, channelClaimer.instanceId);
assert.equal(
  mutationCount(),
  mutationBaseline + 2,
  "只有 acquire/release 会写 lease_mutation（挂靠、撤销、领取都不写）",
);
console.log(`p8a-escrow-domain: PASS 授权链 ${JSON.stringify(authorizations())}`);
console.log(
  `p8a-escrow-domain: PASS 挂靠收据 ${JSON.stringify(
    escrowRows().map(
      (row: EscrowRow) =>
        `${row.state}:${row.escrowGeneration}${row.claimedGeneration ? `→${row.claimedGeneration}` : ""}`,
    ),
  )}`,
);
console.log("p8a-escrow-domain: PASS all");
