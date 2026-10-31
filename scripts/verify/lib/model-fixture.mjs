import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const fixtureProvider = "sprout-verify-local";
export const fixtureModels = Object.freeze({
  operator: "lease-operator",
  nonHolder: "lease-non-holder",
  status: "status-probe",
  chatOwner: "chat-owner",
  chatMentioned: "chat-mentioned",
  chatUnmentioned: "chat-unmentioned",
});
const dummyKey = "sprout-local-fixture-key";

function installedSdk(agentDir) {
  const candidates = [];
  try {
    let current = dirname(realpathSync(join(agentDir, "bin", "pi")));
    while (current !== dirname(current)) {
      const manifest = join(current, "package.json");
      if (
        existsSync(manifest) &&
        JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent"
      )
        candidates.push(current);
      current = dirname(current);
    }
  } catch {}
  const releases = join(agentDir, "install", "releases");
  if (existsSync(releases)) {
    for (const version of readdirSync(releases)
      .filter((value) => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      candidates.push(
        join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent"),
      );
    }
  }
  const sdk = candidates.find(
    (path) =>
      existsSync(join(path, "dist", "index.js")) && existsSync(join(path, "dist", "cli.js")),
  );
  assert(sdk, "model fixture requires the installed Pi SDK (PI_CODING_AGENT_DIR or ~/.pi/agent)");
  return sdk;
}

const textContent = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("")
      : "";
const leasePrefix = (action) =>
  `请使用 sprout_lease_${action} 工具执行以下租约请求，参数必须保持一致。先读取当前租约，若代次已变化请报告冲突，不要自动重试。只操作这台明确指定的 Machine；不要运行 shell 或修改文件。参数：`;
const leaseSuffix = "。完成后报告服务端收据。";

export function statusTurn() {
  return {
    expectedUserText:
      "Call sprout_status exactly once with empty arguments. Then report the returned payload. Do not use other tools.",
    steps: [{ name: "sprout_status", arguments: {} }],
    reply:
      "Local model fixture received the actual sprout_status payload; inspect the completed tool event.",
  };
}

export function leaseTurn(action, parameters) {
  assert(["acquire", "release", "handoff"].includes(action), "known lease action");
  return {
    lease: { action, parameters: structuredClone(parameters) },
    reply: "Local model fixture completed the requested tools; inspect the server receipt.",
  };
}

const turnContextPrefix = '{"channel":"sprout_turn_context"';

function stripTurnContext(text) {
  if (!text.startsWith(turnContextPrefix)) return text;
  const [envelope, ...rest] = text.split("\n\n");
  try {
    JSON.parse(envelope);
  } catch {
    return text;
  }
  return rest.join("\n\n");
}

function bindLeaseTurn(plan, rawUserText) {
  // 轮初上下文以一行 JSON 前缀挂在同一条 user 消息上，租约意图是正文的开头与结尾。
  const userText = stripTurnContext(rawUserText);
  const { action, parameters } = plan.lease;
  const prefix = leasePrefix(action);
  assert(
    userText.startsWith(prefix) && userText.endsWith(leaseSuffix),
    "new user message must match the armed lease intent",
  );
  const actual = JSON.parse(userText.slice(prefix.length, -leaseSuffix.length));
  assert.match(
    actual.requestId,
    /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const { requestId, ...rest } = actual;
  assert.deepEqual(rest, parameters, "lease intent parameters match driver scenario");
  assert.equal(
    userText,
    `${prefix}${JSON.stringify(actual)}${leaseSuffix}`,
    "exact lease user message",
  );
  plan.expectedUserText = userText;
  plan.steps = [
    { name: "sprout_lease_get", arguments: { machineId: parameters.machineId } },
    { name: `sprout_lease_${action}`, arguments: { ...parameters, requestId } },
  ];
}

function compatibleTool(tools, step) {
  const matches = tools.filter(
    (tool) => tool.type === "function" && tool.function?.name === step.name,
  );
  assert.equal(matches.length, 1, "planned tool must be registered exactly once");
  const schema = matches[0].function.parameters;
  assert(schema && typeof schema === "object", "planned tool has an object schema");
  // A discriminated tool (oneOf/anyOf) declares its fields per branch. The planned
  // arguments must claim exactly one branch and satisfy that branch, so the check stays
  // as strict as the flat case instead of waving the call through.
  const branches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [schema];
  const claims = (branch) => {
    const properties = branch.properties ?? {};
    return (
      Object.keys(step.arguments).every((key) => {
        const field = properties[key];
        if (!field) return false;
        if (field.const !== undefined) return field.const === step.arguments[key];
        if (Array.isArray(field.enum)) return field.enum.includes(step.arguments[key]);
        return true;
      }) && (branch.required ?? []).every((key) => Object.hasOwn(step.arguments, key))
    );
  };
  const branch = branches.length === 1 ? branches[0] : branches.find(claims);
  assert(branch, "planned arguments must claim exactly one registered schema branch");
  assert.equal(branch.type, "object", "planned tool has an object schema");
  for (const key of branch.required ?? [])
    assert(Object.hasOwn(step.arguments, key), "planned arguments satisfy required schema fields");
  for (const [key, value] of Object.entries(step.arguments)) {
    const field = branch.properties?.[key];
    assert(field, "planned argument must exist in registered tool schema");
    if (field.type === "integer") assert(Number.isSafeInteger(value), "planned integer argument");
    else if (["string", "number", "boolean"].includes(field.type))
      assert.equal(typeof value, field.type, "planned argument type");
  }
}

export async function startModelFixture({
  privateDir,
  sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
}) {
  const sdk = installedSdk(sourceAgentDir);
  const agentDir = join(privateDir, "model-fixture-agent");
  const states = new Map(
    Object.values(fixtureModels).map((model) => [
      model,
      { plans: [], lastUserCount: 0, completed: 0 },
    ]),
  );
  let failure;
  let requests = 0;
  let closed = false;
  const server = createServer(async (request, response) => {
    try {
      assert(!failure, "fixture already failed");
      assert.equal(request.method, "POST", "fixture only accepts POST");
      assert.equal(request.url, "/v1/chat/completions", "fixture endpoint");
      assert.equal(request.headers.authorization, `Bearer ${dummyKey}`, "fixture dummy key");
      assert.match(request.headers["content-type"] ?? "", /^application\/json(?:;|$)/);
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert(Buffer.byteLength(body) <= 4 * 1024 * 1024, "fixture request size");
      }
      const input = JSON.parse(body);
      const state = states.get(input.model);
      assert(state, "unexpected fixture model");
      requests++;
      assert.equal(input.stream, true, "fixture requires streaming");
      assert(
        Array.isArray(input.messages) && Array.isArray(input.tools),
        "messages and tool schemas required",
      );
      const users = input.messages.filter((message) => message.role === "user");
      const latestUser = input.messages.findLastIndex((message) => message.role === "user");
      // P6b 起，runner 把轮初上下文以一行 JSON 前缀进同一条 user 消息（`<context>\n\n<text>`）。
      // 有的计划绑定整条消息（用 expectedUserPrefix 认领信封），有的绑定那轮真正的指令文本，
      // 所以两处都算匹配：原样文本与剥掉信封后的正文。信封本身由 bf-p6b-turn-context 证明。
      const userText = textContent(input.messages[latestUser]?.content);
      const userBody = stripTurnContext(userText);
      // 被驱动的一轮和产品自己发起的一轮（撤销通知之类）会交错到达，所以按对话文本认领计划，
      // 而不是按排队顺序：先布好的计划不会被晚到的一轮挤掉。
      // 认领优先级：完全一致的对话文本 > 前缀（产品自己发起的通知轮次）> 未绑定文本的租约轮次。
      const claimRank = (candidate) =>
        candidate.expectedUserText === userText || candidate.expectedUserText === userBody
          ? 0
          : candidate.expectedUserPrefix !== undefined &&
              (userText.startsWith(candidate.expectedUserPrefix) ||
                userBody.startsWith(candidate.expectedUserPrefix))
            ? 1
            : candidate.lease !== undefined
              ? 2
              : 3;
      let planIndex = -1;
      for (const [index, candidate] of state.plans.entries()) {
        const rank = claimRank(candidate);
        if (rank < 3 && (planIndex === -1 || rank < claimRank(state.plans[planIndex]))) {
          planIndex = index;
          if (rank === 0) break;
        }
      }
      const plan = planIndex === -1 ? undefined : state.plans[planIndex];
      assert(
        plan,
        `no armed turn for this model (model=${input.model} armed=${
          state.plans.length
        } completed=${state.completed} users=${users.length} lastUserCount=${
          state.lastUserCount
        } latestUser=${JSON.stringify(userText.slice(0, 160))})`,
      );
      if (!plan.started) {
        assert(users.length > state.lastUserCount, "armed turn requires a NEW user message");
        assert.equal(
          latestUser,
          input.messages.length - 1,
          "new turn must end with its user message",
        );
        if (plan.lease) bindLeaseTurn(plan, userText);
        if (plan.expectedUserText !== undefined)
          assert(
            userText === plan.expectedUserText || userBody === plan.expectedUserText,
            "new user message must match the armed turn",
          );
        assert(userText.length > 0, "new user message cannot be empty");
        plan.userCount = users.length;
        plan.started = true;
      }
      assert.equal(users.length, plan.userCount, "unexpected user message during a planned turn");
      if (plan.expectedUserText !== undefined)
        assert(
          userText === plan.expectedUserText || userBody === plan.expectedUserText,
          "current user message changed",
        );
      const current = input.messages.slice(latestUser + 1);
      const calls = current.flatMap((message) => message.tool_calls ?? []);
      const results = current.filter((message) => message.role === "tool");
      assert.equal(calls.length, plan.emitted.length, "unexpected or missing current tool call");
      assert.equal(
        results.length,
        plan.emitted.length,
        "each planned call needs its real result before advancing",
      );
      for (let i = 0; i < plan.emitted.length; i++) {
        const { id, step } = plan.emitted[i];
        assert.equal(calls[i].id, id, "planned call ID and order");
        assert.equal(calls[i].function.name, step.name, "planned call name");
        assert.deepEqual(
          JSON.parse(calls[i].function.arguments),
          step.arguments,
          "deterministic planned arguments",
        );
        assert.equal(results[i].tool_call_id, id, "real result belongs to current planned call ID");
        assert(textContent(results[i].content).length > 0, "actual tool result cannot be empty");
        const callPosition = current.findIndex((message) =>
          message.tool_calls?.some((call) => call.id === id),
        );
        const resultPosition = current.indexOf(results[i]);
        assert(callPosition < resultPosition, "tool result follows its assistant call");
        if (i > 0)
          assert(
            current.indexOf(results[i - 1]) < callPosition,
            "planned steps execute sequentially",
          );
      }
      const step = plan.steps[plan.emitted.length];
      if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
      let delta;
      if (step) {
        compatibleTool(input.tools, step);
        const id = `call_${randomUUID().replaceAll("-", "")}`;
        plan.emitted.push({ id, step });
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: { name: step.name, arguments: JSON.stringify(step.arguments) },
            },
          ],
        };
      } else {
        delta = { role: "assistant", content: plan.reply };
        state.lastUserCount = users.length;
        state.completed++;
        if (plan.repeat) {
          plan.started = false;
          plan.userCount = undefined;
          plan.emitted = [];
        } else state.plans.splice(planIndex, 1);
      }
      const chunk = (value, finish) => ({
        id: `chatcmpl-local-${requests}`,
        object: "chat.completion.chunk",
        created: 1,
        model: input.model,
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      const out = `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(
        chunk({}, step ? "tool_calls" : "stop"),
      )}\n\ndata: [DONE]\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(out);
    } catch (error) {
      failure ??= new Error(
        `Local model fixture rejected an unexpected request, prompt, tool schema or result sequence: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: failure.message } }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    mkdirSync(join(agentDir, "bin"), { recursive: true, mode: 0o700 });
    symlinkSync(join(sdk, "dist", "cli.js"), join(agentDir, "bin", "pi"), "file");
    const model = (id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
      },
    });
    const catalog = {
      providers: {
        [fixtureProvider]: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: dummyKey,
          models: Object.values(fixtureModels).map(model),
        },
      },
    };
    for (const [file, data] of Object.entries({
      "models.json": catalog,
      "auth.json": {},
      "settings.json": {},
    }))
      writeFileSync(join(agentDir, file), JSON.stringify(data), { mode: 0o600 });
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(agentDir, { recursive: true, force: true });
    throw error;
  }
  return {
    agentDir,
    model: (role) => `${fixtureProvider}/${fixtureModels[role]}`,
    arm(role, turn) {
      assert(!closed && !failure, "fixture must be healthy and open");
      const state = states.get(fixtureModels[role]);
      assert(state, "known fixture role");
      assert(
        state.plans.every((pending) => pending.repeat) || turn.queued === true,
        "previous model turn must complete before arming another unless it is explicitly queued",
      );
      assert(
        turn.lease ||
          (typeof turn.expectedUserText === "string" && turn.expectedUserText.length > 0) ||
          (typeof turn.expectedUserPrefix === "string" && turn.expectedUserPrefix.length > 0),
        "explicit new user expectation",
      );
      assert(
        turn.lease ||
          (Array.isArray(turn.steps) && turn.steps.length > 0) ||
          turn.expectedUserPrefix !== undefined,
        "explicit tool steps",
      );
      assert(typeof turn.reply === "string" && turn.reply.length > 0, "explicit final reply");
      if (turn.delayMs !== undefined)
        assert(
          Number.isSafeInteger(turn.delayMs) && turn.delayMs >= 0 && turn.delayMs <= 5000,
          "bounded nonnegative reply delay",
        );
      const plan = structuredClone(turn);
      delete plan.queued;
      state.plans.push({ ...plan, emitted: [], started: false });
    },
    assertHealthy() {
      if (failure) throw failure;
    },
    assertDrained() {
      if (failure) throw failure;
      for (const state of states.values())
        assert.equal(
          state.plans.filter((plan) => !plan.repeat).length,
          0,
          "unused model turn or tool steps",
        );
    },
    metadata() {
      return {
        mode: "model-fixture",
        provider: fixtureProvider,
        thinking: "off",
        requestCount: requests,
        models: [...states].map(([model, state]) => ({
          model,
          completedPlans: state.completed,
          unusedPlans: state.plans.length,
          unusedSteps: state.plans.reduce(
            (sum, plan) => sum + (plan.steps?.length ?? 2) - plan.emitted.length,
            0,
          ),
        })),
        failed: Boolean(failure),
        paidModelCalls: 0,
        paidModelCallsBasis: "private catalog with loopback endpoint and every caller model pinned",
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
