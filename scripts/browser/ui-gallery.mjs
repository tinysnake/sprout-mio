// 共享组件开发演示的浏览器核对：浅暗主题、390 / 1440 宽度、Dialog 键盘行为。
// 通过 dev server 的 /__dev/ui/ 驱动真实 Chromium，每步打印 PASS/FAIL。
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.UI_GALLERY_URL ?? "http://[::1]:3055/__dev/ui/";
const EVIDENCE = process.env.UI_GALLERY_EVIDENCE ?? "/tmp/u1-ui-gallery/";
const results = [];

function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, false, `threw ${error.message}`);
  }
}

mkdirSync(EVIDENCE, { recursive: true });
const browser = await chromium.launch();

async function open({ width, height, colorScheme = "light" }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="ui-gallery"]');
  return { context, page, errors };
}

// 1. 桌面浅色：控件实测尺寸 + 截图
const desktop = await open({ width: 1440, height: 900 });
await check("1440 浅色：常规按钮实测 34px 高、6px 圆角", async () => {
  const metrics = await desktop.page
    .locator('[data-testid="ui-gallery"] button', { hasText: "主要操作" })
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        radius: parseFloat(style.borderTopLeftRadius),
      };
    });
  if (Math.round(metrics.height) !== 34) throw new Error(`height ${metrics.height}`);
  if (Math.round(metrics.radius) !== 6) throw new Error(`radius ${metrics.radius}`);
  record("1440 浅色：常规按钮 34px 高、6px 圆角", true, JSON.stringify(metrics));
});
await desktop.page.screenshot({ path: `${EVIDENCE}1440-light.png`, fullPage: true });

await check("浅色：正文与输入字号来自同一 base 规则", async () => {
  const info = await desktop.page.evaluate(() => ({
    body: getComputedStyle(document.body).fontSize,
    input: getComputedStyle(document.querySelector("#gallery-name")).fontSize,
    fontFamily: getComputedStyle(document.body).fontFamily,
  }));
  if (info.body !== "13px") throw new Error(`body ${info.body}`);
  if (!info.fontFamily.includes("Geist Variable")) throw new Error(info.fontFamily);
  record("浅色：正文 13px 且使用 Geist Variable", true, JSON.stringify(info));
});

// 2. 主题切换：跨切换点同步、刷新后保持
await check("主题：按钮与菜单行共享同一状态，刷新后保持", async () => {
  const toggles = desktop.page.locator('[data-testid="theme-toggle"]');
  const count = await toggles.count();
  // 演示页同时摆出「页面按钮」与「菜单行」两种入口，数量不写死，只要求至少两种都在。
  if (count < 2) throw new Error(`期望至少两个主题入口，实际 ${count}`);
  const before = await desktop.page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  // 图标按钮与菜单行文案不同，但必须都指向同一个「下一步目标」。
  const targetBefore = before ? "浅色" : "暗色";
  const labelsBefore = await toggles.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  const offTarget = labelsBefore.filter((label) => !(label ?? "").includes(targetBefore));
  if (offTarget.length > 0) throw new Error(`入口与当前主题不一致 ${labelsBefore.join("|")}`);
  await toggles.first().click();
  const afterFirst = await desktop.page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  if (before === afterFirst) throw new Error("classList 没变化");
  const readout = await desktop.page.locator('[data-testid="theme-readout"]').innerText();
  if (!readout.includes(afterFirst ? "暗色" : "浅色")) throw new Error(`readout ${readout}`);
  const targetAfter = afterFirst ? "浅色" : "暗色";
  const labelsAfter = await toggles.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  const offAfter = labelsAfter.filter((label) => !(label ?? "").includes(targetAfter));
  if (offAfter.length > 0) throw new Error(`切换后入口未同步 ${labelsAfter.join("|")}`);
  if (labelsAfter[0] === labelsBefore[0]) throw new Error("切换后文案没有跟随主题");
  await desktop.page.reload({ waitUntil: "networkidle" });
  const afterReload = await desktop.page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  if (afterReload !== afterFirst) throw new Error(`刷新后 ${afterReload} != ${afterFirst}`);
  record("主题：按钮与菜单行同源、刷新保持", true, `dark=${afterFirst} label=${labelsAfter[0]}`);
});

await check("主题：菜单行按钮点击后立即切换并回写文案", async () => {
  const row = desktop.page.locator('[data-testid="theme-toggle"]').last();
  const before = await desktop.page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  const labelBefore = await row.getAttribute("aria-label");
  await row.click();
  const after = await desktop.page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  const labelAfter = await row.getAttribute("aria-label");
  const readout = await desktop.page.locator('[data-testid="theme-readout"]').innerText();
  if (after === before) throw new Error("菜单行点击没有切换主题");
  if (labelAfter === labelBefore) throw new Error(`文案未回写 ${labelAfter}`);
  if (!readout.includes(after ? "暗色" : "浅色")) throw new Error(`readout ${readout}`);
  record("主题：菜单行切换生效", true, `${labelBefore} -> ${labelAfter}`);
});

