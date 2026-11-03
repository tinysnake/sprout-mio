import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "change-feed-"));
process.env.DATABASE_URL = join(directory, "feed.sqlite");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { CHANGE_STREAM, chatTopic, projectTopic } = await import("../src/contracts/change-stream");
const {
  changeFeedSnapshot,
  publishChange,
  publishProjectChange,
  resetChangeFeed,
  subscribeChanges,
} = await import("../src/domain/change-feed");

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  resetChangeFeed();
});

function record(topics: readonly string[]) {
  const seen: string[] = [];
  const off = subscribeChanges({ topics, send: (event) => seen.push(event.topic) });
  return { seen, off };
}

describe("变更推送的合窗与订阅", () => {
  it("同一主题在合窗内的多次写入只发一条", () => {
    vi.useFakeTimers();
    const { seen, off } = record([projectTopic("prj_feed0001")]);
    publishChange(projectTopic("prj_feed0001"));
    publishChange(projectTopic("prj_feed0001"));
    publishChange(projectTopic("prj_feed0001"));
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(seen).toEqual([projectTopic("prj_feed0001")]);
    off();
    vi.useRealTimers();
  });

  it("订阅之外的主题收不到", () => {
    vi.useFakeTimers();
    const { seen, off } = record([projectTopic("prj_feed0002")]);
    publishProjectChange("prj_feed0003", "cht_feed0003");
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(seen).toEqual([]);
    off();
    vi.useRealTimers();
  });

  it("一次 Project 写入同时送到 Project 与 Chat 两个主题", () => {
    vi.useFakeTimers();
    const { seen, off } = record([projectTopic("prj_feed0004"), chatTopic("cht_feed0004")]);
    publishProjectChange("prj_feed0004", "cht_feed0004");
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(seen.sort()).toEqual([chatTopic("cht_feed0004"), projectTopic("prj_feed0004")]);
    off();
    vi.useRealTimers();
  });

  it("退订之后不再收到，也不再占用订阅者名额", () => {
    vi.useFakeTimers();
    const { seen, off } = record([projectTopic("prj_feed0005")]);
    expect(changeFeedSnapshot().subscribers).toBe(1);
    off();
    expect(changeFeedSnapshot().subscribers).toBe(0);
    publishChange(projectTopic("prj_feed0005"));
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(seen).toEqual([]);
    vi.useRealTimers();
  });

  it("推送失败只摘掉坏订阅者，不影响其他连接", () => {
    vi.useFakeTimers();
    const broken = subscribeChanges({
      topics: [projectTopic("prj_feed0006")],
      send: () => {
        throw new Error("stream closed");
      },
    });
    const good = record([projectTopic("prj_feed0006")]);
    publishChange(projectTopic("prj_feed0006"));
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(good.seen).toEqual([projectTopic("prj_feed0006")]);
    expect(changeFeedSnapshot().subscribers).toBe(1);
    broken();
    good.off();
    vi.useRealTimers();
  });

  it("还在合窗里就退订，那一条连同定时器一起取消", () => {
    vi.useFakeTimers();
    const { seen, off } = record([projectTopic("prj_feed0007")]);
    publishChange(projectTopic("prj_feed0007"));
    expect(vi.getTimerCount()).toBe(1);
    off();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(seen).toEqual([]);
    vi.useRealTimers();
  });

  it("另一个模块实例的发布也送到已注册的订阅者", async () => {
    vi.useFakeTimers();
    const { seen, off } = record([projectTopic("prj_feed0009")]);
    vi.resetModules();
    const second = await import("../src/domain/change-feed");
    second.publishChange(projectTopic("prj_feed0009"));
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(seen).toEqual([projectTopic("prj_feed0009")]);
    off();
    vi.useRealTimers();
  });

  it("没有订阅者时不排定时器，别人仍订阅的主题照常发出", () => {
    vi.useFakeTimers();
    publishChange(projectTopic("prj_feed0008"));
    expect(vi.getTimerCount()).toBe(0);
    const kept = record([projectTopic("prj_feed0008")]);
    const left = record([projectTopic("prj_feed0008")]);
    publishChange(projectTopic("prj_feed0008"));
    left.off();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(CHANGE_STREAM.coalesceMs + 1);
    expect(kept.seen).toEqual([projectTopic("prj_feed0008")]);
    kept.off();
    vi.useRealTimers();
  });
});
