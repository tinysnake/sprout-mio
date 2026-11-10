import { afterAll, expect, it } from "vite-plus/test";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { channelNativeFixture } from "./fixtures/channel-native";
import type { ChannelEmissionPort, ChannelOutcome, ChannelRequest } from "../src/contracts/channel";
import type { VerifiedFeishuEvent } from "../src/contracts/feishu";

const f = await channelNativeFixture();
const { sqlite } = f;
afterAll(() => f.close());
const rows = () =>
  sqlite.prepare("SELECT * FROM channel_delivery ORDER BY rowid").all() as {
    id: string;
    message_id: string;
    state: string;
    route: string;
    envelope: string;
    attempts: number;
    error: string;
  }[];
function pinned() {
  const row = rows().at(-1)!;
  return { row, envelope: JSON.parse(row.envelope) as ChannelRequest["envelope"] };
}
const accepted = (): ChannelOutcome => ({ kind: "accepted", messageId: "platform-receipt" });
function port(outcome: ChannelOutcome = accepted()): ChannelEmissionPort<ChannelRequest> {
  return {
    prepare: async (input) => input,
    begin: () => ({ initiated: true, completion: Promise.resolve(outcome) }),
  };
}
function onlyReady(id: string) {
  sqlite
    .prepare("UPDATE channel_delivery SET state='failed' WHERE id<>? AND state='ready'")
    .run(id);
}

it("captures Web and Feishu-origin replies in their native commit and rolls source/outbox/grants back together", async () => {
  const s = f.scenario();
  s.bind();
  const source = s.principal();
  const count = rows().length;
  expect(() =>
    sqlite
      .transaction(() => {
        s.reply("rolled-back reply");
        expect(rows()).toHaveLength(count + 1);
        throw new Error("source rollback");
      })
      .immediate(),
  ).toThrow("source rollback");
  expect(rows()).toHaveLength(count);
  expect(
    sqlite.prepare("SELECT id FROM message WHERE body='rolled-back reply'").get(),
  ).toBeUndefined();
  const first = s.reply("Web entrance answer");
  const scope = f.feishu.captureFeishuAdmissionScope(s.project.id, s.identity, s.epoch)!;
  expect(
    f.feishu.admitFeishuText(
      {
        identity: s.identity,
        messageId: "platform-human-input",
        body: "same assistant",
        chatType: "p2p",
        messageType: "text",
        createdAtMs: Date.now(),
      } as VerifiedFeishuEvent,
      scope,
      "req_input",
    ),
  ).toMatchObject({ status: "accepted" });
  const second = s.reply("Feishu entrance answer");
  expect(
    rows()
      .slice(count)
      .map((row) => row.message_id),
  ).toEqual([first, second]);
  expect(rows().every((row) => row.message_id !== source.run.id)).toBe(true);
  const proposalSource = s.principal();
  const beforeGrant = sqlite.prepare("SELECT count(*) n FROM channel_action_grant").get();
  expect(() =>
    sqlite
      .transaction(() => {
        f.assistant.createAssistantProposal(
          proposalSource,
          { kind: "dm_agent", projectId: s.project.id, agentProfileId: s.worker.id },
          "atomic card",
          new Date(),
        );
        throw new Error("rollback card");
      })
      .immediate(),
  ).toThrow("rollback card");
  expect(sqlite.prepare("SELECT count(*) n FROM channel_action_grant").get()).toEqual(beforeGrant);
  expect(
    sqlite.prepare("SELECT id FROM assistant_proposal WHERE body='atomic card'").get(),
  ).toBeUndefined();
});