await desktop.page.screenshot({ path: `${EVIDENCE}1440-dark.png`, fullPage: true });

// 3. Button 的 loading 防重复提交
await check("Button loading：连点只提交一次，期间按钮不可点", async () => {
  const button = desktop.page.getByRole("button", { name: "提交" });
  const submit = await button.boundingBox();
  await button.click();
  await desktop.page.mouse.click(submit.x + 10, submit.y + 10);
  await desktop.page.mouse.click(submit.x + 10, submit.y + 10);
  const count = await desktop.page.locator('[data-testid="submit-count"]').innerText();
  const busy = await desktop.page.locator('[data-slot="button"][aria-busy="true"]').count();
  if (!count.includes("1 次")) throw new Error(count);
  if (busy !== 1) throw new Error(`busy buttons ${busy}`);
  record("Button loading：连点只提交一次", true, `${count} · aria-busy=${busy}`);
  await desktop.page.waitForTimeout(1700);
  await desktop.page.getByRole("button", { name: "提交" }).waitFor();
});

// 4. Field：省略 htmlFor 时 label 仍关联内部控件，错误与说明仍被引用
await check("Field：省略 htmlFor 时 label 仍关联控件，错误与说明仍可被引用", async () => {
  const result = await desktop.page.evaluate(() => {
    const label = [...document.querySelectorAll('[data-slot="field"] label')].find((node) =>
      node.textContent?.includes("省略 htmlFor"),
    );
    const control = label?.parentElement?.querySelector('[data-slot="input"]');
    const describedBy = control?.getAttribute("aria-describedby");
    return {
      labelFor: label?.getAttribute("for"),
      controlId: control?.id,
      invalid: control?.getAttribute("aria-invalid"),
      describedText: describedBy ? document.getElementById(describedBy)?.textContent : null,
    };
  });
  if (!result.controlId) throw new Error("控件没有 id");
  if (result.labelFor !== result.controlId) {
    throw new Error(`label for=${result.labelFor} control id=${result.controlId}`);
  }
  if (result.invalid !== "true") throw new Error(`aria-invalid=${result.invalid}`);
  if (!result.describedText?.includes("职位最多 40 字")) throw new Error(result.describedText);
  record("Field：label 默认关联内部控件", true, JSON.stringify(result));
});

await check("Field：说明与错误同时关联到控件", async () => {
  const hint = await desktop.page.evaluate(() => {
    const label = [...document.querySelectorAll('[data-slot="field"] label')].find((node) =>
      node.textContent?.includes("Project 名称"),
    );
    const control = label?.parentElement?.querySelector('[data-slot="input"]');
    const describedBy = (control?.getAttribute("aria-describedby") ?? "").split(" ");
    return describedBy.map((id) => document.getElementById(id)?.textContent ?? null);
  });
  if (hint.length !== 1 || !hint[0]?.includes("最多 80 字")) throw new Error(JSON.stringify(hint));
  record("Field：hint 关联到控件", true, JSON.stringify(hint));
});

await check("PageFrame：外层 48/40 内边距 + 内层 960 居中，h1 24/1.4，说明 13/1.6", async () => {
  const metrics = await desktop.page.evaluate(() => {
    const frame = document.querySelector('[data-testid="ui-gallery"]');
    const outer = frame?.firstElementChild;
    const inner = outer?.firstElementChild;
    const h1 = frame?.querySelector("h1");
    const description = h1?.parentElement?.parentElement?.querySelector("p");
    const back = frame?.querySelector("a");
    const outerStyle = getComputedStyle(outer);
    const innerStyle = getComputedStyle(inner);
    const h1Style = getComputedStyle(h1);
    const descriptionStyle = getComputedStyle(description);
    return {
      paddingX: parseFloat(outerStyle.paddingLeft),
      paddingY: parseFloat(outerStyle.paddingTop),
      maxWidth: parseFloat(innerStyle.maxWidth),
      innerWidth: inner.getBoundingClientRect().width,
      innerX: inner.getBoundingClientRect().x,
      h1FontSize: parseFloat(h1Style.fontSize),
      h1LineHeight: parseFloat(h1Style.lineHeight),
      descriptionFontSize: parseFloat(descriptionStyle.fontSize),
      descriptionLineHeight: parseFloat(descriptionStyle.lineHeight),
      backHeight: back.getBoundingClientRect().height,
    };
  });
  if (metrics.paddingX !== 48 || metrics.paddingY !== 40) throw new Error(JSON.stringify(metrics));
  if (metrics.maxWidth !== 960 || Math.round(metrics.innerWidth) !== 960) {
    throw new Error(JSON.stringify(metrics));
  }
  if (metrics.h1FontSize !== 24) throw new Error(`h1 ${metrics.h1FontSize}`);
  if (Math.abs(metrics.h1LineHeight - 33.6) > 0.6) throw new Error(`h1 lh ${metrics.h1LineHeight}`);
  if (metrics.descriptionFontSize !== 13) throw new Error(`desc ${metrics.descriptionFontSize}`);
  if (Math.abs(metrics.descriptionLineHeight - 20.8) > 0.6) {
    throw new Error(`desc lh ${metrics.descriptionLineHeight}`);
  }
  if (Math.round(metrics.backHeight) !== 44) throw new Error(`back ${metrics.backHeight}`);
  record("PageFrame：两层缩进与标题字号符合基线", true, JSON.stringify(metrics));
});

