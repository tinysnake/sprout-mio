import { describe, expect, it } from "vite-plus/test";
import type { Message, MessageWindow } from "../src/contracts/chat";
import {
  appendNew,
  appendNewer,
  evictFar,
  fromWindow,
  hasNewer,
  hasOlder,
  mergeNewest,
  newerCursor,
  olderCursor,
  pageBreaks,
  prependOlder,
  windowMessages,
  type ChatWindowState,
} from "../src/components/chat/message-window";

const T0 = Date.UTC(2026, 0, 2, 3, 0, 0);
const PAGE = 50;

/** 造从 nth 起的一段消息，时间按分钟递增。 */
function chunk(start: number, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const n = start + index;
    return {
      id: `msg_${String(n).padStart(8, "0")}`,
      chatId: "cnv_00000001",
      senderKind: "human" as const,
      senderId: "user_1",
      body: `第 ${n} 条`,
      createdAt: new Date(T0 + n * 60_000).toISOString(),
      mentions: [],
    };
  });
}

const ids = (messages: readonly Message[]) => messages.map((message) => message.id);

/** 服务端一页：两头的游标与 hasOlder/hasNewer 都显式给，不替它猜。 */
function windowOf(
  messages: Message[],
  cursors: { before?: string | null; after?: string | null } = {},
  flags: { hasOlder?: boolean; hasNewer?: boolean } = {},
): MessageWindow {
  return {
    messages,
    tailCursor: cursors.after ?? null,
    olderCursor: cursors.before ?? null,
    hasOlder: flags.hasOlder ?? false,
    hasNewer: flags.hasNewer ?? false,
  };
}

/** 六页 1..300：用来验证两头都能丢、丢完还能读回来。 */
function sixPages(): ChatWindowState {
  let state = fromWindow(
    windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
  );
  for (const start of [201, 151, 101, 51, 1]) {
    state = prependOlder(
      state,
      windowOf(
        chunk(start, 50),
        { before: `c:${start - 1}`, after: `c:${start + 49}` },
        { hasOlder: start !== 1 },
      ),
    );
  }
  return state;
}

