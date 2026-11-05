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
  stillAtEdge,
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
/** 造出的消息 id：补零到 8 位，跟 chunk 保持一致。 */
const mid = (n: number) => `msg_${String(n).padStart(8, "0")}`;

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

/** 六页 1..300，尾巴是最新一页：用来验证两头都能丢、丢完还能读回来。 */
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
        { hasOlder: start > 1 },
      ),
    );
  }
  return state;
}

const pageSummary = (state: ChatWindowState) =>
  state.pages.map((page) => ({
    ids: [ids(page.messages).at(0), ids(page.messages).at(-1)],
    before: page.before,
    after: page.after,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  }));

describe("消息窗口：页边界来自服务端，客户端不重切", () => {
  it("首屏是一页，两头的游标与标志照抄服务端", () => {
    const state = fromWindow(
      windowOf(chunk(271, 50), { before: "c:270", after: "c:320" }, { hasOlder: true }),
    );
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0]?.before).toBe("c:270");
    expect(state.pages[0]?.after).toBe("c:320");
    expect(hasOlder(state)).toBe(true);
    expect(hasNewer(state)).toBe(false);
    expect(olderCursor(state)).toBe("c:270");
    expect(newerCursor(state)).toBe("c:320");
    expect(state.anchor).toBe(0);
    expect(state.aboveShift).toBe(0);
  });

  it("空窗没有页，也就没有可翻的方向", () => {
    const state = fromWindow(windowOf([], { before: null, after: null }));
    expect(state.pages).toHaveLength(0);
    expect(windowMessages(state)).toEqual([]);
    expect(hasOlder(state)).toBe(false);
    expect(hasNewer(state)).toBe(false);
    expect(olderCursor(state)).toBeNull();
    expect(newerCursor(state)).toBeNull();
  });

  it("往上接一页：新页自带游标，视口锚点跟着平移", () => {
    let state = fromWindow(
      windowOf(chunk(271, 50), { before: "c:270", after: "c:320" }, { hasOlder: true }),
    );
    state = prependOlder(
      state,
      windowOf(chunk(221, 50), { before: "c:220", after: "c:270" }, { hasOlder: true }),
    );
    expect(pageSummary(state)).toEqual([
      {
        ids: [mid(221), mid(270)],
        before: "c:220",
        after: "c:270",
        hasOlder: true,
        hasNewer: true,
      },
      {
        ids: [mid(271), mid(320)],
        before: "c:270",
        after: "c:320",
        hasOlder: true,
        hasNewer: false,
      },
    ]);
    expect(olderCursor(state)).toBe("c:220");
    expect(newerCursor(state)).toBe("c:320");
    expect(state.anchor).toBe(1);
    expect(state.aboveShift).toBe(1);
  });

  it("往上接一页：空页或整页重复只把首屏收成「没有更早」", () => {
    const state = fromWindow(
      windowOf(chunk(271, 50), { before: "c:270", after: "c:320" }, { hasOlder: true }),
    );
    const empty = prependOlder(state, windowOf([]));
    expect(hasOlder(empty)).toBe(false);
    expect(empty.pages).toHaveLength(1);
    const repeated = prependOlder(
      state,
      windowOf(chunk(271, 20), { before: "c:320", after: "c:320" }, { hasOlder: true }),
    );
    expect(hasOlder(repeated)).toBe(false);
    expect(repeated.pages).toHaveLength(1);
  });

  it("往下补一页：尾巴换成服务端那一页，标志与游标都跟着读回结果", () => {
    let state = fromWindow(
      windowOf(chunk(1, 50), { before: null, after: "c:50" }, { hasNewer: true }),
    );
    state = appendNewer(
      state,
      windowOf(chunk(51, 50), { before: "c:50", after: "c:100" }, { hasNewer: true }),
    );
    expect(newerCursor(state)).toBe("c:100");
    expect(hasNewer(state)).toBe(true);
    const exhausted = appendNewer(state, windowOf([]));
    expect(hasNewer(exhausted)).toBe(false);
  });

  it("本地新消息接在活尾巴上：游标空着，不假装知道位置", () => {
    const state = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    const grown = appendNew(state, chunk(301, 3), PAGE);
    expect(ids(windowMessages(grown)).at(-1)).toBe(mid(303));
    expect(grown.pages.at(-1)?.after).toBeNull();
    expect(grown.pages.at(-1)?.hasNewer).toBe(false);
    expect(newerCursor(grown)).toBeNull();
    expect(hasNewer(grown)).toBe(false);
  });

  it("本地新消息撑页：只把「读回来时还没有的那些」切成新页，新页 before 用旧页 after", () => {
    const state = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    const grown = appendNew(state, chunk(301, 60), PAGE);
    expect(pageSummary(grown)).toEqual([
      {
        ids: [mid(251), mid(300)],
        before: "c:250",
        after: "c:300",
        hasOlder: true,
        hasNewer: true,
      },
      { ids: [mid(301), mid(360)], before: "c:300", after: null, hasOlder: true, hasNewer: false },
    ]);
    // 新页的 before 正是它前一条的位置：拿它往上读会读到 300，不会读到 250。
    expect(grown.pages[1]?.before).toBe("c:300");
    // 再撑一次不会在活尾巴页里编游标：这一页 after 已经空着，就一直往上接。
    const again = appendNew(grown, chunk(361, 60), PAGE);
    expect(again.pages).toHaveLength(2);
    expect(ids(windowMessages(again)).at(-1)).toBe(mid(420));
  });

  it("尾巴不挨着真尾巴时不接本地新消息，否则会在窗口中间接出缺口", () => {
    let state = fromWindow(
      windowOf(chunk(1, 50), { before: null, after: "c:50" }, { hasNewer: true }),
    );
    state = appendNew(state, chunk(51, 5), PAGE);
    expect(state.pages).toHaveLength(1);
    expect(hasNewer(state)).toBe(true);
  });

  it("按 id 去重：增量读与 loader 常常递同一批消息过来", () => {
    const state = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    const same = appendNew(state, chunk(251, 50), PAGE);
    expect(windowMessages(same)).toHaveLength(50);
    expect(same).toBe(state);
  });
});

