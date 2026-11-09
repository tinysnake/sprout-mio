import { afterAll, expect, it } from "vite-plus/test";
import { createServer, request } from "node:http";
import Database from "better-sqlite3";
import { feishuNativeFixture } from "./fixtures/feishu-native";

const fixture = await feishuNativeFixture();
const { sqlite, chats, dm, ctx } = fixture;
afterAll(() => fixture.close());

it("F0: outer IMMEDIATE and nested native savepoints roll back receipt, message and run lineage", () => {
  sqlite.exec("CREATE TABLE risk_receipt (id TEXT PRIMARY KEY, message_id TEXT NOT NULL)");
  const count = (table: string) =>
    (sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const before = [count("message"), count("agent_run_input"), count("agent_run")];
  const admit = (failure?: "hook" | "outer") =>
    sqlite
      .transaction(() => {
        const old = sqlite.prepare("SELECT message_id FROM risk_receipt WHERE id='event'").get() as
          | { message_id: string }
          | undefined;
        if (old) return old.message_id;
        const saved = chats.sendMessage(
          dm.id,
          { senderKind: "human", senderId: ctx.userId, body: "native receipt probe" },
          ctx,
          {
            afterWrite: () => {
              if (failure === "hook") throw new Error("hook rollback");
            },
          },
        );
        sqlite.prepare("INSERT INTO risk_receipt VALUES ('event',?)").run(saved.id);
        if (failure === "outer") throw new Error("outer rollback");
        return saved.id;
      })
      .immediate();
  for (const failure of ["hook", "outer"] as const) {
    expect(() => admit(failure)).toThrow(`${failure} rollback`);
    expect(count("risk_receipt")).toBe(0);
    expect([count("message"), count("agent_run_input"), count("agent_run")]).toEqual(before);
  }
  const accepted = admit();
  expect(admit()).toBe(accepted);
  expect(count("risk_receipt")).toBe(1);
  const reader = new Database(process.env.DATABASE_URL!, { readonly: true });
  try {
    expect(reader.prepare("SELECT message_id FROM risk_receipt WHERE id='event'").get()).toEqual({
      message_id: accepted,
    });
    expect(reader.prepare("SELECT count(*) n FROM message WHERE id=?").get(accepted)).toEqual({
      n: 1,
    });
  } finally {
    reader.close();
  }
  expect([count("message"), count("agent_run_input"), count("agent_run")]).toEqual(
    before.map((n) => n + 1),
  );
});

it("F0: synchronous HTTP begin is qualified under IMMEDIATE, with no writer lock during network wait", async () => {
  sqlite.exec(
    "CREATE TABLE risk_route (id TEXT PRIMARY KEY, active INTEGER NOT NULL); INSERT INTO risk_route VALUES ('original',1); CREATE TABLE risk_attempt (route_id TEXT NOT NULL)",
  );
  let beginCount = 0;
  const received: string[] = [];
  let releaseResponse: (() => void) | undefined;
  let markReceived: (() => void) | undefined;
  const arrival = new Promise<void>((resolve) => {
    markReceived = resolve;
  });
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      received.push(body);
      releaseResponse = () => response.end("ok");
      markReceived?.();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback address missing");
  const begin = () =>
    sqlite
      .transaction(() => {
        const route = sqlite.prepare("SELECT id FROM risk_route WHERE active=1").get() as
          | { id: string }
          | undefined;
        if (!route) return undefined;
        sqlite.prepare("INSERT INTO risk_attempt VALUES (?)").run(route.id);
        beginCount++;
        const response = new Promise<string>((resolve, reject) => {
          const outgoing = request(
            { host: "127.0.0.1", port: address.port, method: "POST" },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                body += chunk;
              });
              response.on("end", () => resolve(body));
            },
          );
          outgoing.setTimeout(5000, () => outgoing.destroy(new Error("loopback timeout")));
          outgoing.on("error", reject);
          outgoing.end(route.id);
        });
        return { response };
      })
      .immediate();
  try {
    sqlite.prepare("UPDATE risk_route SET active=0").run();
    expect(begin()).toBeUndefined();
    expect(beginCount).toBe(0);
    sqlite.prepare("UPDATE risk_route SET active=1").run();
    const result = begin()?.response;
    let settled = false;
    void result?.then(() => {
      settled = true;
    });
    await arrival;
    expect(settled).toBe(false);
    const second = new Database(process.env.DATABASE_URL!, { timeout: 0 });
    try {
      second
        .transaction(() => {
          second.prepare("UPDATE risk_route SET active=0").run();
          second.prepare("INSERT INTO risk_route VALUES ('replacement',1)").run();
        })
        .immediate();
    } finally {
      second.close();
    }
    expect(sqlite.prepare("SELECT route_id FROM risk_attempt").all()).toEqual([
      { route_id: "original" },
    ]);
    expect(received).toEqual(["original"]);
    expect(beginCount).toBe(1);
    expect(settled).toBe(false);
    releaseResponse?.();
    expect(await result).toBe("ok");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
