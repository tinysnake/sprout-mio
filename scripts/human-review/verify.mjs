import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { allowedRequest, localAppUrl, resolveEntry, startReview } from "./review.mjs";

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const extension = option("--dom-capture");
const host = option("--host") || "localhost";
assert.ok(
  extension,
  "请通过 --dom-capture <扩展目录> 指定已支持 Copy ID / Copy DOM path 的 DOM Capture",
);
const root = await mkdtemp(path.join(os.tmpdir(), "sprout-human-review-"));
const evidence = path.resolve(option("--evidence") || ".verify/human-review-evidence");
await mkdir(evidence, { recursive: true });
const results = [];
const pass = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
const until = async (check, label) => {
  for (let n = 0; n < 100; n++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};
let context, review, cli;
const stop = async () => {
  if (!cli || cli.exitCode !== null || cli.signalCode) return;
  const closed = new Promise((resolve) => cli.once("close", resolve));
  cli.kill("SIGTERM");
  const timer = setTimeout(() => cli.kill("SIGKILL"), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
};
const fixtureState = { devLogin: false };
const fixture = createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/dev-login") {
    res.writeHead(fixtureState.devLogin ? 200 : 404, { "cache-control": "no-store" }).end();
    return;
  }
  if (pathname === "/sign-in") {
    res
      .writeHead(302, {
        "set-cookie": "review_session=authenticated; HttpOnly; SameSite=Lax; Path=/",
        location: "/settings",
      })
      .end();
    return;
  }
  const signedIn = req.headers.cookie?.includes("review_session=authenticated");
  if (pathname === "/settings" && !signedIn) {
    res.writeHead(302, { location: "/login" }).end();
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><head><title>Human review browser fixture</title></head><body>
    <h1>${signedIn ? "已登录的设置页面" : "登录测试场景"}</h1>
    <p>仅用于验证开发工具，不是 Sprout 产品页面。</p>
    <form action="/sign-in"><button id="sign-in">登录</button></form>
    <a href="/settings" id="open-settings">设置</a> <a href="/next" id="open-next">下一页</a>
    <button id="save:settings">保存设置</button>
    <label>草稿 <input id="review-draft"></label></body></html>`);
});
await new Promise((resolve) => fixture.listen(0, host, resolve));
const appUrl = `http://${host}:${fixture.address().port}/login`;
const port = Number(option("--port") || 4430);
const lavishPort = port + 1;
try {
  for (const url of [
    "https://localhost:3000",
    "http://example.com",
    "http://8.8.8.8:3000",
    "http://user:pass@localhost",
    "file:///tmp/app.html",
  ]) {
    assert.throws(() => localAppUrl(url));
  }
  for (const url of [
    "http://127.0.0.1:3000/login",
    "http://192.168.1.10:3000/login",
    "http://192.168.1.5:3000/login",
    "http://172.20.0.2:3000/login",
    "http://100.101.102.103:3000/login",
    "http://mio.local:3000/login",
  ]) {
    assert.equal(localAppUrl(url).href, url);
  }
  for (const host of [
    "192.168.1.10:4400",
    "127.0.0.1:4400",
    "mio.local:4400",
    "example.com:4400",
  ]) {
    const request = { headers: { host } };
    assert.equal(
      allowedRequest(request, 4400),
      host !== "example.com:4400",
      `预览代理对 ${host} 的判定`,
    );
    assert.equal(
      allowedRequest({ headers: { host, origin: `http://${host}` } }, 4400),
      host !== "example.com:4400",
    );
    assert.equal(
      allowedRequest({ headers: { host, origin: "https://evil.example" } }, 4400),
      false,
    );
  }
  pass("可信预览接受回环与内网地址，拒绝公网域名、凭据 URL 和非 HTTP 协议");
  const fixtureOrigin = new URL(appUrl).origin;
  const previousApp = process.env.SPROUT_HUMAN_REVIEW_APP;
  process.env.SPROUT_HUMAN_REVIEW_APP = fixtureOrigin;
  try {
    assert.equal(await resolveEntry(""), `${fixtureOrigin}/login`);
    assert.equal(await resolveEntry("/projects"), `${fixtureOrigin}/projects`);
    assert.equal(await resolveEntry(appUrl), appUrl);
    fixtureState.devLogin = true;
    assert.equal(await resolveEntry(""), `${fixtureOrigin}/dev-login`);
    fixtureState.devLogin = false;
  } finally {
    if (previousApp === undefined) delete process.env.SPROUT_HUMAN_REVIEW_APP;
    else process.env.SPROUT_HUMAN_REVIEW_APP = previousApp;
  }
  pass("省略入口时优先选开发登录，应用不提供或显式给出入口时保持原路径");
  cli = spawn(
    process.execPath,
    [
      cliPath,
      appUrl,
      "--port",
      String(port),
      "--lavish-port",
      String(lavishPort),
      "--state-dir",
      path.join(root, "state"),
      "--strict-ports",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "",
    launchError;
  cli.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  cli.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  cli.once("error", (error) => {
    launchError = error;
  });
  review = await until(async () => {
    if (launchError) throw launchError;
    if (cli.exitCode !== null) throw new Error(`CLI 提前退出：${stderr}`);
    return stdout.includes("\n") && JSON.parse(stdout.split("\n")[0]);
  }, "CLI 启动");
  assert.equal(review.pid, cli.pid);
  const descriptor = JSON.parse(await readFile(path.join(root, "state/session.json"), "utf8"));
  assert.deepEqual(review, descriptor);
  const require = createRequire(review.lavishBin);
  const { decode } = await import(pathToFileURL(require.resolve("@toon-format/toon")).href);
  const native = async (args, receipt) => {
    const result = await exec(review.lavishBin, [...args, review.file], {
      env: { ...process.env, ...review.env },
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (receipt) await writeFile(receipt, result.stdout);
    return decode(result.stdout);
  };
  pass("真实 CLI 输出 PID、应用入口和独立 Lavish 描述符，无需加载 Pi 扩展");
  await assert.rejects(
    () =>
      startReview({
        url: appUrl,
        port,
        lavishPort,
        stateDir: path.join(root, "conflicting-review"),
      }),
    /已占用/,
  );
  const loadedHtml = await (await fetch(review.url)).text();
  assert.ok(loadedHtml.includes('title="Sprout 本地应用预览"'));
  const key = new URL(review.url).pathname.split("/").pop();
  const artifact = await fetch(new URL(`/artifact/${key}/index.html`, review.url));
  assert.match(artifact.headers.get("content-security-policy"), /sandbox/);
  assert.equal(
    (await fetch(review.url, { headers: { origin: "https://untrusted.example" } })).status,
    403,
  );
  pass("端口冲突拒绝接管，已有 review 仍可访问；普通 artifact 隔离与 Origin 检查保持");

  const ext = path.join(root, "extension");
  await cp(path.resolve(extension), ext, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = [`http://${host}/*`];
  await writeFile(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(review.url);
  const app = page.frameLocator("#artifact");
  await app.locator("#sign-in").click();
  await app.getByRole("heading", { name: "已登录的设置页面" }).waitFor();
  await page.reload();
  await app.getByRole("heading", { name: "已登录的设置页面" }).waitFor();
  let frame = page.frames().find((f) => f.url().startsWith(new URL(appUrl).origin));
  await frame.evaluate(() => {
    localStorage.setItem("review-persistence", "retained");
    location.href = "/next";
  });
  await app.locator("#open-next").waitFor();
  frame = page.frames().find((f) => f.url().startsWith(new URL(appUrl).origin));
  await frame.evaluate(() => history.back());
  await until(() => Promise.resolve(frame.url().endsWith("/login")), "frame 后退");
  await frame.evaluate(() => history.forward());
  await until(() => Promise.resolve(frame.url().endsWith("/next")), "frame 前进");
  assert.equal(await frame.evaluate(() => localStorage.getItem("review-persistence")), "retained");
  assert.ok((await context.cookies()).some((c) => c.name === "review_session" && c.httpOnly));
  assert.ok(!frame.url().includes("artifact_load_token"));
  assert.equal(await page.locator("#artifact").getAttribute("sandbox"), null);
  const size = await frame.evaluate(() => `${innerWidth} × ${innerHeight}`);
  await until(
    async () => (await page.locator("#sprout-human-review-viewport").innerText()).includes(size),
    "实际 frame 尺寸",
  );
  pass("可信 frame 保留 cookie、localStorage、登录刷新和前后退；显示实际视口且不污染应用 URL");

  const device = page.getByRole("combobox", { name: "设备尺寸", exact: true });
  const zoom = page.getByRole("combobox", { name: "预览缩放", exact: true });
  const viewport = async (w, h) => {
    await until(async () => {
      const size = await frame.evaluate(() => [innerWidth, innerHeight]);
      return size[0] === w && size[1] === h;
    }, `应用视口 ${w} × ${h}`);
    assert.ok(
      (await page.locator("#sprout-human-review-viewport").innerText()).includes(`${w} × ${h}`),
    );
  };
  await app.locator("#review-draft").fill("切换尺寸保留草稿");
  const documentToken = await frame.evaluate(() => {
    window.reviewDocumentToken = crypto.randomUUID();
    return window.reviewDocumentToken;
  });
  for (const [w, h] of [
    [390, 844],
    [768, 1024],
    [900, 900],
    [901, 900],
    [1199, 900],
    [1200, 900],
    [1920, 1080],
  ]) {
    await device.selectOption(`${w}x${h}`);
    await viewport(w, h);
    assert.deepEqual(
      await frame.evaluate(() => [
        matchMedia("(max-width: 900px)").matches,
        matchMedia("(min-width: 1200px)").matches,
      ]),
      [w <= 900, w >= 1200],
    );
    if ([390, 768, 1920].includes(w)) {
      await page.screenshot({ path: path.join(evidence, `viewport-${w}.png`) });
    }
  }
  await device.selectOption("390x844");
  await page.getByRole("button", { name: "旋转视口", exact: true }).click();
  await viewport(844, 390);
  await page.getByRole("spinbutton", { name: "视口宽度", exact: true }).fill("1376");
  await page.getByRole("spinbutton", { name: "视口高度", exact: true }).fill("820");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await viewport(1376, 820);
  await page.getByRole("spinbutton", { name: "视口宽度", exact: true }).fill("0");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  assert.equal(
    await page
      .getByRole("spinbutton", { name: "视口宽度", exact: true })
      .evaluate((input) => input.validity.rangeUnderflow),
    true,
  );
  await viewport(1376, 820);
  assert.equal(await frame.evaluate(() => window.reviewDocumentToken), documentToken);
  assert.equal(await app.locator("#review-draft").inputValue(), "切换尺寸保留草稿");
  assert.ok(frame.url().endsWith("/next"));
  pass(
    "手机、平板、桌面与 900/1200 边界触发真实媒体查询；旋转、自定义和非法尺寸验证保留页面、路由与草稿",
  );

  await device.selectOption("1920x1080");
  await zoom.selectOption("actual");
  await viewport(1920, 1080);
  await until(
    () =>
      page
        .locator(".human-review-stage")
        .evaluate(
          (stage) =>
            stage.scrollWidth > stage.clientWidth && stage.scrollHeight > stage.clientHeight,
        ),
    "100% 模式可滚动",
  );
  await zoom.selectOption("fit");
  await until(
    () =>
      page
        .locator("#artifact")
        .evaluate((frame) => frame.getBoundingClientRect().width < frame.clientWidth),
    "大视口缩放显示",
  );
  await viewport(1920, 1080);
  await page.setViewportSize({ width: 390, height: 844 });
  await viewport(1920, 1080);
  await until(
    () =>
      page
        .locator(".human-review-stage")
        .evaluate(
          (stage) =>
            stage.scrollWidth <= stage.clientWidth + 1 &&
            stage.scrollHeight <= stage.clientHeight + 1,
        ),
    "小屏适配可用空间",
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(evidence, "viewport-small-host.png") });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await viewport(1920, 1080);
  await page.reload();
  await app.locator("#review-draft").waitFor();
  frame = page.frames().find((f) => f.url().startsWith(new URL(appUrl).origin));
  await viewport(1920, 1080);
  assert.equal(await zoom.inputValue(), "fit");
  await device.selectOption("auto");
  await until(
    () =>
      page
        .locator("#artifact")
        .evaluate(
          (frame) =>
            frame.clientWidth === frame.closest(".human-review-stage").clientWidth &&
            frame.clientHeight === frame.closest(".human-review-stage").clientHeight,
        ),
    "跟随窗口恢复",
  );
  assert.equal(await zoom.isDisabled(), true);
  await device.selectOption("1440x900");
  await viewport(1440, 900);
  pass("适配与 100% 显示保留实际视口，窄宿主无页面溢出，刷新保留尺寸，跟随窗口可恢复");

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["src/capture.js", "src/picker.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__domCapturePicker.toggle(),
    });
  });
  const control = (action) =>
    worker.evaluate(async (action) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [action],
        func: (action) => {
          const picker = globalThis.__domCapturePicker;
          if (action === "hide") {
            picker.toggle();
            return;
          }
          const button = picker.nav.querySelector(`[data-act="${action}"]`);
          const r = button.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: button.disabled };
        },
      });
      return result;
    }, action);
  const target = await app.locator('[id="save:settings"]').boundingBox();
  for (let n = 0; n < 5; n++) {
    await page.mouse.move(target.x + 5 + n, target.y + 5);
    await page.waitForTimeout(80);
  }
  await page.mouse.click(target.x + 10, target.y + 5);
  const copy = async (action) => {
    const button = await control(action);
    assert.equal(button.disabled, false);
    await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
    await page.mouse.click(button.x, button.y);
    return until(async () => {
      const text = await page.evaluate(() => navigator.clipboard.readText());
      return text !== "sentinel" && text;
    }, action);
  };
  assert.equal(await copy("copy-id"), "save:settings");
  const locator = await copy("copy-path");
  assert.match(locator, /ID: save:settings/);
  assert.ok(locator.includes(`URL: ${frame.url()}`));
  assert.ok(locator.includes("Page: " + review.url));
  await page.screenshot({ path: path.join(evidence, "dom-capture.png") });
  await control("hide");
  pass("真实扩展在 Lavish 的跨源 frame 选取元素，Copy ID / Copy DOM path 保留内外 URL");

  const idle = await native(["poll", "--timeout-ms", "50"], path.join(evidence, "idle-poll.toon"));
  assert.equal(idle.session.status, "waiting");
  pass("有界原生 poll 返回 waiting，评审会话保持可继续收取反馈");
  const image = await page.screenshot();
  await page.evaluate(async (data) => {
    const blob = await (await fetch("data:image/png;base64," + data)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, image.toString("base64"));
  await page.locator("#chatInput").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await page.locator("#chatAttachments img").waitFor();
  const feedback = `# Human review 反馈\n\n${locator}\n\n当前：实验按钮。期望：原生 poll 完整读取定位与图片。本条为自动验证，不要求修改产品 UI。`;
  await page.evaluate((text) => navigator.clipboard.writeText(text), feedback);
  await page.locator("#chatInput").focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  assert.equal(await page.locator("#chatInput").inputValue(), feedback);
  await page.screenshot({ path: path.join(evidence, "feedback-ready.png") });
  await page.locator("#send").click();
  const response = await native(["poll"], path.join(evidence, "poll.toon"));
  assert.equal(response.prompts[0].prompt, feedback);
  const attachment = response.prompts[0].attachments[0];
  assert.equal(attachment.mime, "image/png");
  const receivedImage = await readFile(attachment.path);
  const pixels = await page.evaluate(
    async (images) => {
      const hashes = [];
      for (const encoded of images) {
        const blob = await (await fetch("data:image/png;base64," + encoded)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))));
      }
      return hashes;
    },
    [image.toString("base64"), receivedImage.toString("base64")],
  );
  assert.deepEqual(pixels[0], pixels[1], "剪贴板 PNG 可以重编码，但截图像素必须保留");
  await writeFile(path.join(evidence, "feedback.json"), JSON.stringify(response, null, 2));
  await native([
    "reply",
    "--agent-reply",
    "已收到定位与截图；自动验证通过，本次没有修改产品页面。",
  ]);
  await page
    .getByText("已收到定位与截图；自动验证通过，本次没有修改产品页面。", { exact: true })
    .waitFor();
  await page.locator(".agent-working").waitFor({ state: "hidden" });
  pass("无监听时反馈排队，原生 poll 完整收到文字与原图，原生 reply 回到 Conversation");
  await page.screenshot({ path: path.join(evidence, "feedback-received.png") });
  await page.locator("#chatInput").fill("自动验证的最后一条反馈，结束本次测试会话。");
  await page.locator("#sendAndEnd").click();
  const finalResponse = await native(["poll"], path.join(evidence, "final-poll.toon"));
  assert.equal(finalResponse.session.session_ended, true);
  assert.equal(finalResponse.session.ended_by, "user");
  pass("Send & End 的最终反馈送达，用户结束状态被保留");
  assert.deepEqual(errors, []);
  pass("浏览器无未处理脚本错误");
} catch (error) {
  if (context) {
    const page = context.pages()[0];
    await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {});
    console.error(
      "frames:",
      page.frames().map((frame) => frame.url()),
    );
  }
  throw error;
} finally {
  await stop();
  await context?.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
await assert.rejects(() => fetch(review.url, { signal: AbortSignal.timeout(1000) }));
await assert.rejects(() =>
  fetch(`http://127.0.0.1:${lavishPort}/health`, { signal: AbortSignal.timeout(1000) }),
);
assert.equal(cli.exitCode, 0, "CLI 通过 SIGTERM 正常结束，不依赖强杀");
pass("SIGTERM 停止 CLI 后，自有代理与 Lavish 端口均已释放");
await writeFile(
  path.join(evidence, "results.json"),
  JSON.stringify({ results, evidence }, null, 2),
);
console.log(`证据：${evidence}`);