describe("整树重读并回窗口", () => {
  it("本地尾巴整段落在 loader 页里：换成 loader 页，边界跟服务器对齐", () => {
    let state = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    state = appendNew(state, chunk(301, 10), PAGE);
    const merged = mergeNewest(
      state,
      windowOf(chunk(291, 50), { before: "c:290", after: "c:340" }, { hasOlder: true }),
    );
    expect(merged.pages.at(-1)?.after).toBe("c:340");
    expect(ids(windowMessages(merged)).at(-1)).toBe(mid(340));
    expect(newerCursor(merged)).toBe("c:340");
  });

  it("loader 页整段已在窗口里：尾巴是更新的本地消息，不动", () => {
    let state = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    state = appendNew(state, chunk(301, 5), PAGE);
    const merged = mergeNewest(
      state,
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    expect(merged).toBe(state);
    expect(ids(windowMessages(merged)).at(-1)).toBe(mid(305));
  });

  it("两边断开：留着本地窗口，把尾巴标成还有更新的，缺口从我们末条之后补", () => {
    const state = fromWindow(windowOf(chunk(1, 50), { before: null, after: "c:50" }, {}));
    const merged = mergeNewest(
      state,
      windowOf(chunk(401, 50), { before: "c:400", after: "c:450" }, { hasOlder: true }),
    );
    expect(windowMessages(merged)).toHaveLength(50);
    expect(hasNewer(merged)).toBe(true);
    expect(newerCursor(merged)).toBe("c:50");
    // 缺口靠「加载更新的消息」逐页补回来，先补 51..100。
    const filled = appendNewer(
      merged,
      windowOf(chunk(51, 50), { before: "c:50", after: "c:100" }, { hasNewer: true }),
    );
    expect(ids(windowMessages(filled))).toHaveLength(100);
    expect(ids(windowMessages(filled)).at(-1)).toBe(mid(100));
    expect(hasNewer(filled)).toBe(true);
  });

  it("尾巴是活的本地新消息而两边没有交集：这一页比窗口旧，等下一次增量读", () => {
    let state = fromWindow(windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, {}));
    state = appendNew(state, chunk(301, 3), PAGE);
    const merged = mergeNewest(
      state,
      windowOf(chunk(101, 50), { before: "c:100", after: "c:150" }, { hasOlder: true }),
    );
    expect(merged).toBe(state);
  });

  it("loader 页比窗口旧又对不上：整窗换新，视口按上方变化重算", () => {
    const state = fromWindow(windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, {}));
    const merged = mergeNewest(
      state,
      windowOf(chunk(51, 50), { before: "c:50", after: "c:100" }, { hasOlder: true }),
    );
    expect(ids(windowMessages(merged))[0]).toBe(mid(51));
    expect(merged.pages).toHaveLength(1);
    expect(merged.anchor).toBe(0);
    expect(merged.aboveShift).toBe(1);
  });
});