it("never scans historical outputs at bind/reconnect/switch and excludes Human/worker messages", () => {
  const s = f.scenario();
  s.reply("before bind");
  const before = rows().length;
  s.bind();
  expect(rows()).toHaveLength(before);
  s.lifecycle.disconnected(s.epoch);
  s.reply("offline");
  s.reconnect();
  expect(rows()).toHaveLength(before);
  s.reply("online");
  expect(rows()).toHaveLength(before + 1);
  f.chats.sendMessage(
    s.work.id,
    { senderKind: "human", senderId: s.ctx.userId, body: "worker please" },
    s.ctx,
  );
  const wrun = f.runs.listAgentRuns(s.work.id, s.ctx)[0];
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=unixepoch() WHERE id=?")
    .run(wrun.id);
  f.runs.settleAgentRun(wrun.id, { status: "aborted", reply: "worker output" }, s.ctx);
  expect(rows()).toHaveLength(before + 1);
  const other = f.agents.createAgentProfile(
    { name: "Other assistant", purpose: "assistant" },
    s.ctx,
  );
  f.agents.addProjectMember(s.project.id, other.id, s.ctx);
  const otherDm = f.chats.createDirectChat(s.project.id, other.id, s.ctx).chat;
  const switched = f.feishu.startFeishuChallenge(
    { projectId: s.project.id, chatId: otherDm.id },
    s.ctx,
  );
  f.feishu.finishFeishuChallenge(s.project.id, switched.challenge, s.identity, s.ctx.requestId);
  s.reply("old DM");
  expect(rows()).toHaveLength(before + 1);
  const restored = f.feishu.startFeishuChallenge(
    { projectId: s.project.id, chatId: s.dm.id },
    s.ctx,
  );
  f.feishu.finishFeishuChallenge(s.project.id, restored.challenge, s.identity, s.ctx.requestId);
  expect(rows()).toHaveLength(before + 1);
});

it.each(["aborted", "oversized"] as const)(
  "projects %s output with an explicit incomplete/size warning",
  (mode) => {
    const s = f.scenario();
    s.bind();
    s.reply(
      mode === "oversized" ? "界".repeat(5_000) : "Partial answer",
      mode === "aborted" ? "aborted" : "completed",
    );
    const { envelope } = pinned();
    expect(envelope.kind).toBe("text");
    if (envelope.kind === "text")
      expect(envelope.completeness).toBe(mode === "aborted" ? "incomplete" : "oversized");
    expect(envelope.text).toContain(mode === "aborted" ? "不完整" : "未在此发送完整内容");
  },
);

it.each(["unbind", "reconnect", "rights"] as const)(
  "rechecks %s after async preparation and suppresses the frozen route before begin",
  async (change) => {
    const s = f.scenario();
    s.bind();
    s.reply();
    const { row } = pinned();
    onlyReady(row.id);
    let begins = 0;
    let preparationError: unknown;
    await f.delivery.emitNextFeishuDelivery({
      prepare: async (input) => {
        expect(sqlite.inTransaction).toBe(false);
        try {
          if (change === "unbind")
            f.feishu.unbindFeishuIdentity(
              s.project.id,
              f.feishu.getFeishuBinding(s.project.id, s.ctx).revision,
              s.ctx,
            );
          if (change === "reconnect") s.reconnect();
          if (change === "rights") f.agents.removeProjectMember(s.project.id, s.helper.id, s.ctx);
        } catch (error) {
          preparationError = error;
          throw error;
        }
        return input;
      },
      begin: () => {
        begins++;
        return { initiated: true, completion: Promise.resolve(accepted()) };
      },
    });
    expect(preparationError).toBeUndefined();
    expect(begins).toBe(0);
    expect(rows().find((r) => r.id === row.id)?.state).toBe("suppressed");
    expect(
      sqlite.prepare("SELECT outcome FROM channel_attempt WHERE delivery_id=?").get(row.id),
    ).toEqual({ outcome: "suppressed" });
  },
);

it("suppresses an already-prepared payload when source settlement changes it to incomplete", async () => {
  const s = f.scenario();
  s.bind();
  s.reply();
  const { row } = pinned();
  onlyReady(row.id);
  const messageId = (
    sqlite.prepare("SELECT message_id FROM channel_delivery WHERE id=?").get(row.id) as {
      message_id: string;
    }
  ).message_id;
  let begins = 0;
  await f.delivery.emitNextFeishuDelivery({
    prepare: async (input) => {
      sqlite.transaction(() => f.channel.markChannelReplyIncomplete(messageId)).immediate();
      expect(input.envelope).toMatchObject({ completeness: "complete" });
      return input;
    },
    begin: () => {
      begins++;
      return { initiated: true, completion: Promise.resolve(accepted()) };
    },
  });
  expect(begins).toBe(0);
  expect(rows().find((r) => r.id === row.id)?.state).toBe("suppressed");
});