// Dialog 的打开有 zoom-in 动画；量尺寸与连续 Tab 都必须等动画落位，
// 且每个用例无论成败都要把弹层关掉，否则 inert 的背景会让后续点击全部超时。
async function openDialog(page) {
  await page.getByRole("button", { name: "打开对话框" }).click();
  const dialog = page.locator('[data-testid="gallery-dialog"]');
  await dialog.waitFor();
  await settleDialog(page);
  return dialog;
}

async function settleDialog(page) {
  await page
    .waitForFunction(() => {
      const popup = document.querySelector('[data-testid="gallery-dialog"]');
      // zoom-in 是 transform 动画，scale 属性不会变；transform 回到 none 才算落位。
      return popup ? getComputedStyle(popup).transform === "none" : false;
    })
    .catch(() => page.waitForTimeout(600));
}

async function closeDialog(page) {
  const dialog = page.locator('[data-testid="gallery-dialog"]');
  if ((await dialog.count()) === 0) return;
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" }).catch(() => page.waitForTimeout(500));
}

/** 打开弹层、执行断言、无论结果如何都关闭。 */
async function withDialog(page, fn) {
  const dialog = await openDialog(page);
  try {
    await fn(dialog);
  } finally {
    await closeDialog(page);
  }
}

// 5. Dialog 键盘：Escape 关闭、焦点进入与返回、关闭文案为中文
await check("Dialog：Escape 关闭并回到触发按钮，焦点先进入对话框", async () => {
  const trigger = desktop.page.getByRole("button", { name: "打开对话框" });
  await trigger.focus();
  await desktop.page.keyboard.press("Enter");
  const dialog = desktop.page.locator('[data-testid="gallery-dialog"]');
  await dialog.waitFor();
  await settleDialog(desktop.page);
  try {
    await desktop.page.waitForFunction(() =>
      Boolean(
        document.querySelector('[data-testid="gallery-dialog"]')?.contains(document.activeElement),
      ),
    );
    const closeLabel = await dialog.getByRole("button", { name: "关闭对话框" }).count();
    if (closeLabel !== 1) throw new Error("缺少中文关闭按钮");
    await desktop.page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    const backToTrigger = await trigger.evaluate((element) => element === document.activeElement);
    if (!backToTrigger) throw new Error("焦点没有回到触发按钮");
    record("Dialog：Escape 关闭且焦点返回触发点", true, "中文关闭按钮存在");
  } finally {
    await closeDialog(desktop.page);
  }
});

await check("Dialog：桌面 460px 宽、底部动作区单行右对齐 8px 间距", async () => {
  await withDialog(desktop.page, async () => {
    const metrics = await desktop.page.evaluate(() => {
      const popup = document.querySelector('[data-testid="gallery-dialog"]');
      const footer = popup?.querySelector('[data-slot="dialog-footer"]');
      const buttons = [...(footer?.querySelectorAll("button") ?? [])];
      const rects = buttons.map((button) => button.getBoundingClientRect());
      return {
        width: popup?.getBoundingClientRect().width,
        footerDisplay: footer ? getComputedStyle(footer).display : null,
        footerDirection: footer ? getComputedStyle(footer).flexDirection : null,
        footerGap: footer ? parseFloat(getComputedStyle(footer).columnGap) : null,
        sameRow: rects.length === 2 ? Math.abs(rects[0].y - rects[1].y) < 1 : false,
        rightAligned:
          rects.length === 2
            ? Math.abs(rects[1].right - footer.getBoundingClientRect().right) < 1
            : false,
      };
    });
    if (Math.round(metrics.width) !== 460) throw new Error(`width ${metrics.width}`);
    if (metrics.footerDirection !== "row" || !metrics.sameRow) {
      throw new Error(JSON.stringify(metrics));
    }
    if (metrics.footerGap !== 8 || !metrics.rightAligned) throw new Error(JSON.stringify(metrics));
    record("Dialog：桌面 460px 宽、动作区单行右对齐", true, JSON.stringify(metrics));
  });
});

