import { afterEach, expect, it } from "vite-plus/test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  fixtureModels,
  fixtureProvider,
  leaseTurn,
  startModelFixture,
  statusTurn,
} from "../scripts/verify/lib/model-fixture.mjs";

const roots: string[] = [];
const fixtures: Awaited<ReturnType<typeof startModelFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory() {
  const root = mkdtempSync(join(tmpdir(), "sprout-model-fixture-test-"));
  roots.push(root);
  return root;
}

async function setup(discovery: "bin" | "install" = "bin") {
  const privateDir = directory();
  const sourceAgentDir = join(privateDir, "source-agent");
  const sdk = join(
    sourceAgentDir,
    "install",
    "releases",
    "9.2.1",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  mkdirSync(join(sdk, "dist"), { recursive: true });
  writeFileSync(
    join(sdk, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
  );
  for (const file of ["index.js", "cli.js"]) writeFileSync(join(sdk, "dist", file), "");
  if (discovery === "bin") {
    mkdirSync(join(sourceAgentDir, "bin"));
    symlinkSync(join(sdk, "dist", "cli.js"), join(sourceAgentDir, "bin", "pi"));
  }
  for (const file of ["auth.json", "settings.json", "models.json"])
    writeFileSync(join(sourceAgentDir, file), JSON.stringify({ privateSource: "must-not-copy" }));
  const fixture = await startModelFixture({ privateDir, sourceAgentDir });
  fixtures.push(fixture);
  const catalog = JSON.parse(readFileSync(join(fixture.agentDir, "models.json"), "utf8"));
  const provider = catalog.providers[fixtureProvider];
  const endpoint = `${provider.baseUrl}/chat/completions`;
  const tool = (
    name: string,
    properties: Record<string, { type: string }> = { machineId: { type: "string" } },
  ) => ({
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties, required: Object.keys(properties) },
    },
  });
  const tools = [tool("sprout_lease_get")];
  const request = (body: unknown, overrides: RequestInit = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      ...overrides,
    });
  const input = (
    messages: unknown[],
    model: string = fixtureModels.operator,
    declaredTools: unknown[] = tools,
  ) => ({ model, stream: true, messages, tools: declaredTools });
  const next = async (body: unknown) => {
    const response = await request(body);
    expect(response.status).toBe(200);
    const chunks = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    return chunks[0].choices[0].delta;
  };
  return { fixture, catalog, provider, endpoint, request, input, next, tool };
}

const prompt = "Read the lease for machine fixture-machine.";
const user = (content = prompt) => ({ role: "user", content });
const plan = () => ({
  expectedUserText: prompt,
  steps: [{ name: "sprout_lease_get", arguments: { machineId: "fixture-machine" } }],
  reply: "Finished local fixture turn.",
});
const assistant = (call: unknown) => ({ role: "assistant", tool_calls: [call] });
const result = (id: string) => ({
  role: "tool",
  tool_call_id: id,
  content: '{"ok":true,"data":{"lease":{"state":"free","generation":2}}}',
});

it.each(["bin", "install"] as const)(
  "discovers SDK through %s and creates a private loopback-only model catalog",
  async (discovery) => {
    const { fixture, provider, catalog } = await setup(discovery);
    expect(Object.keys(catalog.providers)).toEqual([fixtureProvider]);
    expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(provider.models.map((model: { id: string }) => model.id)).toEqual(
      Object.values(fixtureModels),
    );
    expect(
      provider.models.every((model: { reasoning: boolean }) => model.reasoning === false),
    ).toBe(true);
    expect(JSON.parse(readFileSync(join(fixture.agentDir, "auth.json"), "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf8"))).toEqual({});
    expect(fixture.model("operator")).not.toBe(fixture.model("nonHolder"));
    expect(existsSync(join(fixture.agentDir, "node_modules"))).toBe(false);
  },
);

it("consumes ordered tool steps only after their actual call IDs return, retaining earlier session history", async () => {
  const { fixture, next, input } = await setup();
  fixture.arm("operator", plan());
  const first = await next(input([user()]));
  const call = first.tool_calls[0];
  expect(call.function).toEqual({
    name: "sprout_lease_get",
    arguments: JSON.stringify({ machineId: "fixture-machine" }),
  });
  expect(() => fixture.assertDrained()).toThrow("unused");
  const history = [user(), assistant(call), result(call.id)];
  expect((await next(input(history))).content).toBe(plan().reply);
  fixture.assertDrained();
  fixture.arm("operator", plan());
  const second = await next(
    input([...history, { role: "assistant", content: plan().reply }, user()]),
  );
  expect(second.tool_calls[0].id).not.toBe(call.id);
  expect(fixture.metadata().models[0]).toMatchObject({ completedPlans: 1, unusedSteps: 0 });
});

