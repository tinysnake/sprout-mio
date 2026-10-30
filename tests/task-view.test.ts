import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskBadge } from "../src/components/tasks/task-badge";
import { TaskDetailView, TaskActionControl } from "../src/components/tasks/task-detail";
import { TaskBoard } from "../src/components/tasks/task-board";
import { taskPageDetail } from "./fixtures/task-pages";

const renderDetail = (detail: ReturnType<typeof taskPageDetail>) =>
  renderToStaticMarkup(createElement(TaskDetailView, { detail, onCommand: async () => {} }));

describe("Task 页面口径", () => {
  it("在 chip 层区分重开与尚无记录的分配", () => {
    expect(
      renderToStaticMarkup(createElement(TaskBadge, { status: "assigned", reopened: true })),
    ).toContain("已分配 · 重开");
    expect(renderToStaticMarkup(createElement(TaskBadge, { status: "assigned" }))).not.toContain(
      "重开",
    );
  });
  it("重开常驻条将旧结果标为历史且不呈现当前完成结果", () => {
    const html = renderDetail(taskPageDetail());
    expect(html).toContain("当前没有完成结果。历史结果 #1 保留");
    expect(html).toContain('href="#task-record-1"');
    expect(html).not.toContain(">当前完成结果<");
  });
  it("完成详情只展示服务端完成记录并允许未勾选清单", () => {
    const detail = taskPageDetail();
    detail.task.status = "finished";
    detail.completionRecord = detail.lastRecord;
    const html = renderDetail(detail);
    expect(html).toContain("当前完成结果 · 记录 #1 · 查看结果");
    expect(html).toContain("已核对实现与验证证据。");
    expect(html).not.toContain("结果正文");
  });
  it("禁用动作逐字呈现服务端 reason 与 code，不推断 owner", () => {
    const detail = taskPageDetail({
      capabilities: {
        allowedActions: [],
        denials: { complete: { code: "forbidden", reason: "当前 Agent 不是推进负责人" } },
      },
    });
    const html = renderToStaticMarkup(
      createElement(TaskActionControl, {
        detail,
        action: "complete",
        label: "完成 Task",
        pending: false,
        onClick: () => {},
      }),
    );
    expect(html).toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/);
    expect(html).toContain("当前 Agent 不是推进负责人");
    expect(html).toContain("forbidden");
    detail.capabilities.allowedActions = ["complete"];
    expect(
      renderToStaticMarkup(
        createElement(TaskActionControl, {
          detail,
          action: "complete",
          label: "完成 Task",
          pending: false,
          onClick: () => {},
        }),
      ),
    ).not.toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/);
  });
  it("无记录卡片只陈述记录缺失，空列保留四态入口", () => {
    const detail = taskPageDetail();
    const html = renderToStaticMarkup(
      createElement(TaskBoard, {
        view: {
          projectId: detail.task.projectId,
          items: [
            {
              id: detail.task.id,
              projectId: detail.task.projectId,
              status: "assigned",
              title: "核对",
              revision: 1,
              checklist: { checked: 0, total: 1 },
              recordCount: 0,
              updatedAt: detail.task.updatedAt,
              allowedActions: [],
            },
          ],
        },
      }),
    );
    expect(html).toContain("尚无施工记录");
    expect(html).not.toMatch(/未开始|已启动|没有工作/);
    expect(html).toContain("暂无已完成 Task");
  });
});