describe("按锚点卸载两头", () => {
  it("锚点在窗口中间：只留上下各两页，别的照旧", () => {
    const settled = evictFar(sixPages(), 2);
    expect(settled.pages.map((page) => ids(page.messages)[0])).toEqual([
      mid(1),
      mid(51),
      mid(101),
      mid(151),
      mid(201),
    ]);
    expect(settled.anchor).toBe(2);
    // 丢的是下方最末那页：上方没变，视口不需要抬头。
    expect(settled.aboveShift).toBe(sixPages().aboveShift);
  });

  it("窗口装得下就不动，连锚点也已经是对的时候原样返回", () => {
    const state = sixPages();
    expect(evictFar(state, 2).pages).toHaveLength(5);
    const narrow = fromWindow(windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }));
    expect(evictFar(narrow, 0)).toBe(narrow);
  });

  it("锚点停在末页：留最新三页，抬头视口；丢掉的页能按首屏游标读回来", () => {
    const state = sixPages();
    const settled = evictFar(state, 5, 2);
    expect(pageSummary(settled).map((page) => page.ids)).toEqual([
      [mid(151), mid(200)],
      [mid(201), mid(250)],
      [mid(251), mid(300)],
    ]);
    expect(settled.anchor).toBe(2);
    expect(settled.aboveShift).toBe(state.aboveShift + 1);
    expect(olderCursor(settled)).toBe("c:150");
    // 读回来的是 101..150 那一段，接在最前面。
    const restored = prependOlder(
      settled,
      windowOf(chunk(101, 50), { before: "c:100", after: "c:150" }, { hasOlder: true }),
    );
    expect(ids(windowMessages(restored))[0]).toBe(mid(101));
    expect(hasOlder(restored)).toBe(true);
  });

  it("锚点停在最早页：丢掉下方页，末页自带 hasNewer 让「加载更新」可前进", () => {
    const state = sixPages();
    const settled = evictFar(state, 0, 2);
    expect(pageSummary(settled).map((page) => page.ids)).toEqual([
      [mid(1), mid(50)],
      [mid(51), mid(100)],
      [mid(101), mid(150)],
    ]);
    expect(hasNewer(settled)).toBe(true);
    expect(newerCursor(settled)).toBe("c:150");
    const filled = appendNewer(
      settled,
      windowOf(chunk(151, 50), { before: "c:150", after: "c:200" }, { hasNewer: true }),
    );
    expect(ids(windowMessages(filled)).at(-1)).toBe(mid(200));
    expect(newerCursor(filled)).toBe("c:200");
  });

  it("报视口页即收敛：外部只报页号，锚点由窗口自己平移", () => {
    let state = sixPages();
    state = evictFar(state, 5);
    expect(state.anchor).toBe(2);
    state = prependOlder(
      state,
      windowOf(chunk(101, 50), { before: "c:100", after: "c:150" }, { hasOlder: true }),
    );
    expect(state.anchor).toBe(3);
    state = evictFar(state, 0);
    expect(state.anchor).toBe(0);
    expect(ids(windowMessages(state))[0]).toBe(mid(101));
  });

  it("空窗卸载是恒等", () => {
    const state = fromWindow(windowOf([]));
    expect(evictFar(state, 3)).toBe(state);
  });

  it("页切分点跟着页长走，不重复", () => {
    const state = sixPages();
    expect(pageBreaks(state)).toEqual([0, 50, 100, 150, 200, 250]);
    const empty = fromWindow(windowOf([]));
    expect(pageBreaks(empty)).toEqual([]);
  });
});

describe("在途请求的边界校验", () => {
  it("边界还是发起时那个游标才允许接回去", () => {
    const state = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    expect(stillAtEdge(state, { before: "c:250" })).toBe(true);
    expect(stillAtEdge(state, { before: "c:200" })).toBe(false);
    expect(stillAtEdge(state, { after: "c:300" })).toBe(true);
    expect(stillAtEdge(state, { after: "c:350" })).toBe(false);
  });

  it("窗口被换成最新一页之后，旧的往回读结果不再认", () => {
    const before = fromWindow(
      windowOf(chunk(251, 50), { before: "c:250", after: "c:300" }, { hasOlder: true }),
    );
    const replaced = fromWindow(
      windowOf(chunk(301, 50), { before: "c:300", after: "c:350" }, { hasOlder: true }),
    );
    expect(stillAtEdge(before, { before: "c:250" })).toBe(true);
    expect(stillAtEdge(replaced, { before: "c:250" })).toBe(false);
    expect(stillAtEdge(fromWindow(windowOf([])), { before: "c:250" })).toBe(false);
  });
});