it("queues a later driven turn while an earlier plan is still open", async () => {
  const { fixture, next, input } = await setup();
  fixture.arm("operator", plan());
  fixture.arm("operator", {
    expectedUserText: "second turn",
    expectedUserPrefix: "second turn",
    steps: [],
    reply: "second reply",
    queued: true,
  });
  const first = await next(input([user()]));
  const call = first.tool_calls[0];
  const history = [user(), assistant(call), result(call.id)];
  expect((await next(input(history))).content).toBe(plan().reply);
  const second = await next(
    input([...history, { role: "assistant", content: plan().reply }, user("second turn")]),
  );
  expect(second.content).toBe("second reply");
  expect(fixture.metadata().models[0]).toMatchObject({ completedPlans: 2, unusedSteps: 0 });
  fixture.assertDrained();
});

it("holds a planned reply for its bounded delay", async () => {
  const { fixture, next, input } = await setup();
  fixture.arm("operator", {
    expectedUserText: prompt,
    expectedUserPrefix: prompt,
    steps: [],
    reply: "delayed reply",
    delayMs: 100,
  });
  const started = Date.now();
  expect((await next(input([user()]))).content).toBe("delayed reply");
  expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  fixture.assertDrained();
});

it("isolates model queues even when both models have a pending turn", async () => {
  const { fixture, next, input } = await setup();
  fixture.arm("operator", plan());
  fixture.arm("nonHolder", {
    ...plan(),
    steps: [{ name: "sprout_lease_get", arguments: { machineId: "other-machine" } }],
  });
  const other = await next(input([user()], fixtureModels.nonHolder));
  expect(JSON.parse(other.tool_calls[0].function.arguments)).toEqual({
    machineId: "other-machine",
  });
  expect(fixture.metadata().models[0].unusedSteps).toBe(1);
  const own = await next(input([user()]));
  expect(JSON.parse(own.tool_calls[0].function.arguments)).toEqual({
    machineId: "fixture-machine",
  });
});

it.each(["missing", "empty", "wrong", "only-history", "wrong-after-history"] as const)(
  "rejects a %s new user message before calling tools",
  async (variant) => {
    const { fixture, request, next, input } = await setup();
    let history: unknown[] = [];
    if (variant === "only-history" || variant === "wrong-after-history") {
      fixture.arm("operator", plan());
      const call = (await next(input([user()]))).tool_calls[0];
      history = [user(), assistant(call), result(call.id)];
      await next(input(history));
    }
    fixture.arm("operator", plan());
    const messages =
      variant === "missing"
        ? []
        : variant === "empty"
          ? [user("")]
          : variant === "wrong"
            ? [user("Do something else.")]
            : variant === "wrong-after-history"
              ? [...history, user("Do something else.")]
              : history;
    expect((await request(input(messages))).status).toBe(400);
    expect(fixture.metadata().models[0].unusedSteps).toBe(1);
    expect(() => fixture.assertDrained()).toThrow("rejected");
  },
);

it.each([
  "missing-schema",
  "incompatible-schema",
  "wrong-model",
  "unarmed-model",
  "non-stream",
  "malformed-json",
  "wrong-route",
  "wrong-method",
] as const)("fails closed for %s", async (variant) => {
  const { fixture, request, endpoint, input } = await setup();
  fixture.arm("operator", plan());
  const body = input([user()]);
  if (variant === "missing-schema") body.tools = [];
  if (variant === "incompatible-schema")
    body.tools = [
      {
        type: "function",
        function: {
          name: "sprout_lease_get",
          parameters: { type: "object", properties: { machineId: { type: "integer" } } },
        },
      },
    ];
  if (variant === "wrong-model") body.model = "real-provider-model";
  if (variant === "unarmed-model") body.model = fixtureModels.nonHolder;
  if (variant === "non-stream") body.stream = false;
  const response =
    variant === "malformed-json"
      ? await request(body, { body: "{" })
      : variant === "wrong-route"
        ? await fetch(endpoint + "/other", { method: "POST" })
        : variant === "wrong-method"
          ? await fetch(endpoint)
          : await request(body);
  expect(response.status).toBe(400);
  expect(() => fixture.assertHealthy()).toThrow("rejected");
  expect(fixture.metadata().models.every((model) => model.completedPlans === 0)).toBe(true);
});

