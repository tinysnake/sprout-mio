import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APP_ERROR_CODES,
  appIdPattern,
  ID_PREFIXES,
  createProjectInput,
  fail,
  newId,
  ok,
  projectSchema,
  toAppError,
} from "../src/contracts";
import { parseConfig } from "../src/lib/config";
import { isTrustedOrigin, originMatchesPattern } from "../src/lib/origin";

describe("共享契约", () => {
  it("生成可追踪类别且互不重复的 UUID", () => {
    const ids = Object.values(ID_PREFIXES).flatMap((prefix) =>
      Array.from({ length: 20 }, () => {
        const id = newId(prefix);
        expect(id).toMatch(appIdPattern(prefix));
        return id;
      }),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("成功与失败载荷保留同一个 requestId", () => {
    const requestId = newId(ID_PREFIXES.request);
    expect(ok({ name: "Sprout" }, requestId)).toEqual({
      ok: true,
      data: { name: "Sprout" },
      requestId,
    });
    const error = toAppError({ code: "not_found", message: "未找到" }, requestId);
    expect(fail(error)).toEqual({ ok: false, error, requestId });
  });

  it("Zod 校验失败映射为安全的 validation_failed", () => {
    const parsed = z.string().min(1).safeParse("");
    if (parsed.success) throw new Error("校验必须失败");
    expect(toAppError(parsed.error, "req_current")).toEqual({
      code: "validation_failed",
      message: "输入校验失败",
      requestId: "req_current",
    });
  });

  it("保留已知业务错误，使用当前 requestId，隐藏未知错误内容", () => {
    for (const code of APP_ERROR_CODES.filter(
      (code) => code !== "internal" && code !== "project_member_removal_blocked",
    )) {
      expect(
        toAppError(
          { code, message: "业务提示", requestId: "req_old", secret: "private" },
          "req_current",
        ),
      ).toEqual({ code, message: "业务提示", requestId: "req_current" });
    }
    for (const error of [
      new Error("secret password"),
      { code: "internal", message: "secret path" },
      { code: "unknown", message: "secret" },
      null,
    ]) {
      expect(toAppError(error, "req_current")).toEqual({
        code: "internal",
        message: "内部错误",
        requestId: "req_current",
      });
    }
  });

  it("阻塞类业务错误必须带 details，缺 details 时降级为内部错误", () => {
    const details = {
      projectId: "prj_11111111-1111-4111-8111-111111111111",
      agentProfileId: "agp_22222222-2222-4222-8222-222222222222",
      blockers: [
        {
          kind: "active_runs" as const,
          items: [
            {
              runId: "run_33333333-3333-4333-8333-333333333333",
              instanceId: "ins_44444444-4444-4444-8444-444444444444",
              status: "running" as const,
              chat: {
                chatId: "cnv_55555555-5555-4555-8555-555555555555",
                chatKind: "group" as const,
                title: "平台组",
              },
            },
          ],
        },
      ],
    };
    expect(
      toAppError(
        {
          code: "project_member_removal_blocked",
          message: "有阻塞",
          requestId: "req_old",
          details,
        },
        "req_current",
      ),
    ).toEqual({
      code: "project_member_removal_blocked",
      message: "有阻塞",
      requestId: "req_current",
      details,
    });
    // 缺 details 的同类载荷不能被当成同一种错误透传，否则消费方会读到 undefined 的阻塞列表。
    expect(
      toAppError({ code: "project_member_removal_blocked", message: "有阻塞" }, "req_current"),
    ).toEqual({ code: "internal", message: "内部错误", requestId: "req_current" });
  });

  it("拒绝空白与超长输入，接受限制内文本并修剪名称", () => {
    for (const input of [
      { name: "" },
      { name: "   " },
      { name: "a".repeat(81) },
      { name: "valid", description: "a".repeat(501) },
    ]) {
      expect(createProjectInput.safeParse(input).success).toBe(false);
    }
    expect(createProjectInput.parse({ name: " Sprout " })).toEqual({ name: "Sprout" });
    expect(
      createProjectInput.safeParse({ name: "a".repeat(80), description: "a".repeat(500) }).success,
    ).toBe(true);
    const project = {
      id: newId(ID_PREFIXES.project),
      name: "Sprout",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(projectSchema.parse(project)).toEqual(project);
    expect(projectSchema.safeParse({ ...project, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("配置边界", () => {
  it("缺省环境返回冻结的独立配置且不要求数据库或认证连接", () => {
    const config = parseConfig({});
    expect(config).toEqual({
      SPROUT_PI_ENABLED: true,
      SPROUT_PI_DATA_DIR: join(homedir(), ".local", "share", "sprout-mio", "pi"),
      SPROUT_REPO_DIR: join(homedir(), ".local", "share", "sprout-mio", "repos"),
      SPROUT_REPO_MAX_BYTES: 2 * 1024 * 1024 * 1024,
      DATABASE_URL: "./data/sprout.sqlite",
      APP_ORIGIN: "http://localhost:3000",
      APP_TRUSTED_ORIGINS: [],
      DEV_LOGIN_ENABLED: true,
      DEV_LOGIN_EMAIL: "dev@sprout.test",
      DEV_LOGIN_NAME: "开发评审",
      DEV_LOGIN_PASSWORD: "sprout-dev-login",
      AUTH_RATE_LIMIT_MAX: 5,
      AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
      AUTH_RATE_LIMIT_GLOBAL_MAX: 100,
      AUTH_RATE_LIMIT_HTTP_MAX: 100,
      PORT: 3000,
      NODE_ENV: "development",
      LOG_LEVEL: "info",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("解析环境覆盖值，错误只报告字段和校验约束", () => {
    expect(
      parseConfig({
        PORT: "3123",
        APP_ORIGIN: "https://sprout.example",
        NODE_ENV: "production",
        LOG_LEVEL: "error",
        AUTH_RATE_LIMIT_MAX: "2",
        AUTH_RATE_LIMIT_WINDOW_SECONDS: "10",
        AUTH_RATE_LIMIT_GLOBAL_MAX: "20",
        AUTH_RATE_LIMIT_HTTP_MAX: "30",
        BETTER_AUTH_SECRET: "a".repeat(32),
      }),
    ).toMatchObject({
      PORT: 3123,
      AUTH_RATE_LIMIT_MAX: 2,
      AUTH_RATE_LIMIT_WINDOW_SECONDS: 10,
      AUTH_RATE_LIMIT_GLOBAL_MAX: 20,
      AUTH_RATE_LIMIT_HTTP_MAX: 30,
    });
    for (const [field, value] of [
      ["AUTH_RATE_LIMIT_MAX", "0"],
      ["AUTH_RATE_LIMIT_MAX", "1001"],
      ["AUTH_RATE_LIMIT_WINDOW_SECONDS", "0.5"],
      ["AUTH_RATE_LIMIT_WINDOW_SECONDS", "3601"],
      ["AUTH_RATE_LIMIT_GLOBAL_MAX", "NaN"],
      ["AUTH_RATE_LIMIT_GLOBAL_MAX", "10001"],
      ["AUTH_RATE_LIMIT_HTTP_MAX", "0"],
      ["AUTH_RATE_LIMIT_HTTP_MAX", "10001"],
      ["AUTH_RATE_LIMIT_HTTP_MAX", "1.5"],
      ["AUTH_RATE_LIMIT_HTTP_MAX", "NaN"],
      ["PORT", "0"],
      ["PORT", "not-a-port"],
      ["APP_ORIGIN", "not-origin"],
      ["APP_ORIGIN", "http://"],
      ["APP_ORIGIN", "file:///private"],
      ["APP_ORIGIN", "https://sprout.example/path"],
      ["BETTER_AUTH_SECRET", "short-secret"],
      ["DEV_LOGIN_ENABLED", "yes"],
      ["DEV_LOGIN_EMAIL", "not-an-email"],
      ["DEV_LOGIN_NAME", "   "],
      ["DEV_LOGIN_PASSWORD", "short"],
      ["LOG_LEVEL", "verbose"],
      ["DATABASE_URL", ""],
    ]) {
      expect(() => parseConfig({ [field]: value })).toThrow(field);
    }
    expect(() => parseConfig({ BETTER_AUTH_SECRET: "short-secret" })).not.toThrow("short-secret");
  });

  it("额外可信 origin 只接受回环与内网模式，通配不跨层次也不落到公网", () => {
    const config = parseConfig({
      APP_ORIGIN: "http://192.168.1.10:3210",
      APP_TRUSTED_ORIGINS: "http://192.168.50.*:3210, http://*.local:3210 ,http://localhost:3000",
    });
    expect(config.APP_TRUSTED_ORIGINS).toEqual([
      "http://192.168.50.*:3210",
      "http://*.local:3210",
      "http://localhost:3000",
    ]);
    for (const value of [
      "*",
      "*:3210",
      "http://*:3210",
      "http://*.example.com:3210",
      "http://192.168.1.10:3210/login",
      "http://192.168.1.10:3210/",
      "ftp://192.168.1.10:3210",
      "http://192.168.1.10:0",
      "http://192.168.1.10:99999",
      "http://user:pw@192.168.1.10:3210",
    ])
      expect(() => parseConfig({ APP_TRUSTED_ORIGINS: value })).toThrow("APP_TRUSTED_ORIGINS");
  });

  it("可信来源判定按整串匹配，主 origin 始终可信，缺失或无来源不放行", () => {
    const patterns = ["http://192.168.50.*:3210"];
    expect(originMatchesPattern("http://192.168.50.*:3210", "http://192.168.50.4:3210")).toBe(true);
    expect(originMatchesPattern("http://192.168.50.*:3210", "http://192.168.50.4:9999")).toBe(
      false,
    );
    expect(originMatchesPattern("http://192.168.50.*:3210", "http://192.168.51.4:3210")).toBe(
      false,
    );
    expect(originMatchesPattern("http://192.168.50.*:3210", "http://evil.example:3210")).toBe(
      false,
    );
    expect(isTrustedOrigin("http://192.168.1.10:3210", "http://192.168.1.10:3210", patterns)).toBe(
      true,
    );
    expect(isTrustedOrigin("http://192.168.50.7:3210", "http://192.168.1.10:3210", patterns)).toBe(
      true,
    );
    expect(isTrustedOrigin("http://evil.example:3210", "http://192.168.1.10:3210", patterns)).toBe(
      false,
    );
    expect(isTrustedOrigin(null, "http://192.168.1.10:3210", patterns)).toBe(false);
    expect(isTrustedOrigin("", "http://192.168.1.10:3210", patterns)).toBe(false);
  });
});