describe("消息窗口：翻页、合并与卸载", () => {
  it("首屏一页的边界与 hasOlder/hasNewer 原样来自服务端", () => {
    const state = fromWindow(
      windowOf(chunk(1, 3), { before: "c:0", after: "c:3" }, { hasOlder: true }),
    );
    expect(ids(windowMessages(state))).toEqual(ids(chunk(1, 3)));
    expect(hasOlder(state)).toBe(true);
    expect(olderCursor(state)).toBe("c:0");
    expect(hasNewer(state)).toBe(false);
    expect(newerCursor(state)).toBe("c:3");
    expect(pageBreaks(state)).toEqual([0]);
    expect(state.aboveShift).toBe(0);
  });

  it("hasNewer 要末页既说还有更新的、又手里有游标", () => {
    const yes = fromWindow(
      windowOf(chunk(1, 2), { before: "c:0", after: "c:2" }, { hasNewer: true }),
    );
    expect(hasNewer(yes)).toBe(true);
    expect(newerCursor(yes)).toBe("c:2");
    // 只有 hasNewer 没有游标：要不到下一页，按"没有了"处理。
    expect(hasNewer(fromWindow(windowOf(chunk(1, 2), {}, { hasNewer: true })))).toBe(false);
  });

  it("往前插页把新页放在最上面，并把往上游标换成新页自己的上界", () => {
    const base = fromWindow(
      windowOf(chunk(41, 50), { before: "c:40", after: "c:90" }, { hasOlder: true }),
    );
    const next = prependOlder(base, windowOf(chunk(1, 40), { before: "c:0" }));
    expect(ids(windowMessages(next))).toEqual(ids(chunk(1, 90)));
    expect(pageBreaks(next)).toEqual([0, 40]);
    expect(olderCursor(next)).toBe("c:0");
    // 新页自己说前面没有了，窗口就不再问下一轮。
    expect(hasOlder(next)).toBe(false);
    // 窗口的下界还是原来那一页的尾巴，往后翻的入口没被插页动过。
    expect(newerCursor(next)).toBe("c:90");
    expect(next.aboveShift).toBe(1);
  });

  it("空页只收掉 hasOlder，不制造空页，也不改往上游标", () => {
    const base = fromWindow(windowOf(chunk(1, 2), { before: "c:0" }, { hasOlder: true }));
    const next = prependOlder(base, windowOf([], {}, { hasOlder: false }));
    expect(next.pages).toHaveLength(1);
    expect(hasOlder(next)).toBe(false);
    expect(olderCursor(next)).toBe("c:0");
    expect(next.aboveShift).toBe(base.aboveShift);
  });

  it("整页都是见过的消息时不堆积重复页，并认为已经到头", () => {
    const base = fromWindow(windowOf(chunk(1, 3), { before: "c:0" }, { hasOlder: true }));
    const next = prependOlder(base, windowOf(chunk(2, 2), { before: "c:1" }, { hasOlder: true }));
    expect(ids(windowMessages(next))).toEqual(ids(chunk(1, 3)));
    expect(next.pages).toHaveLength(1);
    expect(hasOlder(next)).toBe(false);
  });

  it("往上游标是 null 时不再请求更早的页", () => {
    const base = fromWindow(windowOf(chunk(1, 3), {}, { hasOlder: true }));
    expect(hasOlder(base)).toBe(false);
    expect(prependOlder(base, windowOf(chunk(1, 3), { before: "c:0" }))).toBe(base);
  });

  it("尾巴重读只替换尾巴，早先翻出来的页留着，且不留缝隙不重复", () => {
    const older = chunk(1, 50);
    const tail = chunk(51, 50);
    const first = prependOlder(
      fromWindow(windowOf(tail, { before: "c:50", after: "c:100" }, { hasOlder: true })),
      windowOf(older, { before: "c:0" }),
    );
    // 新的一页：最新 50 条里挤进了一条新消息，首条从 52 开始。
    const next = mergeNewest(first, windowOf(chunk(52, 50), { before: "c:51", after: "c:101" }));
    const all = ids(windowMessages(next));
    expect(all).toEqual(ids(chunk(1, 101)));
    expect(new Set(all).size).toBe(all.length);
    expect(all.slice(0, 100)).toEqual(ids(chunk(1, 100)));
    expect(all.at(-1)).toBe("msg_00000101");
    expect(hasOlder(next)).toBe(false);
  });

  it("新页没有和旧窗口重叠时整页接在后面，不砍旧页", () => {
    const base = fromWindow(windowOf(chunk(1, 50), { before: "c:0", after: "c:50" }));
    const next = mergeNewest(base, windowOf(chunk(51, 50), { before: "c:50", after: "c:100" }));
    expect(ids(windowMessages(next))).toEqual(ids(chunk(1, 100)));
    expect(hasOlder(next)).toBe(false);
    expect(olderCursor(next)).toBe("c:0");
    expect(hasNewer(next)).toBe(false);
  });

  it("尾巴被卸载后重读不并窗口：那会在中间接出一段缺口", () => {
    const state = evictFar(sixPages(), 0);
    expect(hasNewer(state)).toBe(true);
    const reloaded = windowOf(chunk(301, 50), { before: "c:301", after: "c:350" });
    expect(mergeNewest(state, reloaded)).toBe(state);
  });

  it("增量读按 id 去重，超出一页就开新页，页大小与首屏一致", () => {
    const base = fromWindow(windowOf(chunk(1, 50), { before: "c:0", after: "c:50" }));
    const same = appendNew(base, chunk(1, 50), PAGE);
    expect(same).toBe(base);
    const grown = appendNew(base, chunk(51, 3), PAGE);
    expect(ids(windowMessages(grown))).toEqual(ids(chunk(1, 53)));
    expect(pageBreaks(grown)).toEqual([0, 50]);
    expect(grown.aboveShift).toBe(base.aboveShift);
    expect(hasNewer(grown)).toBe(false);
  });

  it("尾巴被卸载后增量读不就地追加，等窗口整体换回最新", () => {
    const state = evictFar(sixPages(), 0);
    expect(appendNew(state, chunk(301, 2), PAGE)).toBe(state);
  });

  it("往下接页：接上离开的那段，接不动时收掉 hasNewer", () => {
    const state = evictFar(sixPages(), 0);
    // 尾巴被丢掉之后，末页的游标正好指向丢掉的下一页的开头。
    expect(newerCursor(state)).toBe("c:150");
    const next = appendNewer(
      state,
      windowOf(chunk(151, 50), { before: "c:151", after: "c:200" }, { hasNewer: true }),
    );
    expect(ids(windowMessages(next)).slice(-50)).toEqual(ids(chunk(151, 50)));
    expect(pageBreaks(next)).toEqual([0, 50, 100, 150]);
    expect(hasNewer(next)).toBe(true);
    // 服务端说后面没有了：只收掉 hasNewer，不加空页。
    const done = appendNewer(next, windowOf([], {}, { hasNewer: false }));
    expect(done.pages).toHaveLength(next.pages.length);
    expect(hasNewer(done)).toBe(false);
  });

  it("距卸载只留锚点上下各两页，窗口始终是连续一段", () => {
    let state = sixPages();
    expect(state.pages).toHaveLength(6);
    const evicted = evictFar(state, 4);
    expect(evicted.pages).toHaveLength(4);
    // 锚点页（201..250）上下各两页：101..150 与 251..300。
    expect(ids(windowMessages(evicted))).toEqual(ids(chunk(101, 200)));
    expect(hasNewer(evicted)).toBe(false);
    // 被丢掉的页可以再读回来：往上游标指向新的首屏。
    expect(olderCursor(evicted)).toBe("c:100");
    // 卸掉了锚点之上的页：要还原滚动位置。
    expect(evicted.aboveShift).toBe(state.aboveShift + 1);
    state = evicted;
    // 锚点是新的首屏（index 0）时，下方的页也该丢，且没有上方变化。
    const nearTop = evictFar(state, 0);
    expect(nearTop.pages).toHaveLength(3);
    expect(ids(windowMessages(nearTop))).toEqual(ids(chunk(101, 150)));
    expect(nearTop.aboveShift).toBe(evicted.aboveShift);
    // 尾巴被丢掉了，新末页要知道自己后面还有消息。
    expect(hasNewer(nearTop)).toBe(true);
    expect(newerCursor(nearTop)).toBe("c:250");
  });

  it("页数没超预算时不动窗口", () => {
    const state = fromWindow(
      windowOf(chunk(1, 50), { before: "c:0", after: "c:50" }, { hasOlder: true }),
    );
    expect(evictFar(state, 0)).toBe(state);
  });

  it("增量把一页撑成多页时，切出来的页不继承原来那页的更早游标", () => {
    const base = fromWindow(
      windowOf(chunk(1, 50), { before: "c:0", after: "c:50" }, { hasOlder: true }),
    );
    const grown = appendNew(base, chunk(51, 60), PAGE);
    expect(pageBreaks(grown)).toEqual([0, 50, 100]);
    expect(grown.pages[0].before).toBe("c:0");
    // 切出来的后半页没有服务端游标：拿前一页的游标冒充自己的上界，会去要一段不属于它的历史。
    expect(grown.pages[1].before).toBeNull();
    expect(grown.pages[1].hasOlder).toBe(false);
    expect(grown.pages[1].messages[0].id).toBe("msg_00000051");
  });

  it("重读回来的整页原样重放时窗口不变短，也不留下空页", () => {
    const base = fromWindow(
      windowOf(chunk(1, 3), { before: "c:0", after: "c:3" }, { hasOlder: true }),
    );
    const same = mergeNewest(
      base,
      windowOf(chunk(1, 3), { before: "c:0", after: "c:3" }, { hasOlder: true }),
    );
    expect(same.pages).toEqual(base.pages);
    expect(pageBreaks(same)).toEqual([0]);
  });
});

