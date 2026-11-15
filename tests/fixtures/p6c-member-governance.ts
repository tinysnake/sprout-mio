import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { and, eq, ne } from "drizzle-orm";
import { db, sqlite } from "../../src/db";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { agentRun, chat, chatEffectiveMember, machineLease } from "../../src/db/schema";
import { addProjectMember, createAgentProfile } from "../../src/domain/agent";
import { addCrewMember, createDirectChat, ensureInstance, getChat } from "../../src/domain/chat";

import { createProject } from "../../src/domain/project";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { projectRunAttentionPolicy } from "../../src/domain/run-attention";
import { mutateTask } from "../../src/domain/task";
import { openInitialMembership } from "../../src/server/membership";
import { seedLease, seedRun, seedTask } from "./p6c-member-fixture";
import { createCrewChat, crewInput } from "./crew-chat";

const base = process.env.BASE_URL!;
const evidence = process.env.SPROUT_UI_EVIDENCE_DIR!;
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let count = 0;
function pass(id: string, detail: string) {
  count++;
  console.log(`PASS ${id} :: ${detail}`);
}

try {
  const email = `p6c-ui-${Date.now()}@example.test`;
  await page.goto(`${base}/login`);
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("P6c Human");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(`${randomBytes(24).toString("base64url")}aA1!`);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== "/login");
  const user = sqlite.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string };
  assert.ok(user);
  const observerContext = await browser.newContext();
  const observerPage = await observerContext.newPage();
  const observerEmail = `p6c-observer-${Date.now()}@example.test`;
  await observerPage.goto(`${base}/login`);
  await observerPage.getByTestId("register-tab").click();
  await observerPage.locator('input[name="name"]').fill("Other Human");
  await observerPage.locator('input[name="email"]').fill(observerEmail);
  await observerPage
    .locator('input[name="password"]')
    .fill(`${randomBytes(24).toString("base64url")}aA1!`);
  await observerPage.locator('button[type="submit"]').click();
  await observerPage.waitForURL((url) => url.pathname !== "/login");
  const ctx = { userId: user.id, requestId: newId(ID_PREFIXES.request) };
  const project = createProject({ name: "P6c 页面治理" }, ctx);
  const agent = createAgentProfile({ name: "Leaving Agent", persona: "", harness: "pi" }, ctx);
  const helper = createAgentProfile({ name: "Helper Agent", persona: "", harness: "pi" }, ctx);
  const removable = createAgentProfile({ name: "Non-lead Agent", persona: "", harness: "pi" }, ctx);
  addProjectMember(project.id, agent.id, ctx);
  addProjectMember(project.id, helper.id, ctx);
  addProjectMember(project.id, removable.id, ctx);
  const dm = createDirectChat(project.id, agent.id, ctx);
  const group = createCrewChat(
    project.id,
    crewInput({
      projectId: project.id,
      title: "Crew lead duties",
      initialOwner: { kind: "agent", id: agent.id },
      members: [
        { kind: "human", id: user.id },
        { kind: "agent", id: agent.id },
        { kind: "agent", id: helper.id },
        { kind: "agent", id: removable.id },
      ],
    }),
    { kind: "human", userId: user.id, ctx },
  );
  const instance = ensureInstance(group.id, agent.id, ctx);
  const helperInstance = ensureInstance(group.id, helper.id, ctx);
  const channel = db
    .select()
    .from(chat)
    .where(and(eq(chat.projectId, project.id), eq(chat.kind, "crew"), ne(chat.id, group.id)))
    .get()!;
  for (const profile of [helper, removable]) {
    addCrewMember(
      channel.id,
      { kind: "agent", id: profile.id },
      getChat(channel.id, ctx).governanceRevision,
      { kind: "human", userId: user.id, ctx },
    );
  }
  const bootId = newId(ID_PREFIXES.boot);
  sqlite
    .prepare(
      "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
    )
    .run(bootId);
  const machineCtx = { ...ctx, bootId, now: new Date() };
  const makeMachine = () => {
    const machine = createMachine({ name: "Handoff Machine" }, machineCtx).detail.machine;
    const key = { projectId: project.id, machineId: machine.id };
    saveProjectMachineBinding({ ...key, description: "", expectedRevision: null }, machineCtx);
    openInitialMembership(db, { ...key, now: machineCtx.now });
    return key;
  };
  const fixture = {
    ctx,
    project,
    agent,
    dm,
    group,
    instance,
    channel,
    bootId,
    machineCtx,
    makeMachine,
  };
  const runId = seedRun(fixture, "running");
  db.update(agentRun)
    .set({ attentionPolicySnapshot: projectRunAttentionPolicy(project.id) })
    .where(eq(agentRun.id, runId))
    .run();
  const lease = seedLease(fixture, "fencing", helperInstance.id, instance.id);
  const taskId = seedTask(fixture);
  const projectPath = `/projects/${project.id}`;
  const memberRow = (name: string) => page.getByTestId("member-item").filter({ hasText: name });
  async function visitChat(chatId: string) {
    await page.goto(`${base}${projectPath}/chats/${chatId}`);
    await page.getByTestId("chat-details").waitFor();
  }
  async function openRemoval() {
    await page.goto(`${base}${projectPath}/members`);
    await memberRow(agent.name).getByTestId("member-remove").click();
    await page.getByTestId("confirm-member-mutation").click();
    await page.getByTestId("member-removal-blockers").waitFor();
  }
  await openRemoval();
  const blockers = page.getByTestId("member-removal-blockers");
  assert.deepEqual(
    await blockers
      .locator("section")
      .evaluateAll((sections) => sections.map((section) => section.dataset.testid)),
    [
      "member-blocker-active_runs",
      "member-blocker-leases",
      "member-blocker-owner_duties",
      "member-blocker-dm_assigned_tasks",
    ],
  );
  pass("blockers_order", "四类阻塞按服务端顺序显示");
  for (const [kind, fact, action] of [
    ["active_runs", runId, "先在该 Chat 停掉运行"],
    ["leases", "relation=handoff_target", "待决交接"],
    ["owner_duties", "Crew lead duties", "先在该 Chat 变更负责人"],
    ["dm_assigned_tasks", taskId, "改派、完成或取消"],
  ]) {
    const section = page.getByTestId(`member-blocker-${kind}`);
    assert.ok(await section.isVisible());
    assert.ok((await section.innerText()).includes(fact));
    assert.ok((await section.innerText()).includes(action));
    pass(`blocker_${kind}`, `${fact}，可见且有可执行下一步`);
  }
  const links = await blockers
    .locator("a")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  assert.ok(links.includes(`${projectPath}/chats/${group.id}`));
  assert.ok(links.includes(`${projectPath}/chats/${channel.id}`));
  assert.ok(links.includes(`${projectPath}/chats/${dm.chat.id}`));
  assert.ok(links.includes(`${projectPath}/tasks/${taskId}`));
  assert.ok(
    links.some((href) =>
      href?.startsWith(`/machines/${lease.key.machineId}/lease?projectId=${project.id}`),
    ),
  );
  pass("blocker_object_links", "Chat、Task、Machine 链接指向实际阻塞对象");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  const box = await blockers.boundingBox();
  assert.ok(box && box.width <= 390 && box.x >= 0);
  assert.ok(await page.getByTestId("confirm-member-mutation").isVisible());
  await page.screenshot({ path: `${evidence}/blockers-390.png`, fullPage: true });
  pass("member_blockers_mobile", "390px 单列确认框无横向滚动，所有阻塞可纵向查看");
  await page.getByTestId("cancel-member-mutation").click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  const runBefore = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
  const leaseBefore = db
    .select()
    .from(machineLease)
    .where(eq(machineLease.machineId, lease.key.machineId))
    .get();
  async function reassignLead(chatId: string, candidates = [agent.id, helper.id, removable.id]) {
    await visitChat(chatId);
    assert.ok((await page.getByTestId("chat-owner-name").innerText()).includes("Human"));
    assert.equal(db.select().from(chat).where(eq(chat.id, chatId)).get()?.ownerId, user.id);
    await page.getByTestId("chat-lead-edit").click();
    assert.deepEqual(
      (
        await page
          .getByTestId("chat-lead-select")
          .locator("option")
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
      ).sort(),
      [...candidates].sort(),
    );
    await page.getByTestId("chat-lead-select").selectOption(helper.id);
    await page.getByTestId("chat-lead-submit").click();
    await page.getByTestId("chat-lead-dialog").waitFor({ state: "hidden" });
    assert.equal(db.select().from(chat).where(eq(chat.id, chatId)).get()?.leadProfileId, helper.id);
  }
  await reassignLead(channel.id);
  pass("crew_lead_candidates", "Human owner 可改任，候选只有有效 Agent 成员");
  assert.deepEqual(db.select().from(agentRun).where(eq(agentRun.id, runId)).get(), runBefore);
  assert.deepEqual(
    db.select().from(machineLease).where(eq(machineLease.machineId, lease.key.machineId)).get(),
    leaseBefore,
  );
  pass("crew_lead_updated", "改任 lead 后 run 与租约保持原值");
  await page.screenshot({ path: `${evidence}/crew-lead.png`, fullPage: true });

  await visitChat(dm.chat.id);
  assert.equal(await page.getByTestId("chat-lead-edit").count(), 0);
  pass("dm_no_lead_entry", "DM 无 lead 改任入口");
  await observerPage.goto(`${base}${projectPath}/chats/${group.id}`);
  await observerPage.getByTestId("project-error-meta").waitFor();
  assert.match(await observerPage.getByTestId("project-error-meta").innerText(), /not_found/);
  assert.equal(await observerPage.getByTestId("chat-lead-edit").count(), 0);
  await observerContext.close();
  pass("crew_non_owner_no_lead_entry", "非 owner Human 不可访问 Crew，也没有 lead 改任入口");
  await visitChat(group.id);
  const leadRow = page
    .getByTestId("inspector-member-list")
    .locator("li")
    .filter({ hasText: agent.name });
  await leadRow.getByTestId("chat-member-lead-badge").waitFor();
  assert.equal(await leadRow.getByTestId("chat-member-remove").count(), 0);
  assert.ok(
    db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(eq(chatEffectiveMember.chatId, group.id), eq(chatEffectiveMember.memberId, agent.id)),
      )
      .get(),
  );
  pass(
    "crew_lead_removal_blocked",
    "lead 行显示 LEAD 且不提供移除入口，Project 移除显示负责人 blocker",
  );
  const helperRow = page
    .getByTestId("inspector-member-list")
    .locator("li")
    .filter({ hasText: removable.name });
  await helperRow.getByTestId("chat-member-remove").click();
  await page.getByTestId("chat-member-remove-confirm").click();
  await page.getByTestId("chat-member-remove-dialog").waitFor({ state: "hidden" });
  await helperRow.waitFor({ state: "hidden" });
  assert.equal(
    db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(
          eq(chatEffectiveMember.chatId, group.id),
          eq(chatEffectiveMember.memberId, removable.id),
        ),
      )
      .get(),
    undefined,
  );
  pass("crew_member_removal", "Crew 非 lead 成员可单独移除，不受 Project 阻塞校验影响");

  db.update(agentRun)
    .set({ status: "aborted", settledAt: new Date() })
    .where(eq(agentRun.id, runId))
    .run();
  sqlite.prepare("DELETE FROM lease_mutation WHERE id = ?").run(lease.pendingMutationId);
  sqlite
    .prepare(
      "UPDATE machine_lease SET state = 'free', holder_instance_id = NULL WHERE machine_id = ?",
    )
    .run(lease.key.machineId);
  const assigned = sqlite.prepare("SELECT revision FROM task WHERE id = ?").get(taskId) as {
    revision: number;
  };
  mutateTask("cancel", { taskId, expectedRevision: assigned.revision }, ctx);
  await reassignLead(group.id, [agent.id, helper.id]);
  await page.goto(`${base}${projectPath}/members`);
  await memberRow(agent.name).getByTestId("member-remove").click();
  await page.getByTestId("confirm-member-mutation").click();
  await memberRow(agent.name).waitFor({ state: "hidden" });
  assert.equal(
    db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(eq(chatEffectiveMember.chatId, group.id), eq(chatEffectiveMember.memberId, agent.id)),
      )
      .get(),
    undefined,
  );
  pass("project_member_removed", "改任 lead 并解除其余阻塞后移除成功，Crew 成员事实退出");
  await visitChat(dm.chat.id);
  await page.getByTestId("archived-notice").waitFor();
  pass("removed_dm_archived", "移除后原 DM 如实显示既有归档提示");
  await page.goto(`${base}${projectPath}/members`);
  await page.getByTestId("add-member-trigger").click();
  await page.getByTestId("add-member-select").selectOption(agent.id);
  await page.getByTestId("add-member-submit").click();
  await memberRow(agent.name).waitFor();
  await visitChat(dm.chat.id);
  assert.equal(await page.getByTestId("archived-notice").count(), 0);
  assert.equal(db.select().from(chat).where(eq(chat.id, dm.chat.id)).get()?.archivedAt, null);
  pass("rejoined_dm_restored", "重新加入后原 DM 恢复，无归档提示");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("toggle-inspector").click();
  await page.getByTestId("chat-details").waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: `${evidence}/chat-390.png`, fullPage: true });
  pass("chat_mobile", "390px Chat 详情单列无横向滚动");
  writeFileSync(`${evidence}/results.json`, JSON.stringify({ count }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  sqlite.close();
}
