import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createProject, waitForChats } from "./ui-navigation.mjs";

const evidence = mkdtempSync(resolve(".verify/p4a-machine-flow-"));
const installation = mkdtempSync(join(tmpdir(), "sprout-ui-worker-"));
const base = process.env.BASE_URL ?? "http://127.0.0.1:3120";
const port = new URL(base).port;
const database = join(evidence, "machine.sqlite");
const env = {
  ...process.env,
  DATABASE_URL: database,
  APP_ORIGIN: base,
  PORT: port,
  NITRO_PORT: port,
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SPROUT_PI_ENABLED: "false",
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
};
const children = [];
function launch(args, name, options = {}) {
  const fd = openSync(join(evidence, name), "w", 0o600);
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", fd, fd], ...options });
  closeSync(fd);
  child.done = new Promise((done, reject) => {
    child.once("exit", (code) => done(code));
    child.once("error", reject);
  });
  children.push(child);
  return child;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  for (let n = 0; n < 150; n++) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timeout ${label}`);
}
const passes = [];
function pass(name, facts = {}) {
  passes.push({ name, ...facts });
  console.log(`PASS ${name}`);
  writeFileSync(join(evidence, "results.json"), JSON.stringify(passes, null, 2));
}
const req = createRequire(import.meta.resolve("@tanstack/react-start"));
const clientReq = createRequire(req.resolve("@tanstack/start-client-core/package.json"));
const { fromCrossJSON, toJSON } = clientReq("seroval");
function functionIds() {
  const walk = (path) =>
    readdirSync(path, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory()
        ? walk(join(path, item.name))
        : item.name.endsWith(".mjs")
          ? [readFileSync(join(path, item.name), "utf8")]
          : [],
    );
  return Object.fromEntries(
    [
      ...walk(".output/server")
        .join("\n")
        .matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g),
    ].map((m) => [m[2], m[1]]),
  );
}
let browser;
let db;
try {
  const server = launch([".output/server/index.mjs"], "production.log");
  await until(async () => {
    try {
      return (await fetch(base + "/api/health")).ok;
    } catch {
      return false;
    }
  }, "production health");
  const ids = functionIds();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const browserRpcs = new Set();
  page.on("request", (request) => {
    for (const [name, id] of Object.entries(ids))
      if (request.url().endsWith(`/_serverFn/${id}`)) browserRpcs.add(name);
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  async function register(target, tag) {
    await target.goto(base + "/login");
    await target.getByTestId("register-tab").click();
    await target.locator('input[name="name"]').fill(tag);
    await target
      .locator('input[name="email"]')
      .fill(`${tag}-${randomBytes(8).toString("hex")}@example.test`);
    await target
      .locator(`input[type="${["pass", "word"].join("")}"]`)
      .fill(randomBytes(24).toString("base64url"));
    await target.locator('button[type="submit"]').click();
    await waitForChats(target);
  }
  await register(page, "machine-owner");
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  async function rpc(name, data, actor = cookie) {
    assert(ids[name], `production registration ${name}`);
    const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tsr-serverfn": "true",
        origin: base,
        ...(actor ? { cookie: actor } : {}),
      },
      body: JSON.stringify(toJSON({ data })),
    });
    assert.equal(response.status, 200);
    const encoded = await response.json();
    const decoded = encoded.t ? fromCrossJSON(encoded, { refs: new Map() }) : encoded;
    return decoded.result ?? decoded;
  }
  await page.getByRole("link", { name: "Machines", exact: true }).click();
  assert.equal(await page.getByTestId("nav-machines").getAttribute("aria-current"), "page");
  await page.getByTestId("new-machine-trigger").click();
  await page.getByTestId("machine-name-input").fill("Production Mac");
  await page.getByTestId("machine-create-submit").click();
  await page.getByTestId("machine-detail-id").waitFor();
  const machineId = (await page.getByTestId("machine-detail-id").innerText()).trim();
  await page.getByTestId("machine-ticket-hidden").waitFor();
  await page.getByTestId("machine-ticket-toggle").click();
  const ticket = await page.getByTestId("machine-ticket-value").innerText();
  assert.equal(ticket.length, 43);
  await page.getByTestId("machine-ticket-toggle").click();
  const leaked = await page.evaluate(
    (value) =>
      JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
        state: history.state,
        url: location.href,
      }).includes(value),
    ticket,
  );
  assert.equal(leaked, false);
  await page.screenshot({ path: join(evidence, "created-ticket-hidden-1440.png"), fullPage: true });
  pass("real browser create and transient hidden ticket", { machineId });
  await page.getByTestId("machine-renew").click();
  await until(
    async () => !(await page.getByTestId("machine-renew").isDisabled()),
    "browser renewal",
  );
  await page.getByTestId("machine-ticket-toggle").click();
  const enrollmentTicket = await page.getByTestId("machine-ticket-value").innerText();
  assert.equal(enrollmentTicket.length, 43);
  assert(enrollmentTicket !== ticket, "renewal replaces the creation ticket");
  await page.getByTestId("machine-ticket-toggle").click();
  db = new Database(database);
  const credential = db
    .prepare("SELECT ticket_hash FROM machine_credential WHERE machine_id = ?")
    .get(machineId);
  assert.equal(
    credential.ticket_hash === createHash("sha256").update(enrollmentTicket).digest("hex"),
    true,
    "server credential matches the renewed ticket",
  );
  await page.getByTestId("machine-detail-back").click();
  await page.getByTestId("machine-list").waitFor();
  await page.getByTestId("machine-item").filter({ hasText: "Production Mac" }).click();
  assert.equal((await page.getByTestId("machine-detail-id").innerText()).trim(), machineId);
  await page.getByTestId("machine-ticket-hidden").waitFor();
  await page.getByTestId("machine-ticket-toggle").click();
  const reopenedTicket = await page.getByTestId("machine-ticket-value").innerText();
  assert(reopenedTicket !== ticket, "returning to Machine must not resurrect the creation ticket");
  assert.equal(reopenedTicket === enrollmentTicket, true, "returning retains the renewed ticket");
  await page.getByTestId("machine-ticket-toggle").click();
  pass("renewal replaces creation result across list and detail navigation", {
    renewChangedTicket: true,
    serverHashMatchesRenewed: true,
    creationTicketResurrected: false,
    renewedTicketRestored: true,
  });
  copyFileSync("dist/worker/main.js", join(installation, "main.mjs"));
  const ticketFile = join(installation, "ticket");
  writeFileSync(ticketFile, reopenedTicket, { mode: 0o600 });
  const stateDir = join(installation, "identity");
  const init = launch(
    [
      join(installation, "main.mjs"),
      "init",
      "--server",
      base,
      "--machine",
      machineId,
      "--state-dir",
      stateDir,
      "--ticket-file",
      ticketFile,
    ],
    "init.log",
    { cwd: installation },
  );
  assert.equal(await init.done, 0);
  unlinkSync(ticketFile);
  let worker = launch(
    [join(installation, "main.mjs"), "run", "--state-dir", stateDir],
    "worker.log",
    { cwd: installation },
  );
  await until(
    async () => (await rpc("getMachineFn", { machineId })).data.connection.kind === "online",
    "Worker online",
  );
  await page.getByTestId("machine-refresh").click();
  await page.getByTestId("machine-enrollment-active").waitFor();
  assert((await page.getByTestId("machine-detail-connection").innerText()).includes("在线"));
  assert.equal(await page.getByTestId("machine-ticket-value").count(), 0);
  pass("independently copied macOS Worker connects and refresh reads active identity", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    installation,
  });
  const projectA = await createProject(page, { name: "Machine Project A", description: "A" });
  const projectB = await createProject(page, { name: "Machine Project B", description: "B" });
  async function openBinding(project) {
    await page.goto(`${base}${project.path}/settings`);
    await page.getByTestId("project-machine-select").selectOption(machineId);
    await page.getByTestId("project-machine-open").click();
    await page.getByTestId("machine-binding-form").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("projectId"), project.id);
  }
  await openBinding(projectA);
  await page.getByTestId("machine-binding-description").fill("Project A directory");
  await page.getByTestId("machine-binding-directory").fill(installation);
  await page.getByTestId("machine-binding-submit").click();
  await page.getByTestId("machine-binding-success").waitFor();
  await until(
    async () =>
      (await rpc("getMachineFn", { machineId, projectId: projectA.id })).data.bindings[0]
        ?.observation?.current,
    "directory observation",
  );
  await page.getByTestId("machine-refresh").click();
  await page.getByTestId("machine-binding-observation").filter({ hasText: "当前可达" }).waitFor();
  await page.getByTestId("machine-binding-description").fill("unsaved draft");
  const refreshPattern = `**/_serverFn/${ids.getMachineFn}`;
  await page.route(refreshPattern, async (route) => {
    await delay(1600);
    await route.continue();
  });
  await page.getByTestId("machine-refresh").click();
  await delay(1200);
  assert.equal(await page.getByTestId("machine-binding-description").inputValue(), "unsaved draft");
  await delay(600);
  await page.unroute(refreshPattern);
  assert.equal(await page.getByTestId("machine-binding-description").inputValue(), "unsaved draft");
  await page.reload();
  assert.equal(
    await page.getByTestId("machine-binding-description").inputValue(),
    "Project A directory",
  );
  assert.equal(
    await page.getByTestId("machine-detail-back").getAttribute("href"),
    `${projectA.path}/settings`,
  );
  const rowA = db
    .prepare(
      "SELECT description, directory, revision FROM project_machine WHERE project_id=? AND machine_id=?",
    )
    .get(projectA.id, machineId);
  assert.equal(rowA.directory, installation);
  await page.screenshot({ path: join(evidence, "bound-current-1440-light.png"), fullPage: true });
  pass(
    "real binding persists, current observation agrees with HTTP and SQLite, refresh preserves draft",
    { projectId: projectA.id, revision: rowA.revision },
  );
  await page.getByTestId("machine-detail-back").click();
  await page.getByTestId("info-hub-project-machines").waitFor();
  await page.getByTestId("info-hub-project-machines").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "project-settings-machines-1440.png"),
    fullPage: true,
  });
  assert(
    (await page.getByTestId("info-hub-project-machines").innerText()).includes("Production Mac"),
  );
  const bindingFacts = await page.getByTestId("info-hub-machine-binding").innerText();
  assert(bindingFacts.includes("Project A directory") && bindingFacts.includes(installation));
  await page.goBack();
  await page.getByTestId("machine-detail-id").waitFor();
  await page.goForward();
  await page.getByTestId("project-machine-select").waitFor();
  await openBinding(projectB);
  await page.getByTestId("machine-binding-description").fill("Project B independent");
  await page.getByTestId("machine-binding-submit").click();
  await page.getByTestId("machine-binding-success").waitFor();
  await page.reload();
  assert.equal(await page.getByTestId("machine-binding-directory").inputValue(), "");
  assert.equal(
    db
      .prepare("SELECT description FROM project_machine WHERE project_id=? AND machine_id=?")
      .get(projectA.id, machineId).description,
    "Project A directory",
  );
  const browserList = await page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tsr-serverfn": "true" },
        body: JSON.stringify(body),
      });
      return { status: response.status, encoded: await response.json() };
    },
    {
      url: `${base}/_serverFn/${ids.listProjectMachinesFn}`,
      body: toJSON({ data: { projectId: projectB.id } }),
    },
  );
  assert.equal(browserList.status, 200);
  const browserDecoded = browserList.encoded.t
    ? fromCrossJSON(browserList.encoded, { refs: new Map() })
    : browserList.encoded;
  const listed = browserDecoded.result ?? browserDecoded;
  assert.equal(listed.data.length, 1);
  assert.equal((await rpc("listMachinesFn", {})).data.length, 1);
  const hub = await rpc("getProjectInfoHubFn", { projectId: projectB.id });
  assert.equal(hub.data.machines[0].bindings[0].intent.description, "Project B independent");
  assert.equal(hub.data.leases.available, false);
  pass(
    "two Projects keep independent bindings and Info Hub exposes real Machine plus unavailable leases",
  );
  await page.getByTestId("machine-binding-directory").fill("relative/path");
  await page.getByTestId("machine-binding-submit").click();
  assert.equal(
    await page.getByTestId("machine-binding-directory").getAttribute("aria-invalid"),
    "true",
  );
  assert(await page.getByTestId("machine-binding-directory").getAttribute("aria-describedby"));
  await page.getByTestId("machine-binding-directory").fill("");
  let blockedSaves = 0;
  const savePattern = `**/_serverFn/${ids.saveProjectMachineBindingFn}`;
  await page.route(savePattern, async (route) => {
    blockedSaves++;
    await delay(500);
    await route.abort("failed");
  });
  await page
    .getByTestId("machine-binding-description")
    .fill("draft retained after network failure");
  await page.getByTestId("machine-binding-submit").click();
  assert.equal(await page.getByTestId("machine-binding-submit").isDisabled(), true);
  await page.getByTestId("machine-binding-form").evaluate((form) => form.requestSubmit());
  await page.getByTestId("machine-binding-error").waitFor();
  assert.equal(blockedSaves, 1);
  assert.equal(
    await page.getByTestId("machine-binding-description").inputValue(),
    "draft retained after network failure",
  );
  await page.unroute(savePattern);
  await page.getByTestId("machine-binding-description").fill("Project B independent");
  pass("field errors are associated, pending prevents duplicates, network failure retains draft");
  const concurrent = await rpc("saveProjectMachineBindingFn", {
    machineId,
    projectId: projectB.id,
    description: "concurrent edit",
    directory: null,
    expectedRevision: 1,
  });
  assert(concurrent.ok);
  await page.getByTestId("machine-binding-description").fill("local conflict draft");
  await page.getByTestId("machine-binding-submit").click();
  await page.getByTestId("machine-binding-error").filter({ hasText: "conflict" }).waitFor();
  assert.equal(
    await page.getByTestId("machine-binding-description").inputValue(),
    "local conflict draft",
  );
  assert.equal(
    db
      .prepare("SELECT description FROM project_machine WHERE project_id=? AND machine_id=?")
      .get(projectB.id, machineId).description,
    "concurrent edit",
  );
  await page.reload();
  await page.getByTestId("machine-binding-description").fill("Project B independent");
  pass("stale revision rejects conflicting edit and preserves both service fact and local draft");
  await page.getByTestId("machine-binding-directory").fill("/sprout-nonexistent-directory");
  await page.getByTestId("machine-binding-submit").click();
  await page.getByTestId("machine-binding-success").waitFor();
  await until(async () => {
    const binding = (await rpc("getMachineFn", { machineId, projectId: projectB.id })).data
      .bindings[0];
    return binding.observation?.current && binding.observation.fact.result.kind === "unavailable";
  }, "missing directory observation");
  await page.getByTestId("machine-refresh").click();
  await page.getByTestId("machine-binding-observation").filter({ hasText: "当前不可用" }).waitFor();
  worker.kill("SIGTERM");
  assert.equal(await worker.done, 0);
  await page.getByTestId("machine-refresh").click();
  await page.getByTestId("machine-detail-connection").filter({ hasText: "断线" }).waitFor();
  const stoppedDetail = (await rpc("getMachineFn", { machineId, projectId: projectB.id })).data;
  assert.equal(stoppedDetail.bindings[0].observation.current, true);
  assert(
    (await page.getByTestId("machine-binding-observation").innerText()).includes("当前不可用"),
  );
  worker = launch(
    [join(installation, "main.mjs"), "run", "--state-dir", stateDir],
    "worker-reconnect.log",
    { cwd: installation },
  );
  await until(
    async () => (await rpc("getMachineFn", { machineId })).data.connection.kind === "online",
    "reconnect",
  );
  await page.getByTestId("machine-refresh").click();
  await page.getByTestId("machine-detail-connection").filter({ hasText: "在线" }).waitFor();
  pass(
    "directory revision failure, Worker stop and reconnect become visible through manual refresh",
  );
  for (const scheme of ["light", "dark"]) {
    await page.evaluate((value) => {
      localStorage.setItem("sprout:theme", value);
      document.documentElement.classList.toggle("dark", value === "dark");
    }, scheme);
    for (const width of [390, 899, 900, 901, 1024, 1199, 1200, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await delay(80);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${scheme} ${width} overflow`,
      );
      const nav = page.getByRole("link", { name: "Machines", exact: true });
      assert.equal(await nav.getAttribute("aria-current"), "page");
      await page.screenshot({
        path: join(evidence, `detail-${width}-${scheme}.png`),
        fullPage: true,
      });
      if (width === 390) {
        await page.getByTestId("machine-binding-form").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(evidence, `binding-390-${scheme}.png`),
          fullPage: true,
        });
        await page.getByTestId("machine-install").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(evidence, `install-390-${scheme}.png`),
          fullPage: true,
        });
        await page.getByTestId("machine-detail-name").scrollIntoViewIfNeeded();
      }
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base + "/machines");
      await page.getByTestId("machine-item-name").waitFor();
      await page.screenshot({
        path: join(evidence, `list-${width}-${scheme}.png`),
        fullPage: true,
      });
    }
    await page.goto(`${base}/machines/${machineId}?projectId=${projectB.id}`);
    await page.getByTestId("machine-binding-form").waitFor();
  }
  await page.goto(`${base}/machines/${machineId}`);
  assert.equal(await page.getByTestId("machine-detail-back").getAttribute("href"), "/machines");
  pass("deep links, browser back forward and 900/1200 navigation boundaries across both themes");
  async function readTicket(label) {
    try {
      await page.getByTestId("machine-ticket-hidden").waitFor({ timeout: 8000 });
    } catch (error) {
      throw new Error(`${label}: ${String(error.message).split("\n")[0]}`);
    }
    await page.getByTestId("machine-ticket-toggle").click();
    await page.getByTestId("machine-ticket-value").waitFor();
    const value = (await page.getByTestId("machine-ticket-value").innerText()).trim();
    await page.getByTestId("machine-ticket-toggle").click();
    await page.getByTestId("machine-ticket-hidden").waitFor();
    return value;
  }
  async function openMachineList() {
    await page.getByTestId("machine-detail-back").click();
    await page.getByTestId("machine-list").waitFor();
  }
  async function createPendingMachine(name) {
    await openMachineList();
    await page.getByTestId("new-machine-trigger").click();
    await page.getByTestId("machine-name-input").fill(name);
    await page.getByTestId("machine-create-submit").click();
    await page.getByTestId("machine-detail-id").waitFor();
    const id = (await page.getByTestId("machine-detail-id").innerText()).trim();
    return { id, ticket: await readTicket(`create ticket ${name}`) };
  }
  const raceA = await createPendingMachine("Race Mac A");
  const raceB = await createPendingMachine("Race Mac B");
  const renewPattern = `**/_serverFn/${ids.renewMachineEnrollmentFn}`;
  await page.route(renewPattern, async (route) => {
    await delay(2500);
    await route.continue();
  });
  const lateRenewal = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/_serverFn/${ids.renewMachineEnrollmentFn}`) &&
      response.request().method() === "POST",
  );
  await openMachineList();
  await page.getByTestId("machine-item").filter({ hasText: "Race Mac A" }).click();
  await page.getByTestId("machine-renew").click();
  await page.getByTestId("machine-detail-back").click();
  await page.getByTestId("machine-list").waitFor();
  await page.getByTestId("machine-item").filter({ hasText: "Race Mac B" }).click();
  await page.getByTestId("machine-detail-id").waitFor();
  assert.equal((await page.getByTestId("machine-detail-id").innerText()).trim(), raceB.id);
  assert.equal(
    await readTicket("before late result"),
    raceB.ticket,
    "A 的续签在途时 B 的创建票据可见",
  );
  await lateRenewal;
  await delay(800);
  assert.equal(
    await readTicket("after late result"),
    raceB.ticket,
    "A 的迟到续签结果不能改写 B 的票据",
  );
  assert.equal(
    (await rpc("getMachineFn", { machineId: raceB.id })).data.enrollmentStatus,
    "pending",
    "B 在服务端仍是待配对",
  );
  await page.unroute(renewPattern);
  await openMachineList();
  await page.getByTestId("machine-item").filter({ hasText: "Race Mac A" }).click();
  await page.getByTestId("machine-renew").waitFor();
  await page.getByTestId("machine-renew").click();
  await until(
    async () => !(await page.getByTestId("machine-renew").isDisabled()),
    "race machine renewal",
  );
  const raceRenewed = await readTicket("renewed ticket");
  assert(raceRenewed !== raceA.ticket, "回到 A 看到的是续签后的新票据");
  assert.equal(
    db.prepare("SELECT ticket_hash FROM machine_credential WHERE machine_id = ?").get(raceA.id)
      .ticket_hash === createHash("sha256").update(raceRenewed).digest("hex"),
    true,
    "A 的续签票据与 SQLite 哈希一致",
  );
  pass("late renewal from a previous Machine does not replace the current parent enrollment", {
    lateRenewalHeldInFlight: true,
    secondMachineKeptCreationTicket: true,
    secondMachineServerStillPending: true,
    firstMachineCreationTicketResurrected: false,
  });
  const anonymous = await browser.newContext();
  const anon = await anonymous.newPage();
  await anon.goto(`${base}/machines/${machineId}`);
  await anon.waitForURL(/\/login/);
  assert.equal((await rpc("getMachineFn", { machineId }, "")).error.code, "unauthorized");
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await register(otherPage, "machine-other");
  await otherPage.goto(`${base}/machines/${machineId}?projectId=${projectA.id}`);
  await otherPage.getByText("not_found", { exact: false }).waitFor();
  const otherCookie = (await otherContext.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  for (const [name, input] of [
    ["getMachineFn", { machineId }],
    ["listProjectMachinesFn", { projectId: projectA.id }],
    [
      "saveProjectMachineBindingFn",
      {
        machineId,
        projectId: projectA.id,
        description: "steal",
        directory: null,
        expectedRevision: null,
      },
    ],
  ]) {
    const denied = await rpc(name, input, otherCookie);
    assert.equal(denied.error.code, "not_found");
    const deniedBody = JSON.stringify(denied);
    for (const value of ["Production Mac", machineId, projectA.id])
      assert.equal(deniedBody.includes(value), false);
  }
  pass("unauthenticated navigation and second Human cannot read or bind Machine");
  assert.deepEqual(errors, []);
  for (const name of [
    "createMachineFn",
    "renewMachineEnrollmentFn",
    "listMachinesFn",
    "getMachineFn",
    "listProjectMachinesFn",
    "saveProjectMachineBindingFn",
  ])
    assert(browserRpcs.has(name), `actual browser called ${name}`);
  pass(
    "no browser runtime errors; all six real production Machine RPCs callable without discovery hook",
  );
  console.log(`EVIDENCE ${evidence}`);
  server.kill("SIGTERM");
} catch (error) {
  console.error(error.message);
  console.error(`EVIDENCE ${evidence}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.done));
  db?.close();
}
