// DM + Crew 正式页面：真实注册、成员治理、标题、消息持久化与窄屏。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createProject, waitForChats, waitForRailChat } from "./ui-navigation.mjs";

const BASE = process.env.BASE_URL;
const EVIDENCE = process.env.SPROUT_UI_EVIDENCE_DIR;
assert(BASE && EVIDENCE && process.env.DATABASE_URL, "isolated browser harness is required");
mkdirSync(EVIDENCE, { recursive: true });
const results = [];
function record(id, passed, detail = "") {
  results.push({ id, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${id} :: ${detail}`);
  assert(passed, `${id}: ${detail}`);
}
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const database = new Database(process.env.DATABASE_URL, { readonly: true });
const shot = (name) => page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: true });
let crewPath;
let dmPath;
try {
  const stamp = Date.now();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("register-tab").click();
  await page.locator('input[name="name"]').fill("Crew UI Human");
  await page.locator('input[name="email"]').fill(`crew-ui-${stamp}@example.test`);
  await page.locator('input[name="password"]').fill(randomBytes(24).toString("base64url"));
  await page.locator('button[type="submit"]').click();
  await waitForChats(page);
  record("browser_session_registered", true);
  const project = await createProject(page, {
    name: `Crew UI ${stamp}`,
    description: "DM + Crew gate",
  });
  record("project_created_to_chats", true, project.path);
  const crewItem = page.locator('[data-testid="chat-item"][data-chat-kind="crew"]');
  await crewItem.waitFor();
  record("crew_present_in_list", (await crewItem.count()) === 1);
  record(
    "chat_filters_dm_and_crew",
    (await page.getByTestId("filter-dm").count()) === 1 &&
      (await page.getByTestId("filter-crew").count()) === 1,
  );
  const names = [`Lead ${stamp}`, `Worker ${stamp}`];
  for (const name of names) {
    await page.getByTestId("nav-agents").click();
    await page.waitForURL((url) => url.pathname === "/agents");
    await page.getByTestId("new-agent-trigger").click();
    await page.getByTestId("agent-name-input").fill(name);
    await page.getByTestId("agent-persona-input").fill("Crew browser fixture");
    await page.getByTestId("agent-submit").click();
    await page.getByTestId("agent-item-name").filter({ hasText: name }).waitFor();
    await page.goto(`${BASE}${project.path}/members`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("add-member-trigger").click();
    await page.getByTestId("add-member-select").selectOption({ label: name });
    await page.getByTestId("add-member-submit").click();
    await page.getByTestId("member-item-name").filter({ hasText: name }).waitFor();
  }
  record("agent_members_created", true);
  await page.goto(`${BASE}${project.path}/chats`, { waitUntil: "domcontentloaded" });
  await crewItem.click();
  await page.waitForURL((url) => /\/chats\/[^/]+$/.test(url.pathname));
  crewPath = new URL(page.url()).pathname;
  const crewId = crewPath.split("/").at(-1);
  await waitForRailChat(page, crewId);
  record(
    "crew_human_owner",
    (await page.getByTestId("chat-owner-name").textContent()).includes("Human"),
  );
  record(
    "crew_initial_lead",
    (await page.getByTestId("chat-member-lead-badge").locator("..").textContent()).includes(
      names[0],
    ),
  );
  record(
    "crew_explicit_members",
    (await page.getByTestId("chat-member-select").count()) === 1,
    "Project worker is not automatically a Crew member",
  );
  const boxes = await page.evaluate(() =>
    ["chat-list-panel", "chat-detail-panel", "chat-inspector"].map((id) => {
      const rect = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return rect && { x: rect.x, width: rect.width };
    }),
  );
  record(
    "three_columns_visible",
    boxes.every((box) => box?.width > 0) && boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x,
    JSON.stringify(boxes),
  );
  record(
    "crew_details_sections",
    (await page.getByTestId("chat-details-members").count()) === 1 &&
      (await page.getByTestId("chat-details-owner").count()) === 1 &&
      (await page.getByTestId("chat-details-activity").count()) === 1,
  );
  record(
    "crew_details_drop_instance_row",
    (await page.getByTestId("inspector-instance-id").count()) === 0,
  );
  record(
    "crew_governance_entries_unique",
    (await page.getByTestId("chat-lead-edit").count()) === 1 &&
      (await page.getByTestId("chat-member-add").count()) === 1,
  );
  await page.getByTestId("chat-member-add").click();
  await page.getByTestId("chat-member-add-select").selectOption({ label: names[1] });
  await page.getByTestId("chat-member-add-submit").click();
  await page.getByTestId("chat-member-select").filter({ hasText: names[1] }).waitFor();
  record(
    "crew_worker_added_explicitly",
    (await page.getByTestId("chat-member-select").count()) === 2,
  );
  await page.getByTestId("chat-member-select").filter({ hasText: names[1] }).click();
  record(
    "member_row_selects_profile",
    (await page.getByTestId("inspector-agent-name").textContent()).includes(names[1]),
  );
  const ownerBefore = await page.getByTestId("chat-owner-name").textContent();
  await page.getByTestId("chat-lead-edit").click();
  record(
    "crew_governance_note_in_lead_dialog",
    (await page.getByTestId("chat-lead-dialog").getByTestId("chat-governance-note").count()) === 1,
  );
  await page.getByTestId("chat-lead-select").selectOption({ label: names[1] });
  await page.getByTestId("chat-lead-submit").click();
  await page.waitForFunction(
    (name) =>
      document
        .querySelector('[data-testid="chat-member-lead-badge"]')
        ?.parentElement?.textContent.includes(name),
    names[1],
  );
  record("crew_lead_transferred", true);
  record(
    "crew_owner_unchanged_after_transfer",
    (await page.getByTestId("chat-owner-name").textContent()) === ownerBefore,
  );
  record(
    "crew_lead_has_no_remove_button",
    (await page
      .getByTestId("chat-member-lead-badge")
      .locator("..")
      .getByTestId("chat-member-remove")
      .count()) === 0,
  );
  await page.getByTestId("chat-title-edit").click();
  await page.getByTestId("chat-title-input").fill("   ");
  await page.getByTestId("chat-title-save").click();
  await page.getByTestId("chat-title-dialog").waitFor({ state: "hidden" });
  record(
    "crew_blank_title_restores_default",
    database.prepare("SELECT title FROM chat WHERE id=?").get(crewId).title === null,
  );
  await page.getByTestId("chat-title-edit").click();
  const renamed = `Crew renamed ${stamp}`;
  await page.getByTestId("chat-title-input").fill(renamed);
  await page.getByTestId("chat-title-save").click();
  await page.getByTestId("chat-title-dialog").waitFor({ state: "hidden" });
  record(
    "crew_title_edited_from_details_rail",
    (await page.getByTestId("chat-details-title").textContent()).includes(renamed),
  );
  const message = `@${names[0]} @${names[1]} Crew human message ${stamp}`;
  await page.getByTestId("message-input").fill(message);
  await page.getByTestId("message-send").click();
  await page
    .getByTestId("message-body")
    .filter({ hasText: `Crew human message ${stamp}` })
    .waitFor();
  record(
    "crew_message_actual_sender",
    database
      .prepare("SELECT sender_kind FROM message WHERE chat_id=? AND body=?")
      .get(crewId, message)?.sender_kind === "human",
  );
  const runs = database
    .prepare(
      "SELECT i.agent_profile_id,p.name FROM agent_run r JOIN agent_instance i ON i.id=r.instance_id JOIN agent_profile p ON p.id=i.agent_profile_id WHERE r.chat_id=?",
    )
    .all(crewId);
  record(
    "crew_human_message_only_wakes_lead",
    runs.length === 1 && runs[0].name === names[1],
    JSON.stringify(runs),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByTestId("message-body")
    .filter({ hasText: `Crew human message ${stamp}` })
    .waitFor();
  record("crew_message_persisted_after_reload", true);
  record(
    "chat_page_hides_request_id",
    !/req_[0-9a-f]{8,}/.test(await page.getByTestId("chat-pane").textContent()),
  );
  await shot("crew-desktop");
  await page.getByTestId("new-chat").click();
  await page.getByTestId("dm-member-list").waitFor();
  record(
    "new_chat_dialog_only_dm",
    (await page.getByTestId("new-chat-mode-group").count()) === 0 &&
      (await page.getByTestId("dm-start").count()) === 2,
  );
  await page
    .getByTestId("dm-member-item")
    .filter({ hasText: names[0] })
    .getByTestId("dm-start")
    .click();
  await page.waitForURL((url) => url.pathname.includes("/chats/") && url.pathname !== crewPath);
  dmPath = new URL(page.url()).pathname;
  await waitForRailChat(page, dmPath.split("/").at(-1));
  record(
    "dm_keeps_counterpart_and_activity_only",
    (await page.getByTestId("chat-details-counterpart").count()) === 1 &&
      (await page.getByTestId("chat-details-activity").count()) === 1 &&
      (await page.getByTestId("chat-details-members").count()) === 0 &&
      (await page.getByTestId("chat-details-owner").count()) === 0,
  );
  record(
    "dm_has_no_crew_governance",
    (await page.getByTestId("chat-lead-edit").count()) === 0 &&
      (await page.getByTestId("chat-member-add").count()) === 0,
  );
  await shot("dm-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${crewPath}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("chat-title").waitFor();
  record(
    "mobile_390_no_horizontal_overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  );
  await page.getByTestId("toggle-inspector").click();
  await page.getByTestId("chat-inspector").waitFor();
  record(
    "mobile_details_screen_no_overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  );
  await shot("crew-mobile");
  record("no_console_errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  results.push({ id: "flow_exception", passed: false, detail: String(error) });
  console.error(error);
  await shot("failure").catch(() => {});
} finally {
  writeFileSync(`${EVIDENCE}/results.json`, JSON.stringify({ crewPath, dmPath, results }, null, 2));
  database.close();
  await browser.close();
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
