import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { APP_ERROR_CODES, toAppError } from "../src/contracts";
import { APP_VERSION, CONTRACT_VERSION } from "../src/contracts/version";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("工具链接口门禁", () => {
  it("应用版本与 package.json 一致，Worker 与 extension 的 --version 输出不会漂移", () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("契约版本是正整数，消费者可据此识别载荷版本", () => {
    expect(Number.isInteger(CONTRACT_VERSION)).toBe(true);
    expect(CONTRACT_VERSION).toBeGreaterThan(0);
  });

  it("错误码映射保持封闭，未知码与旧 requestId 都不会透传", () => {
    for (const code of APP_ERROR_CODES) {
      expect(toAppError({ code, message: "诊断提示", requestId: "req_stale" }, "req_now")).toEqual({
        code,
        message: code === "internal" ? "内部错误" : "诊断提示",
        requestId: "req_now",
      });
    }
    expect(toAppError("not_a_registered_code", "req_now")).toEqual({
      code: "internal",
      message: "内部错误",
      requestId: "req_now",
    });
  });
});