/** 从尾巴一页页往后长出来的窗口：只有首屏带着自己的更早游标，后面接入的页都没有。 */
function grownTail(): ChatWindowState {
  let state = fromWindow(
    windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
  );
  for (const start of [301, 351, 401, 451, 501]) {
    state = mergeNewest(
      state,
      windowOf(chunk(start, 50), { before: `c:${start - 1}`, after: `c:${start + 49}` }),
    );
  }
  return state;
}

describe("消息窗口：卸载之后还能不能读回来", () => {
  it("卸掉锚点之上的页后，新的首屏也要回答「上面还有」", () => {
    const state = grownTail();
    expect(state.pages.map((page) => page.hasOlder)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    const evicted = evictFar(state, 5);
    expect(ids(windowMessages(evicted))).toEqual(ids(chunk(401, 150)));
    expect(evicted.aboveShift).toBe(state.aboveShift + 1);
    // 丢掉的那段还在，所以新首屏要接着说「还能往前翻」，游标是它自己的上界。
    expect(hasOlder(evicted)).toBe(true);
    expect(olderCursor(evicted)).toBe("c:400");
  });

  it("原本就说到头了的窗口，卸载后不会凭空又长出「加载更早」", () => {
    let state = fromWindow(windowOf(chunk(1, 50), {}, { hasNewer: false }));
    state = appendNew(state, chunk(51, 250), PAGE);
    expect(state.pages).toHaveLength(6);
    expect(state.pages.every((page) => !page.hasOlder)).toBe(true);
    const evicted = evictFar(state, 4);
    expect(ids(windowMessages(evicted))).toEqual(ids(chunk(101, 200)));
    expect(hasOlder(evicted)).toBe(false);
    expect(olderCursor(evicted)).toBeNull();
  });
});
