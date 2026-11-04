import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ContinuationCard } from "../src/components/continuation/continuation-card";
import { ContinuationPanel } from "../src/components/continuation/continuation-panel";
import { WakeProviderSelect } from "../src/components/continuation/wake-provider-select";
import { TaskBadge } from "../src/components/tasks/task-badge";
import { continuationFixture, continuationDenials, p6aIds } from "./fixtures/p6a-pages";

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
    expect(html).toContain("开启对话接续");
    expect(html).not.toContain("暂停 Task");
  });
  it("侧栏控制模式不重复最近检查与下次检查", () => {
    const html = renderToStaticMarkup(
      createElement(ContinuationCard, {
        view: continuationFixture("failure"),
        showStatus: false,
      }),
    );
    expect(html).toContain("暂停对话接续");
    expect(html).toContain("检查细节与诊断");
    expect(html).not.toContain('data-testid="continuation-last-check"');
    expect(html).not.toContain('data-testid="continuation-next-check"');
    expect(html).not.toContain('data-testid="continuation-failure"');
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
