import { expect, it } from "vite-plus/test";
import {
  challengeRemainingLabel,
  connectionPhaseLabel,
  feishuFailureText,
  targetLabel,
  targetOptionLabel,
} from "../src/components/project/feishu-binding-copy";
import type { AppError } from "../src/contracts/result";

it("labels every connection phase in Chinese", () => {
  expect(connectionPhaseLabel("connected")).toBe("已连接");
  expect(connectionPhaseLabel("reconnecting")).toBe("重连中");
  expect(connectionPhaseLabel("failed")).toBe("失败");
  expect(connectionPhaseLabel("disabled")).toBe("未启用");
  expect(connectionPhaseLabel("stopped")).toBe("未启用");
  expect(connectionPhaseLabel("starting")).toBe("连接中");
});

it("describes DM targets with their assistant name when the chat has no title", () => {
  expect(targetLabel({ chatTitle: null, agentName: "Helper" })).toBe("Helper 的助理私聊");
  expect(targetLabel({ chatTitle: "项目助理", agentName: "Helper" })).toBe("项目助理");
  expect(targetLabel({ chatTitle: null, agentName: null })).toBe("未命名助理私聊");
  expect(targetOptionLabel({ chatTitle: null, agentName: "Helper" })).toBe("Helper 的助理私聊");
  expect(targetOptionLabel({ chatTitle: "项目助理", agentName: "Helper" })).toBe(
    "Helper · 项目助理",
  );
});

it("counts challenge validity down in minutes and reports expiry", () => {
  const expiresAtMs = 1_000_000 + 10 * 60_000;
  expect(challengeRemainingLabel(expiresAtMs, 1_000_000)).toBe("剩余约 10 分钟");
  expect(challengeRemainingLabel(expiresAtMs, 1_000_000 + 9 * 60_000 + 1)).toBe("剩余约 1 分钟");
  expect(challengeRemainingLabel(expiresAtMs, expiresAtMs)).toBe("确认码已过期");
  expect(challengeRemainingLabel(expiresAtMs, expiresAtMs + 1)).toBe("确认码已过期");
});

it("translates app error codes and keeps the server's binding explanation", () => {
  const error = (
    code: Exclude<AppError["code"], "project_member_removal_blocked">,
    message: string,
  ): AppError => ({ code, message, requestId: "req_copy" });
  expect(feishuFailureText(error("forbidden", "只有 Human 可以绑定 Feishu 私聊"))).toBe(
    "只有 Human 可以绑定飞书私聊。",
  );
  expect(feishuFailureText(error("not_found", "对象不存在"))).toBe(
    "Project 不存在，或当前账号无权访问。",
  );
  expect(feishuFailureText(error("conflict", "这个账号已绑定 Feishu 私聊，请先解绑或换绑"))).toBe(
    "这个账号已绑定 Feishu 私聊，请先解绑或换绑。绑定状态已重新读取，请按最新状态操作。",
  );
  expect(feishuFailureText(error("conflict", "这个 Feishu 身份已绑定到其他账号"))).toContain(
    "这个 Feishu 身份已绑定到其他账号",
  );
});
