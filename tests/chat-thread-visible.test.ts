import { describe, expect, it } from "vite-plus/test";
import { lastVisibleMessageId } from "../src/components/chat/chat-thread";

const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;

/** 只需要可见框与子节点，用普通对象假装 HTMLElement，避免测试依赖真实 DOM。 */
const container = (top: number, bottom: number, items: ReadonlyArray<readonly [string, number, number]>) =>
  ({
    getBoundingClientRect: () => rect(top, bottom),
    querySelectorAll: () =>
      items.map(([messageId, itemTop, itemBottom]) => ({
        dataset: { messageId },
        getBoundingClientRect: () => rect(itemTop, itemBottom),
      })),
  }) as unknown as HTMLElement;

describe("已读游标识别的最后可见消息", () => {
  it("滚到底时最后一条可见", () => {
    expect(
      lastVisibleMessageId(
        container(0, 100, [
          ["m1", 0, 40],
          ["m2", 40, 80],
          ["m3", 80, 120],
        ]),
      ),
    ).toBe("m3");
  });

  it("滚在中间时只到视口底边那条，不认下方没露出的消息", () => {
    expect(
      lastVisibleMessageId(
        container(100, 200, [
          ["m1", 40, 90],
          ["m2", 90, 140],
          ["m3", 140, 190],
          ["m4", 210, 260],
        ]),
      ),
    ).toBe("m3");
  });

  it("视口里一条消息都没有时返回 null", () => {
    expect(
      lastVisibleMessageId(
        container(300, 400, [
          ["m1", 0, 50],
          ["m2", 50, 100],
        ]),
      ),
    ).toBeNull();
  });

  it("刚好贴着视口边缘不算可见", () => {
    expect(
      lastVisibleMessageId(
        container(100, 200, [
          ["m1", 40, 100],
          ["m2", 200, 240],
        ]),
      ),
    ).toBeNull();
  });
});
