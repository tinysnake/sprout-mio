import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  loadServerFnNames,
  logRequest,
  parseServerFnMetas,
  serverFunctionId,
  type RequestLogRecord,
} from "../src/server/request-log";
import { summarize } from "../scripts/diagnostics/request-log.mjs";

const INFO_HUB_ID = "952eaa7513f1fd2af8bd145ff2c6d88bcab19b60c9e2147bf4282b6a907a7da9";

const record: RequestLogRecord = {
  requestId: "req_1",
  method: "POST",
  path: "/_serverFn/unknown",
  fn: null,
  fnId: null,
  status: 200,
  ms: 1,
  bytes: 0,
  complete: true,
};

function line(fields: Partial<RequestLogRecord>) {
  return `[request] ${JSON.stringify({ ...record, ...fields })}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SPROUT_REQUEST_LOG;
});

describe("server function metas", () => {
  it("parses the indented build layout", () => {
    const source = [
      "var getProjectInfoHubFn_createServerFn_handler = createServerRpc({",
      `\tid: "${INFO_HUB_ID}",`,
      '\tname: "getProjectInfoHubFn",',
      '\tfilename: "src/server/functions/info-hub.ts"',
      "}, (opts) => getProjectInfoHubFn.__executeServer(opts));",
    ].join("\n");
    expect(parseServerFnMetas(source)).toEqual([
      {
        id: INFO_HUB_ID,
        name: "getProjectInfoHubFn",
        filename: "src/server/functions/info-hub.ts",
      },
    ]);
  });

  it("parses the single-line layout with several entries", () => {
    const other = "a".repeat(64);
    const source =
      `createServerRpc({ id: "${INFO_HUB_ID}", name: "getProjectInfoHubFn", filename: "src/server/functions/info-hub.ts" }, o => o);` +
      `createServerRpc({ id: "${other}", name: "refreshInfoHubFn", filename: "src/server/functions/info-hub.ts" }, o => o);`;
    expect(parseServerFnMetas(source).map((meta) => meta.name)).toEqual([
      "getProjectInfoHubFn",
      "refreshInfoHubFn",
    ]);
  });

  it("ignores text that only looks like a meta", () => {
    const source = [
      `// createServerRpc({ name: "commented" })`,
      `var hash = "${INFO_HUB_ID}";`,
      `createServerRpc({ name: "getProjectInfoHubFn", filename: "src/server/functions/info-hub.ts" })`,
      `createServerRpc({ id: "${INFO_HUB_ID.toUpperCase()}", name: "upper", filename: "f.ts" })`,
    ].join("\n");
    expect(parseServerFnMetas(source)).toEqual([]);
  });

  it("returns an empty memoized map when no build output is next to the source", () => {
    const names = loadServerFnNames();
    expect(names).toBeInstanceOf(Map);
    expect(names.size).toBe(0);
    expect(loadServerFnNames()).toBe(names);
  });
});

describe("server function ids", () => {
  it("extracts the hash from a server function path", () => {
    expect(serverFunctionId(`/_serverFn/${INFO_HUB_ID}`)).toBe(INFO_HUB_ID);
  });

  it.each([
    ["/api/health", "/api/health"],
    [`/_serverFn/${INFO_HUB_ID}/extra`, "trailing segment"],
    [`/_serverFn/${INFO_HUB_ID.slice(0, 63)}`, "short hash"],
    [`/_serverFn/${INFO_HUB_ID.toUpperCase()}`, "uppercase hash"],
    ["/_serverFn/", "empty hash"],
  ])("returns null for %#", (pathname) => {
    expect(serverFunctionId(pathname)).toBeNull();
  });
});

describe("request log emit", () => {
  it("writes one tagged line by default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logRequest({ ...record, fn: "getProjectInfoHubFn", bytes: 12 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "[request]",
      JSON.stringify({ ...record, fn: "getProjectInfoHubFn", bytes: 12 }),
    );
  });

  it.each(["off", "OFF", "0", "false", "False"])(
    "stays silent when SPROUT_REQUEST_LOG=%s",
    (value) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      process.env.SPROUT_REQUEST_LOG = value;
      logRequest(record);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("keeps logging for other values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.SPROUT_REQUEST_LOG = "on";
    logRequest(record);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("request log report", () => {
  const report = [
    line({ fn: "getProjectInfoHubFn", fnId: INFO_HUB_ID, bytes: 100, ms: 2 }),
    line({ fn: "getProjectInfoHubFn", fnId: INFO_HUB_ID, bytes: 100, ms: 1 }),
    line({ fn: "getProjectInfoHubFn", fnId: INFO_HUB_ID, bytes: 100, ms: 4 }),
    line({ fn: "getProjectInfoHubFn", fnId: INFO_HUB_ID, bytes: 100, ms: 3 }),
    line({
      fn: null,
      fnId: "b".repeat(64),
      path: `/_serverFn/${"b".repeat(64)}`,
      bytes: 50,
      ms: 10,
      status: 500,
    }),
    line({ fn: null, fnId: null, path: "/api/health", bytes: null, ms: 0.4, complete: false }),
  ].join("\n");

  it("groups by fn, then fnId, then path and ranks percentiles with nearest-rank", () => {
    const summary = summarize(report);
    expect(summary.rows).toEqual([
      {
        key: "getProjectInfoHubFn",
        count: 4,
        bytes: 400,
        p50: 2,
        p95: 4,
        max: 4,
        serverErrors: 0,
        incomplete: 0,
      },
      {
        key: "b".repeat(64),
        count: 1,
        bytes: 50,
        p50: 10,
        p95: 10,
        max: 10,
        serverErrors: 1,
        incomplete: 0,
      },
      {
        key: "/api/health",
        count: 1,
        bytes: 0,
        p50: 0.4,
        p95: 0.4,
        max: 0.4,
        serverErrors: 0,
        incomplete: 1,
      },
    ]);
    expect(summary.total).toEqual({
      count: 6,
      bytes: 450,
      p50: 2,
      p95: 10,
      max: 10,
      serverErrors: 1,
      incomplete: 1,
    });
  });

  it("skips lines that are not request records", () => {
    const noisy = [
      "[runtime] boot",
      "[request] {not json",
      "[request] null",
      "[request] []",
      "",
      report,
    ].join("\n");
    expect(summarize(noisy)).toEqual(summarize(report));
    expect(summarize("").rows).toEqual([]);
    expect(summarize("").total.count).toBe(0);
  });
});
