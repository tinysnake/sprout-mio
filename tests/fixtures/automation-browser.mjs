import assert from "node:assert/strict";

export async function verifyAutomationTargetPicker({ ui, page, project, beta, call, until }) {
  const chats = await call("listChatsFn", { projectId: project.id });
  const channel = chats.find((chat) => chat.kind === "public_channel");
  assert(channel, "Project has its real public channel");
  await ui.getByLabel("动作", { exact: true }).selectOption("group_agent");
  const target = ui.getByLabel("目标 Chat", { exact: true });
  assert.equal(await target.locator(`option[value="${channel.id}"]`).count(), 1);
  await target.selectOption(channel.id);
  await until(
    async () =>
      (
        await ui.getByLabel("目标 Agent", { exact: true }).locator("option").allTextContents()
      ).includes(beta.name),
    "public channel exposes effective Project worker",
  );
  await ui.getByLabel("目标 Agent", { exact: true }).selectOption(beta.id);
  await ui.getByLabel("动作", { exact: true }).selectOption("dm_agent");
  assert.equal(await ui.getByLabel("目标 Chat", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "automation create page fits mobile viewport",
  );
  assert(
    await ui.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "automation PageFrame has no horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function verifyAutomationUnknownRoute({ page, base, project, kind }) {
  await page.goto(`${base}/projects/${project.id}/settings/${kind}/wr_missing`, {
    waitUntil: "networkidle",
  });
  const editor = page.getByTestId(`${kind}-editor-page`);
  await editor.getByRole("alert").filter({ hasText: "该规则不存在" }).waitFor();
  assert.equal(
    await editor.getByRole("button", { name: /^保存/ }).count(),
    0,
    "unknown direct rule URL never becomes a create form",
  );
  await editor.getByRole("link", { name: /^返回/ }).click();
  assert.equal(new URL(page.url()).searchParams.get("tab"), kind);
  assert(
    (await page
      .getByRole("navigation", { name: "Project 设置分类" })
      .getByRole("link", { name: kind === "cron" ? "定时任务" : "Webhooks", exact: true })
      .getAttribute("aria-current")) === "page",
  );
}