it.each(["missing", "wrong-id", "extra", "changed-args", "wrong-order", "empty-result"] as const)(
  "rejects %s results or call transcript without advancing",
  async (variant) => {
    const { fixture, request, next, input } = await setup();
    fixture.arm("operator", { ...plan(), steps: [...plan().steps, ...plan().steps] });
    const call = (await next(input([user()]))).tool_calls[0];
    const messages: unknown[] = [user(), assistant(call)];
    if (variant !== "missing")
      messages.push(result(variant === "wrong-id" ? "old-call-id" : call.id));
    if (variant === "extra") messages.push(result(call.id));
    if (variant === "changed-args") call.function.arguments = '{"machineId":"wrong-machine"}';
    if (variant === "empty-result") messages[2] = { ...result(call.id), content: "" };
    if (variant === "wrong-order") {
      const second = (await next(input(messages))).tool_calls[0];
      const secondMessages = input([
        user(),
        assistant(call),
        result(second.id),
        assistant(second),
        result(call.id),
      ]);
      expect((await request(secondMessages)).status).toBe(400);
    } else expect((await request(input(messages))).status).toBe(400);
    expect(() => fixture.assertDrained()).toThrow("rejected");
    expect(fixture.metadata().models[0].completedPlans).toBe(0);
  },
);

it("validates the UI lease intent and binds its request ID to the exact mutation after lease_get", async () => {
  const { fixture, next, input, tool } = await setup();
  const parameters = {
    machineId: "fixture-machine",
    expectedGeneration: 2,
    targetInstanceId: "target-instance",
  };
  const requestId = "req_41ba6f8b-527c-46ea-9f94-687e740d3e29";
  const content = `请使用 sprout_lease_handoff 工具执行以下租约请求，参数必须保持一致。先读取当前租约，若代次已变化请报告冲突，不要自动重试。只操作这台明确指定的 Machine；不要运行 shell 或修改文件。参数：${JSON.stringify({ ...parameters, requestId })}。完成后报告服务端收据。`;
  fixture.arm("operator", leaseTurn("handoff", parameters));
  const tools = [
    tool("sprout_lease_get"),
    {
      type: "function",
      function: {
        name: "sprout_lease_handoff",
        parameters: {
          type: "object",
          properties: {
            machineId: { type: "string" },
            expectedGeneration: { type: "integer" },
            targetInstanceId: { type: "string" },
            requestId: { type: "string" },
          },
        },
      },
    },
  ];
  const get = (await next(input([user(content)], fixtureModels.operator, tools))).tool_calls[0];
  expect(get.function.name).toBe("sprout_lease_get");
  const history = [user(content), assistant(get), result(get.id)];
  const handoff = (await next(input(history, fixtureModels.operator, tools))).tool_calls[0];
  expect(handoff.function.name).toBe("sprout_lease_handoff");
  expect(JSON.parse(handoff.function.arguments)).toEqual({ ...parameters, requestId });
  await next(
    input([...history, assistant(handoff), result(handoff.id)], fixtureModels.operator, tools),
  );
  fixture.assertDrained();
  expect(fixture.metadata()).toMatchObject({ requestCount: 3, failed: false, paidModelCalls: 0 });
});

it.each(["action", "machine", "generation", "target", "request"] as const)(
  "rejects a UI lease message with the wrong %s",
  async (variant) => {
    const { fixture, request, input } = await setup();
    const parameters = {
      machineId: "fixture-machine",
      expectedGeneration: 2,
      targetInstanceId: "target-instance",
    };
    fixture.arm("operator", leaseTurn("handoff", parameters));
    const changed = { ...parameters, requestId: "req_41ba6f8b-527c-46ea-9f94-687e740d3e29" };
    if (variant === "machine") changed.machineId = "other-machine";
    if (variant === "generation") changed.expectedGeneration++;
    if (variant === "target") changed.targetInstanceId = "other-instance";
    if (variant === "request") changed.requestId = "invalid-request";
    const action = variant === "action" ? "release" : "handoff";
    const content = `请使用 sprout_lease_${action} 工具执行以下租约请求，参数必须保持一致。先读取当前租约，若代次已变化请报告冲突，不要自动重试。只操作这台明确指定的 Machine；不要运行 shell 或修改文件。参数：${JSON.stringify(changed)}。完成后报告服务端收据。`;
    expect((await request(input([user(content)]))).status).toBe(400);
    expect(fixture.metadata().models[0].unusedSteps).toBe(2);
  },
);

it("reports unused steps and closes the endpoint and private config, including repeated close", async () => {
  const { fixture, endpoint } = await setup();
  fixture.arm("operator", plan());
  expect(() => fixture.assertDrained()).toThrow("unused");
  await fixture.close();
  await fixture.close();
  expect(existsSync(fixture.agentDir)).toBe(false);
  await expect(fetch(endpoint)).rejects.toThrow();
  expect(() => fixture.arm("operator", plan())).toThrow("healthy and open");
});

it("fails before serving if the SDK is unavailable, with no live fallback", async () => {
  const privateDir = directory();
  await expect(
    startModelFixture({ privateDir, sourceAgentDir: join(privateDir, "absent") }),
  ).rejects.toThrow("installed Pi SDK");
  expect(existsSync(join(privateDir, "model-fixture-agent"))).toBe(false);
});