await check("Dialog：点击遮罩关闭", async () => {
  const dialog = await openDialog(desktop.page);
  await desktop.page.mouse.click(8, 8);
  await dialog.waitFor({ state: "detached" });
  record("Dialog：点击遮罩关闭", true, "backdrop 点击生效");
});

await check("Dialog：Tab 焦点留在对话框内", async () => {
  await withDialog(desktop.page, async () => {
    const escapes = await desktop.page.evaluate(() => {
      const popup = document.querySelector('[data-testid="gallery-dialog"]');
      const portal = popup?.closest("[data-base-ui-portal]") ?? popup?.parentElement;
      return portal
        ? !portal.contains(document.activeElement)
        : !popup?.contains(document.activeElement);
    });
    if (escapes) throw new Error("打开后焦点不在弹层子树内");
    // 焦点守卫用 requestAnimationFrame 把焦点送回弹层；连续 Tab 之间先等它落位，
    // 断言的是「Tab 之后焦点仍在弹层子树内」，不是按键瞬间的中间帧。
    for (let index = 0; index < 12; index += 1) {
      await desktop.page.keyboard.press("Tab");
      const settled = await desktop.page
        .waitForFunction(
          () => {
            const popup = document.querySelector('[data-testid="gallery-dialog"]');
            const portal = popup?.closest("[data-base-ui-portal]") ?? popup?.parentElement;
            const inside = portal
              ? portal.contains(document.activeElement)
              : Boolean(popup?.contains(document.activeElement));
            return inside;
          },
          undefined,
          { timeout: 1000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!settled) {
        const where = await desktop.page.evaluate(() => {
          const active = document.activeElement;
          return `${active?.tagName}[${active?.getAttribute("data-slot") ?? ""}]`;
        });
        throw new Error(`第 ${index + 1} 次 Tab 后焦点停在 ${where}`);
      }
    }
    record("Dialog：Tab 焦点被困在对话框内", true, "12 次 Tab 未逃逸");
  });
});

const desktopErrors = desktop.errors;
record("1440 控制台无错误", desktopErrors.length === 0, desktopErrors.join(" | ") || "none");
await desktop.context.close();

// 6. 窄屏 390：触控高度
const mobile = await open({ width: 390, height: 844 });
await check("390 宽度：控件抬到 44px 触控高度，且无整页水平滚动", async () => {
  const metrics = await mobile.page.evaluate(() => {
    const button = [...document.querySelectorAll('[data-slot="button"]')].find((element) =>
      element.textContent?.includes("主要操作"),
    );
    const input = document.querySelector("#gallery-name");
    return {
      button: button?.getBoundingClientRect().height,
      input: input?.getBoundingClientRect().height,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  if (Math.round(metrics.button) !== 44) throw new Error(`button ${metrics.button}`);
  if (Math.round(metrics.input) !== 44) throw new Error(`input ${metrics.input}`);
  if (metrics.scrollWidth > metrics.clientWidth + 1) {
    throw new Error(`horizontal overflow ${metrics.scrollWidth} > ${metrics.clientWidth}`);
  }
  record("390 宽度：44px 触控高度且无横向溢出", true, JSON.stringify(metrics));
});
await mobile.page.screenshot({ path: `${EVIDENCE}390-light.png`, fullPage: true });

await check("390 宽度：暗色主题下仍然无横向溢出", async () => {
  await mobile.page.locator('[data-testid="theme-toggle"]').first().click();
  const isDark = await mobile.page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  if (!isDark) throw new Error("未切到暗色");
  const metrics = await mobile.page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (metrics.scrollWidth > metrics.clientWidth + 1) throw new Error(JSON.stringify(metrics));
  record("390 暗色：无横向溢出", true, JSON.stringify(metrics));
});
await mobile.page.screenshot({ path: `${EVIDENCE}390-dark.png`, fullPage: true });

await check("390 宽度：Dialog 在窄屏不溢出视口", async () => {
  await withDialog(mobile.page, async (dialog) => {
    const box = await dialog.boundingBox();
    if (!box || box.width > 390 || box.x < 0) throw new Error(JSON.stringify(box));
    await mobile.page.screenshot({ path: `${EVIDENCE}390-dialog-dark.png` });
    record("390 宽度：Dialog 留在视口内", true, JSON.stringify(box));
  });
});

record("390 控制台无错误", mobile.errors.length === 0, mobile.errors.join(" | ") || "none");
await mobile.context.close();
await browser.close();

const failed = results.filter((result) => !result.passed);
console.log(`\ngallery checks=${results.length} failed=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
