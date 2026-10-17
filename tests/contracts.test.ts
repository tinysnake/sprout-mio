import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  APP_ERROR_CODES,
  ID_PREFIXES,
  createProjectInput,
  fail,
  newId,
  ok,
  projectSchema,
  toAppError,
} from "../src/contracts";
import { parseConfig } from "../src/lib/config";

describe("共享契约", () => {
  it("生成可追踪类别且互不重复的 UUID", () => {
    const ids = Object.values(ID_PREFIXES).flatMap((prefix) =>
      Array.from({ length: 20 }, () => {
        const id = newId(prefix);
        expect(id).toMatch(
          new RegExp(
            `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
          ),
        );
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
    for (const code of APP_ERROR_CODES.filter((code) => code !== "internal")) {
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
      DATABASE_URL: "./data/sprout.sqlite",
      APP_ORIGIN: "http://localhost:3000",
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
        BETTER_AUTH_SECRET: "a".repeat(32),
      }).PORT,
    ).toBe(3123);
    for (const [field, value] of [
      ["PORT", "0"],
      ["PORT", "not-a-port"],
      ["APP_ORIGIN", "not-origin"],
      ["APP_ORIGIN", "http://"],
      ["APP_ORIGIN", "file:///private"],
      ["APP_ORIGIN", "https://sprout.example/path"],
      ["BETTER_AUTH_SECRET", "short-secret"],
      ["LOG_LEVEL", "verbose"],
      ["DATABASE_URL", ""],
    ]) {
      expect(() => parseConfig({ [field]: value })).toThrow(field);
    }
    expect(() => parseConfig({ BETTER_AUTH_SECRET: "short-secret" })).not.toThrow("short-secret");
  });
});
