// 迁移后的真实导航契约：`/` 与 `/projects` 分发到 Project Chats，Project 事实在 Settings，
// 成员页是 `/projects/<id>/members`，登出与身份在 account-menu 弹层里。
export const PROJECT_CHATS = /^\/projects\/(prj_[0-9a-f-]{36})\/chats$/;

export function chatInspectorPath(chatPath) {
  return `${chatPath}?info=1`;
}

export async function navigate(page, path) {
  await page.goto(new URL(path, new URL(page.url()).origin).toString(), {
    waitUntil: "domcontentloaded",
  });
}

export function projectBase(page) {
  const id = new URL(page.url()).pathname.split("/")[2] ?? "";
  if (!/^prj_[0-9a-f-]{36}$/.test(id)) throw new Error(`不是 Project URL：${page.url()}`);
  return { id, path: `/projects/${id}`, chatsPath: `/projects/${id}/chats` };
}

export async function waitForChats(page) {
  await page.waitForURL((url) => PROJECT_CHATS.test(url.pathname), { timeout: 20000 });
  await page.waitForSelector('[data-testid="chat-list-content"]', { timeout: 20000 });
  return projectBase(page);
}

export async function currentProjectName(page) {
  return (await page.textContent('[data-testid="project-selector"]'))?.trim() ?? "";
}

export async function openCreateDialog(page) {
  await page.click('[data-testid="project-selector"]');
  await page.click('[data-testid="new-project-trigger"]');
  await page.waitForSelector('[data-testid="project-name-input"]', { timeout: 20000 });
}

export async function createProject(page, { name, description }) {
  await openCreateDialog(page);
  await page.fill('[data-testid="project-name-input"]', name);
  if (description !== undefined) {
    await page.fill('[data-testid="project-description-input"]', description);
  }
  const previousProjectId = new URL(page.url()).pathname.split("/")[2];
  await page.click('[data-testid="project-submit"]');
  await page.waitForURL(
    (url) => {
      const match = PROJECT_CHATS.exec(url.pathname);
      return match !== null && match[1] !== previousProjectId;
    },
    { timeout: 20000 },
  );
  const project = await waitForChats(page);
  // 创建成功后选择器必须收起，否则弹层会盖住新 Project 的页面。
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="new-project-trigger"]', {
    state: "detached",
    timeout: 20000,
  });
  return project;
}

export async function readProjectFacts(page) {
  await page.waitForSelector('[data-testid="project-settings-id"]', { timeout: 20000 });
  return page.evaluate(() => {
    const text = (testId) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim();
    const value = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.value;
    return {
      id: text("project-settings-id"),
      createdAt: document
        .querySelector('[data-testid="project-settings-created-at"] time')
        ?.getAttribute("datetime"),
      requestId: text("project-settings-request-id"),
      name: value("project-edit-name"),
      description: value("project-edit-description"),
    };
  });
}

export async function openAccountMenu(page) {
  await page.click('[data-testid="account-menu"]');
  await page.waitForSelector('[data-testid="session-email"]', { timeout: 20000 });
}

export async function sessionEmail(page) {
  await openAccountMenu(page);
  const email = (await page.textContent('[data-testid="session-email"]'))?.trim() ?? "";
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="session-email"]', {
    state: "detached",
    timeout: 20000,
  });
  return email;
}

export async function signOut(page) {
  await openAccountMenu(page);
  await page.click('[data-testid="sign-out"]');
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 20000 });
}

// Project Info Hub 在 Settings 的折叠区，先通过真实点击展开再读事实。
export async function openProjectInfoHub(page) {
  const panel = page.locator('[data-testid="info-hub-project-agents"]');
  if (await panel.isVisible()) return;
  await page.getByTestId("project-info-hub-toggle").click();
  await panel.waitFor({ state: "visible", timeout: 20000 });
}
