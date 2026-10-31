import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { AutomationCard } from "../src/components/automation/automation-card";
import { AutomationPanel } from "../src/components/automation/automation-panel";
import { WakeProviderSelect } from "../src/components/automation/wake-provider-select";
import { TaskBadge } from "../src/components/tasks/task-badge";
import { automationFixture, automationDenials, p6aIds } from "./fixtures/p6a-pages";

const render = (name: Parameters<typeof automationFixture>[0]) =>
  renderToStaticMarkup(
    createElement(AutomationCard, {
      view: automationFixture(name),
      denials: automationDenials(name!),
      onCommand: async () => ({
        ok: true as const,
        data: { view: automationFixture(name), denials: {} },
      }),
    }),
  );

describe("自动接续页面事实与 Human 控制", () => {
  it("暂停后仍显示服务端保留的活动 run，不把调度开关当作 run 状态", () => {
    const view = automationFixture("paused");
    view.activeRunIds = [p6aIds.run];
    const html = renderToStaticMarkup(createElement(AutomationCard, { view }));
    expect(html).toContain("自动接续不会来");
    expect(html).toContain("1 个活动 run");
  });
  it("assigned、活动 run 与下次检查分别展示；enabled 仍可没有下一次", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(TaskBadge, { status: "assigned" }),
        createElement(AutomationCard, { view: automationFixture("idle") }),
      ),
    );
    expect(html).toContain("已分配");
    expect(html).toContain("1 个 assigned Task");
    expect(html).toContain("当前无活动 run");
    expect(html).toContain("自动接续已启用");
    expect(html).toContain("当前没有安排下次自动检查");
    expect(html).not.toContain("已安排下次自动检查");
  });
  it("暂停与停止明确说明不会来，但不宣称当前 run 被停止", () => {
    for (const name of ["paused", "stopped"] as const) {
      const html = render(name);
      expect(html).toContain("自动接续不会来");
      expect(html).toContain("不会停止当前 run");
      expect(html).toContain("恢复自动接续");
      expect(html).not.toContain("暂停 Task");
    }
  });
  it("失败与退避可见，不能呈现为正常或本轮无需接续", () => {
    const html = render("failure");
    expect(html).toContain("检查失败");
    expect(html).toContain("provider_timeout");
    expect(html).toContain("失败退避");
    expect(html).toContain("暂无结论");
    expect(html).not.toContain("本轮无需接续：");
  });
  it("Human owner 仅有提醒事实，没有 run 活动条", () => {
    const html = render("human");
    expect(html).toContain("已展示接续提醒");
    expect(html).not.toContain('data-testid="automation-run-facts"');
    expect(html).not.toContain('data-testid="automation-run-control"');
    expect(html).not.toContain("当前无活动 run");
  });
  it("禁用操作逐字展示 denials.reason 与 code", () => {
    const html = render("denied");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>暂停自动接续/);
    expect(html).toContain("当前身份无权暂停此 Chat");
    expect(html).toContain("forbidden");
  });
  it("投递未知保留原 run 并要求人工确认补发", () => {
    const html = render("unknown");
    expect(html).toContain("投递未知");
    expect(html).toContain("不会自动重投");
    expect(html).toContain("run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(html).toContain("人工补发…");
    expect(html).not.toContain("确认补发</button>");
  });
  it("缺少完整读取时显示未知，不冒充 enabled 或空调度", () => {
    const html = renderToStaticMarkup(createElement(AutomationPanel));
    expect(html).toContain("当前状态未知");
    expect(html).not.toContain("自动接续已启用");
  });
  it("判定器未知和不可用原因可见，不给不可用选择一个可点击的保存入口", () => {
    const html = renderToStaticMarkup(createElement(WakeProviderSelect));
    expect(html).toContain("当前判定器配置未知");
    expect(html).toContain("Small Brain 不可用");
    expect(html).toContain("JEV 不可用");
    expect(html).toContain("wake_provider_unavailable");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存判定器/);
  });
});