it("accepts a Chinese user message split inside a UTF-8 character across HTTP chunks", async () => {
  const { fixture, endpoint, provider, input } = await setup();
  const expectedUserText = "读取当前 Machine 租约。";
  fixture.arm("operator", { ...plan(), expectedUserText });
  const payload = Buffer.from(JSON.stringify(input([user(expectedUserText)])));
  const split = payload.indexOf(Buffer.from("读")) + 1;
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.apiKey}`,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.write(payload.subarray(0, split), () =>
      setImmediate(() => request.end(payload.subarray(split))),
    );
  });
  expect(status).toBe(200);
  fixture.assertHealthy();
});

it("runs the CLI status plan with empty arguments and waits for its actual tool payload", async () => {
  const { fixture, next, input, tool } = await setup();
  const turn = statusTurn();
  fixture.arm("status", turn);
  const tools = [tool("sprout_status", {})];
  const message = user(turn.expectedUserText);
  const call = (await next(input([message], fixtureModels.status, tools))).tool_calls[0];
  expect(call.function).toEqual({ name: "sprout_status", arguments: "{}" });
  expect(() => fixture.assertDrained()).toThrow("unused");
  const actualResult = {
    role: "tool",
    tool_call_id: call.id,
    content: '{"app":"sprout-mio","contractVersion":1}',
  };
  expect(
    (await next(input([message, assistant(call), actualResult], fixtureModels.status, tools)))
      .content,
  ).toBe(turn.reply);
  fixture.assertDrained();
  expect(
    fixture.metadata().models.find((model) => model.model === fixtureModels.status)?.completedPlans,
  ).toBe(1);
});

it.each(["", "unknown"])(
  "a-base rejects mode %s before creating logs or invoking preparation",
  (mode) => {
    const root = directory();
    const script = join(root, "scripts", "verify", "a-base.sh");
    mkdirSync(dirname(script), { recursive: true });
    cpSync(resolve("scripts/verify/a-base.sh"), script);
    const child = spawnSync("bash", [script], {
      env: { ...process.env, SPROUT_VERIFY_CHAT_MODE: mode },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stderr).toContain("must be model-fixture or live");
    expect(existsSync(join(root, ".verify"))).toBe(false);
  },
);

it.each([undefined, "", "unknown", "live"] as const)(
  "validates shell mode %s before any artifact preparation",
  (mode) => {
    const root = directory();
    const script = join(root, "scripts", "verify", "z-lease-integration.sh");
    mkdirSync(dirname(script), { recursive: true });
    cpSync(resolve("scripts/verify/z-lease-integration.sh"), script);
    mkdirSync(join(dirname(script), "lib"));
    writeFileSync(
      join(dirname(script), "lib", "ensure-worker-artifact.sh"),
      'ensure_worker_artifact() { printf "PREP:%s" "$SPROUT_VERIFY_CHAT_MODE"; exit 73; }\n',
    );
    const env = { ...process.env, SPROUT_VERIFY_CHAT_MODE: mode, SPROUT_PI_RUNNER: "" };
    if (mode === undefined) delete env.SPROUT_VERIFY_CHAT_MODE;
    const child = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 10000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(mode === "" || mode === "unknown" ? 2 : 73);
    expect(child.stdout).toBe(
      mode === "" || mode === "unknown" ? "" : `PREP:${mode ?? "model-fixture"}`,
    );
    expect(existsSync(join(root, ".verify"))).toBe(false);
  },
);

it("claims a product-initiated turn by prefix and keeps later driven turns on their plans", async () => {
  const { fixture, next, input } = await setup();
  const notice = (suffix: string) => ({
    role: "user",
    content: `资源撤销通知 ntc_${suffix}：租约已交接给其他分身。`,
  });
  fixture.arm("operator", {
    expectedUserPrefix: "资源撤销通知",
    repeat: true,
    steps: [],
    reply: "notice acknowledged",
  });
  const first = await next(input([notice("1")]));
  expect(first.content).toBe("notice acknowledged");
  const history = [notice("1"), { role: "assistant", content: "notice acknowledged" }];
  fixture.arm("operator", {
    expectedUserText: prompt,
    steps: [{ name: "sprout_lease_get", arguments: { machineId: "fixture-machine" } }],
    reply: "driven turn",
  });
  const driven = await next(input([...history, user()]));
  expect(driven.tool_calls[0].function.name).toBe("sprout_lease_get");
  const repeated = await next(
    input([...history, user(), { role: "assistant", content: "driven turn" }, notice("2")]),
  );
  expect(repeated.content).toBe("notice acknowledged");
  expect(fixture.metadata().models[0].completedPlans).toBe(2);
});
