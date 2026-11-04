import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ContinuationCard } from "../src/components/continuation/continuation-card";
import { ContinuationPanel } from "../src/components/continuation/continuation-panel";
import { WakeDiagnostic } from "../src/components/continuation/wake-diagnostic";
import { ContinuationDiagnostic } from "../src/components/continuation/continuation-diagnostic";
import { WakeProviderSelect } from "../src/components/continuation/wake-provider-select";
import { TaskBadge } from "../src/components/tasks/task-badge";
import {
  continuationFixture,
  continuationDenials,
  diagnosticFixture,
  p6aIds,
} from "./fixtures/p6a-pages";

const render = (name: Parameters<typeof continuationFixture>[0]) =>
  renderToStaticMarkup(
    createElement(ContinuationCard, {
      view: continuationFixture(name),
      denials: continuationDenials(name!),
      onCommand: async () => ({
        ok: true as const,
        data: { view: continuationFixture(name), denials: {} },
      }),
    }),
  );

describe("对话接续页面事实与 Human 控制", () => {
  it("关闭对话接续后仍显示服务端保留的活动 run，不把调度开关当作 run 状态", () => {
    const view = { ...continuationFixture("idle"), mode: "off" as const };
    view.activeRunIds = [p6aIds.run];
    const html = renderToStaticMarkup(createElement(ContinuationCard, { view }));
    expect(html).toContain("对话接续不会来");
    expect(html).toContain("1 个活动 run");
  });
  it("assigned、活动 run 与下次检查分别展示；enabled 仍可没有下一次", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(TaskBadge, { status: "assigned" }),
        createElement(ContinuationCard, { view: continuationFixture("idle") }),
      ),
    );
    expect(html).toContain("已分配");
    expect(html).toContain("1 个 assigned Task");
    expect(html).toContain("当前无活动 run");
    expect(html).toContain("对话接续已启用");
    expect(html).toContain("当前没有安排下次自动检查");
    expect(html).not.toContain("已安排下次自动检查");
  });
  it("关闭开关明确说明不会来，但不宣称当前 run 被停止", () => {
    const view = { ...continuationFixture("idle"), mode: "off" as const };
    const html = renderToStaticMarkup(createElement(ContinuationCard, { view }));
    expect(html).toContain("对话接续不会来");
    expect(html).toContain("不会停止当前 run");
    expect(html).toContain("重新启用");
    expect(html).not.toContain("暂停 Task");
  });
  it("Hub 两行不可展开，均定位最新真实轮次，不承载诊断或控制", () => {
    const view = diagnosticFixture("failure");
    const html = renderToStaticMarkup(
      createElement(ContinuationPanel, { data: { view, denials: {} } }),
    );
    expect(html).toContain("对话自动化");
    expect(html).toContain("摘要与详情");
    for (const kind of ["wake", "continuation"])
      expect(html).toContain(`/checks/${view.latestEvaluation!.evaluationId}/${kind}`);
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("暂停对话接续");
    expect(html).not.toContain('data-testid="continuation-failure"');
  });
  it("没有判定时两行禁用，不能编造 evaluationId", () => {
    const html = renderToStaticMarkup(
      createElement(ContinuationPanel, { data: { view: continuationFixture(), denials: {} } }),
    );
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).not.toContain("href=");
    expect(html).toContain("尚无判定");
  });
  it("失败与退避可见，不能呈现为正常或本轮无需接续", () => {
    const view = diagnosticFixture("failure");
    const html = renderToStaticMarkup(
      createElement(WakeDiagnostic, {
        view,
        round: view.recentRounds[0],
        onCommand: async () => ({ ok: true as const, data: { view, denials: {} } }),
      }),
    );
    expect(html).toContain("检查失败");
    expect(html).toContain("provider_timeout");
    expect(html).toContain("失败退避");
    expect(html).toContain("重试检查");
    expect(html).not.toContain("查看最近五轮");
    expect(html).toContain("本轮尚未产出逐接收者结论");
    expect(html).not.toContain("本轮无需接续：");
  });
  it("正在检查的等待时长来自注入时钟，不伪造完成耗时", () => {
    const view = diagnosticFixture("idle");
    const startedAt = "2026-01-02T03:04:05.000Z";
    view.latestEvaluation = {
      ...view.latestEvaluation!,
      state: "claimed",
      claimedAt: startedAt,
      finishedAt: null,
      evaluatedAt: null,
      result: null,
    };
    const round = {
      ...view.recentRounds[0],
      state: "claimed" as const,
      evaluatedAt: null,
      result: null,
    };
    const html = renderToStaticMarkup(
      createElement(WakeDiagnostic, { view, round, clock: () => Date.parse(startedAt) + 2300 }),
    );
    expect(html).toContain("已等待 2.3 秒");
    expect(html).toContain("尚未结束");
    expect(html).not.toContain("耗时 2.3 秒");
  });
  it.each(["wake", "continuation"] as const)("%s URL 的正文与标题对应，且没有页签", (kind) => {
    const view = diagnosticFixture("failure");
    const html = renderToStaticMarkup(
      createElement(ContinuationDiagnostic, {
        data: { view, denials: {} },
        evaluationId: view.latestEvaluation!.evaluationId,
        kind,
        chatTitle: "当前对话",
      }),
    );
    expect(html).toContain(`data-kind="${kind}"`);
    expect(html).toContain("检查轮次 #2");
    expect(html).toContain("周期检查");
    expect(html).toContain(kind === "wake" ? "逐接收者结论" : "人类控制");
    expect(html).not.toContain(kind === "wake" ? "全部停止" : "逐接收者结论");
    expect(html).not.toContain('role="tab');
    expect(html).not.toContain("查看最近五轮");
  });
  it("无法定位 evaluationId 时给明确恢复路径，不展示错误轮次", () => {
    const html = renderToStaticMarkup(
      createElement(ContinuationDiagnostic, {
        data: { view: diagnosticFixture(), denials: {} },
        evaluationId: "expired-evaluation",
        kind: "wake",
        chatTitle: "当前对话",
      }),
    );
    expect(html).toContain("这一轮不在最近 5 轮里");
    expect(html).toContain("返回对话");
    expect(html).not.toContain("逐接收者结论");
  });
  it("Human owner 仅有提醒事实，没有 run 活动条", () => {
    const html = render("human");
    expect(html).toContain("已展示接续提醒");
    expect(html).not.toContain('data-testid="continuation-run-facts"');
    expect(html).not.toContain('data-testid="continuation-run-control"');
    expect(html).not.toContain("当前无活动 run");
  });
  it("不可用操作不渲染，也不打印原因", () => {
    const html = renderToStaticMarkup(
      createElement(ContinuationCard, {
        view: continuationFixture("idle"),
        denials: { disable: { code: "forbidden", reason: "当前身份无权关闭此 Chat 的对话接续" } },
      }),
    );
    expect(html).not.toContain("暂停对话接续");
    expect(html).not.toContain("当前身份无权关闭此 Chat 的对话接续");
    expect(html).not.toContain("forbidden");
  });
  it("投递未知保留原 run 并要求人工确认补发", () => {
    const html = render("unknown");
    expect(html).toContain("投递未知");
    expect(html).toContain("不会自动重投");
    expect(html).toContain("run_aaaaaaaa");
    expect(html).toContain("人工补发…");
    expect(html).not.toContain("确认补发</button>");
  });
  it("缺少完整读取时显示未知，不冒充 enabled 或空调度", () => {
    const html = renderToStaticMarkup(createElement(ContinuationPanel));
    expect(html).toContain("当前状态未知");
    expect(html).not.toContain("对话接续已启用");
  });
  it("判定器未接线时只说明现状，不摆不可点击的控件也不写错误码", () => {
    const html = renderToStaticMarkup(createElement(WakeProviderSelect));
    expect(html).toContain("当前使用部署默认判定器");
    expect(html).toContain("这台部署没有提供判定器配置");
    expect(html).not.toContain("保存判定器");
    expect(html).not.toContain("wake_provider_unavailable");
  });
  it("所有判定器都不可用时逐条说明原因，同样不给保存入口", () => {
    const html = renderToStaticMarkup(
      createElement(WakeProviderSelect, {
        options: [
          {
            provider: "llm",
            configured: false,
            available: false,
            unavailableReason: "missing_model",
          },
          {
            provider: "jev",
            configured: true,
            available: false,
            unavailableReason: "missing_credentials",
          },
        ],
      }),
    );
    expect(html).toContain("这台部署没有可用的判定器");
    expect(html).toContain("LLM：这台部署没有配置模型与阈值版本");
    expect(html).toContain("JEV：这台部署没有配置凭据");
    expect(html).not.toContain("保存判定器");
  });
});
