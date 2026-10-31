import { runProduction, pass, assert } from "./p7-client-harness.mjs";
await runProduction(async ({ page, context, base, seeded: s, login, directory }) => {
  const targets = [
    [`/projects/${s.projectId}/settings`, "P7 深链 Project"],
    [`/agents/${s.agentId}`, "P7 Agent"],
    [`/machines/${s.machineId}`, "P7 Machine"],
    [`/projects/${s.projectId}/tasks/${s.taskId}`, "P7 Task"],
    [`/projects/${s.projectId}/chats/${s.dmId}?info=1`, "P7 Agent"],
    [`/projects/${s.projectId}/chats/${s.groupId}?info=1`, "P7 Group"],
    [`/projects/${s.projectId}/chats/${s.channelId}?info=1`, "公共频道"],
  ];
  for (const [path, text] of targets) {
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    await page.getByText(text, { exact: false }).first().waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(text, { exact: false }).first().waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    await page.goto(base + "/management", { waitUntil: "domcontentloaded" });
    await page.getByTestId("management-page").waitFor();
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.getByText(text, { exact: false }).first().waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.getByTestId("management-page").waitFor();
    pass("detail_direct_refresh_back_forward", { path });
  }
  await page.goto(base + `/projects/${s.projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === `/projects/${s.projectId}/chats`);
  await page.getByTestId("chat-list-content").waitFor();
  pass("project_root_redirects_to_chats", { projectId: s.projectId });
  const contextTargets = [
    [`/machines/${s.machineId}?projectId=${s.projectId}`, "machine-detail-name"],
    [`/machines/${s.machineId}/lease?projectId=${s.projectId}`, "machine-lease-page"],
    [
      `/agents/${s.agentId}?fromProjectId=${s.projectId}&fromChatId=${s.dmId}`,
      "agent-detail-back-to-chat",
    ],
  ];
  for (const [path, testId] of contextTargets) {
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    await page.getByTestId(testId).waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId(testId).waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    await page.goto(base + "/management", { waitUntil: "domcontentloaded" });
    await page.getByTestId("management-page").waitFor();
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.getByTestId(testId).waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, path);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.getByTestId("management-page").waitFor();
    pass("context_deep_link_refresh_back_forward", { path });
  }
  for (const width of [1440, 980, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + "/management", { waitUntil: "domcontentloaded" });
    const management = page.getByTestId(width <= 900 ? "mobile-management" : "nav-management");
    await management.waitFor({ state: "visible" });
    assert.equal(await management.getAttribute("href"), "/management");
    await management.click();
    await page.getByRole("heading", { name: "服务与数据", exact: true }).waitFor();
    await page.getByRole("heading", { name: "账号与外观", exact: true }).waitFor();
    const nav =
      width <= 900
        ? page.getByTestId("mobile-primary-nav")
        : page.locator('nav[aria-label="一级导航"]');
    assert.equal(await nav.getByRole("link", { name: "Agents", exact: true }).count(), 1);
    assert.equal(await nav.getByRole("link", { name: "Machines", exact: true }).count(), 1);
    assert.equal(await nav.getByRole("button", { name: "Projects", exact: true }).count(), 1);
    assert.equal((await page.locator("body").innerText()).includes("未实现"), false);
    await management.focus();
    assert.equal(await management.evaluate((node) => node === document.activeElement), true);
    for (const theme of ["dark", "light"]) {
      const toggle = page.getByTestId("management-page").getByTestId("theme-toggle");
      if ((await toggle.getAttribute("data-theme")) !== theme) await toggle.click();
      assert.equal(await toggle.getAttribute("data-theme"), theme);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: `${directory}/management-${width}-${theme}.png` });
    }
    pass("four_navigation_theme_keyboard_no_overflow", { width });
    for (const [name, path] of [
      ["Agents", "/agents"],
      ["Machines", "/machines"],
    ]) {
      await nav.getByRole("link", { name, exact: true }).click();
      await page.waitForURL(base + path);
      await page.getByTestId(width <= 900 ? "mobile-management" : "nav-management").click();
      await page.getByTestId("management-page").waitFor();
    }
    const projects = nav.getByRole("button", { name: "Projects", exact: true });
    await projects.click();
    if (width > 900 && (await projects.getAttribute("aria-expanded")) === "false")
      await projects.click();
    await page
      .getByTestId("project-submenu")
      .getByRole("link", { name: "Chats", exact: true })
      .click();
    await page.waitForURL((url) => /\/projects\/[^/]+\/chats$/.test(url.pathname));
    pass("four_primary_entries_are_operable", { width });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const target = targets[4][0];
  await context.clearCookies();
  await page.goto(base + target, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(new URL(page.url()).searchParams.get("next"), target);
  await login();
  await page.getByTestId("message-send").waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, target);
  pass("login_restores_deep_target_and_query", { target });
  await context.clearCookies();
  await page.goto(base + "/login?next=https%3A%2F%2Fevil.example", {
    waitUntil: "domcontentloaded",
  });
  await login();
  await page.waitForURL((url) => url.pathname === "/projects", { timeout: 30000 });
  assert.equal(new URL(page.url()).origin, base);
  pass("external_next_rejected");
  const invalid = [
    "/agents/agp_00000000-0000-4000-8000-000000000000",
    "/machines/mch_00000000-0000-4000-8000-000000000000",
    `/projects/${s.projectId}/tasks/tsk_00000000-0000-4000-8000-000000000000`,
    `/projects/${s.projectId}/chats/cnv_00000000-0000-4000-8000-000000000000`,
    "/projects/prj_00000000-0000-4000-8000-000000000000/settings",
    `/machines/mch_00000000-0000-4000-8000-000000000000/lease?projectId=${s.projectId}`,
    "/this-page-does-not-exist",
  ];
  for (const path of invalid) {
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    await page
      .getByText(/不存在|已删除|格式|无权|找不到|无效/)
      .first()
      .waitFor();
    pass("invalid_or_deleted_target_explained", { path });
  }
});