it("uses synchronous HTTP begin under the final writer lock, commits armed before begin and releases the lock while response waits", async () => {
  const s = f.scenario();
  s.bind();
  s.reply();
  const { row } = pinned();
  onlyReady(row.id);
  const writer = new Database(process.env.DATABASE_URL!);
  writer.pragma("busy_timeout=0");
  let requests = 0;
  let releaseResponse: (() => void) | undefined;
  const received = new Promise<void>((resolve) => {
    const server = createServer((_req, res) => {
      requests++;
      releaseResponse = () => {
        res.end("ok");
      };
      resolve();
    });
    server.listen(0, "127.0.0.1");
    server.once("listening", () => {
      loopServer = server;
      start();
    });
  });
  let loopServer: ReturnType<typeof createServer>;
  let start!: () => void;
  const listening = new Promise<void>((resolve) => {
    start = resolve;
  });
  await listening;
  const server = loopServer!;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback address");
  let began = false;
  const pending = f.delivery.emitNextFeishuDelivery({
    prepare: async (input) => input,
    begin: (input) => {
      expect(sqlite.inTransaction).toBe(true);
      expect(
        writer.prepare("SELECT state FROM channel_delivery WHERE id=?").get(input.deliveryId),
      ).toEqual({ state: "armed" });
      expect(() =>
        writer
          .transaction(() =>
            writer
              .prepare("UPDATE feishu_route SET closed_at_ms=1 WHERE id=?")
              .run(input.route.routeId),
          )
          .immediate(),
      ).toThrow(/locked/);
      const req = request({ host: "127.0.0.1", port: address.port, method: "POST" });
      const completion = new Promise<ChannelOutcome>((resolve, reject) => {
        req.on("error", reject);
        req.on("response", (response) => {
          response.resume();
          response.on("end", () => resolve(accepted()));
        });
      });
      req.end(JSON.stringify(input.envelope));
      began = true;
      return { initiated: true, completion };
    },
  });
  await received;
  expect(began).toBe(true);
  writer
    .transaction(() =>
      writer
        .prepare("UPDATE feishu_route SET closed_at_ms=? WHERE id=?")
        .run(Date.now(), JSON.parse(row.route).routeId),
    )
    .immediate();
  releaseResponse!();
  await pending;
  expect(requests).toBe(1);
  expect(rows().find((r) => r.id === row.id)?.state).toBe("accepted");
  expect(rows().find((r) => r.id === row.id)?.route).toBe(row.route);
  writer.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it("a killed sender leaves committed armed state and recovery never repeats its HTTP request", async () => {
  const s = f.scenario();
  s.bind();
  s.reply();
  const { row } = pinned();
  onlyReady(row.id);
  let requests = 0;
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer(() => {
    requests++;
    received();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback address");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { request } from 'node:http';
    import { emitNextFeishuDelivery } from './src/domain/feishu-delivery.ts';
    await emitNextFeishuDelivery({ prepare: async input => input, begin: input => {
      const req = request({ host: '127.0.0.1', port: ${address.port}, method: 'POST' });
      const completion = new Promise((resolve, reject) => { req.on('error', reject); req.on('response', res => { res.resume(); res.on('end', () => resolve({kind:'accepted', messageId:'receipt'})); }); });
      req.end(JSON.stringify(input.envelope));
      return { initiated: true, completion };
    } });
  `,
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 || signal === "SIGKILL"
        ? resolve()
        : reject(new Error(stderr || `sender exit ${code}`)),
    );
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await Promise.race([
      arrival,
      exited.then(() => {
        throw new Error("sender exited before handoff");
      }),
    ]);
    expect(sqlite.prepare("SELECT state FROM channel_delivery WHERE id=?").get(row.id)).toEqual({
      state: "armed",
    });
    child.kill("SIGKILL");
    await exited;
    expect(f.channel.recoverChannelDeliveries("feishu")).toBe(1);
    expect(await f.delivery.emitNextFeishuDelivery(port())).toBeNull();
    expect(rows().find((r) => r.id === row.id)?.state).toBe("uncertain");
    expect(requests).toBe(1);
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15_000);

it("recovers persisted armed state as uncertain without another HTTP handoff, and only proven non-acceptance retries the same uuid", async () => {
  const s = f.scenario();
  s.bind();
  s.reply();
  const { row } = pinned();
  onlyReady(row.id);
  // Faithful restart boundary: this reader is independent of the domain connection, observes a committed armed record, and recovery runs before any subsequent drain.
  let calls = 0;
  let finish!: (value: ChannelOutcome) => void;
  const completion = new Promise<ChannelOutcome>((resolve) => {
    finish = resolve;
  });
  const pending = f.delivery.emitNextFeishuDelivery({
    prepare: async (input) => input,
    begin: () => {
      calls++;
      return { initiated: true, completion };
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const persisted = new Database(process.env.DATABASE_URL!);
  expect(persisted.prepare("SELECT state FROM channel_delivery WHERE id=?").get(row.id)).toEqual({
    state: "armed",
  });
  persisted.close();
  expect(f.channel.recoverChannelDeliveries("feishu")).toBe(1);
  expect(await f.delivery.emitNextFeishuDelivery(port())).toBeNull();
  finish({ kind: "uncertain", code: "ack_lost" });
  await pending;
  expect(calls).toBe(1);
  expect(rows().find((r) => r.id === row.id)?.state).toBe("uncertain");
  s.reply("retryable answer");
  const retry = pinned().row;
  onlyReady(retry.id);
  const uuids: string[] = [];
  let clock = Date.now();
  const retryPort: ChannelEmissionPort<ChannelRequest> = {
    prepare: async (input) => {
      uuids.push(input.uuid);
      return input;
    },
    begin: () => ({
      initiated: true,
      completion: Promise.resolve(
        uuids.length === 1 ? { kind: "not_accepted", code: "rate_limited" } : accepted(),
      ),
    }),
  };
  await f.delivery.emitNextFeishuDelivery(retryPort, { now: () => new Date(clock) });
  clock += 2_000;
  await f.delivery.emitNextFeishuDelivery(retryPort, { now: () => new Date(clock) });
  expect(uuids).toHaveLength(2);
  expect(new Set(uuids).size).toBe(1);
  expect(rows().find((r) => r.id === retry.id)?.state).toBe("accepted");
});

it("records a late acknowledgement against the frozen route after timeout without sending again", async () => {
  const s = f.scenario();
  s.bind();
  s.reply();
  const { row } = pinned();
  onlyReady(row.id);
  let complete!: (value: ChannelOutcome) => void;
  let calls = 0;
  const completion = new Promise<ChannelOutcome>((resolve) => {
    complete = resolve;
  });
  await f.delivery.emitNextFeishuDelivery(
    {
      prepare: async (input) => input,
      begin: () => {
        calls++;
        return { initiated: true, completion };
      },
    },
    { timeoutMs: 5 },
  );
  expect(rows().find((r) => r.id === row.id)?.state).toBe("uncertain");
  s.reconnect();
  complete({ kind: "accepted", messageId: "late-platform-message" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(rows().find((r) => r.id === row.id)?.state).toBe("accepted");
  expect(rows().find((r) => r.id === row.id)?.route).toBe(row.route);
  expect(await f.delivery.emitNextFeishuDelivery(port())).toBeNull();
  expect(calls).toBe(1);
});

it.each(["ack_lost", "timeout", "invalid_port"] as const)(
  "%s never automatically resends and terminal failures do not starve another DM",
  async (mode) => {
    const s = f.scenario();
    s.bind();
    s.reply();
    const { row } = pinned();
    onlyReady(row.id);
    let calls = 0;
    const badPort = {
      prepare: async (input: ChannelRequest) => input,
      begin: () => {
        calls++;
        if (mode === "invalid_port")
          return Promise.resolve({ initiated: true, completion: Promise.resolve(accepted()) });
        return {
          initiated: true,
          completion:
            mode === "timeout"
              ? new Promise<ChannelOutcome>(() => {})
              : Promise.reject(new Error("lost ack")),
        };
      },
    } as unknown as ChannelEmissionPort<ChannelRequest>;
    await f.delivery.emitNextFeishuDelivery(badPort, { timeoutMs: 10 });
    expect(rows().find((r) => r.id === row.id)?.state).toBe("uncertain");
    const other = f.scenario();
    other.bind();
    other.reply("later DM");
    const next = pinned().row;
    await f.delivery.emitNextFeishuDelivery(port());
    expect(rows().find((r) => r.id === next.id)?.state).toBe("accepted");
    expect(calls).toBe(1);
  },
);
