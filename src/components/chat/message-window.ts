import type { Message, MessageCursor, MessageWindow } from "../../contracts/chat";
import { laterMessageCursor } from "../../contracts/chat";

/**
 * 一页消息与它自己的边界。游标一律照抄"把这页读回来的那次请求"，客户端不重算，
 * 因此"翻回去读的到底是哪一段"永远可回答。
 */
export type MessagePage = {
  messages: Message[];
  /**
   * 这页首条在服务端的位置，读更早一页时原样作为 `before` 传回：服务端按"严格早于
   * 它"取，正好接在这页前面。本地接出来的页拿不到位置，留空就表示读不动更早的。
   */
  before: MessageCursor | null;
  /** 这页末条的位置，读更新一页时作为 `after` 传回。本地接了新消息之后它就失效，重新变空。 */
  after: MessageCursor | null;
  /** 首条之前还有消息。 */
  hasOlder: boolean;
  /** 末条之后还有消息。 */
  hasNewer: boolean;
};

export type ChatWindowState = {
  pages: MessagePage[];
  /** 视口所在页。插页与卸载都带着它平移，外部只报"现在看的是第几页"。 */
  anchor: number;
  /** 视口上方内容变化的次数，滚动位置靠它触发还原。 */
  aboveShift: number;
};

/** 视口上下各留几页：5 页 × 50 条 = 250 条，远低于 300 的内存预算。 */
export const MESSAGE_WINDOW_RADIUS = 2;

function pageOf(window: MessageWindow): MessagePage {
  return {
    messages: window.messages,
    before: window.olderCursor,
    after: window.tailCursor,
    hasOlder: window.hasOlder,
    hasNewer: window.hasNewer,
  };
}

export function fromWindow(window: MessageWindow): ChatWindowState {
  return {
    pages: window.messages.length === 0 ? [] : [pageOf(window)],
    anchor: 0,
    aboveShift: 0,
  };
}

export function windowMessages(state: ChatWindowState): Message[] {
  return state.pages.flatMap((page) => page.messages);
}

export function olderCursor(state: ChatWindowState): MessageCursor | null {
  return state.pages[0]?.before ?? null;
}

export function newerCursor(state: ChatWindowState): MessageCursor | null {
  return state.pages.at(-1)?.after ?? null;
}

export function hasOlder(state: ChatWindowState): boolean {
  const head = state.pages[0];
  return head !== undefined && head.messages.length > 0 && head.hasOlder && head.before !== null;
}

export function hasNewer(state: ChatWindowState): boolean {
  const tail = state.pages.at(-1);
  return tail !== undefined && tail.messages.length > 0 && tail.hasNewer && tail.after !== null;
}

export function pageBreaks(state: ChatWindowState): number[] {
  const breaks: number[] = [];
  let offset = 0;
  for (const page of state.pages) {
    if (breaks.at(-1) !== offset) breaks.push(offset);
    offset += page.messages.length;
  }
  return breaks;
}

function patchPage(
  state: ChatWindowState,
  index: number,
  changes: Partial<MessagePage>,
): ChatWindowState {
  return {
    ...state,
    pages: state.pages.map((page, at) => (at === index ? { ...page, ...changes } : page)),
  };
}

function ids(state: ChatWindowState): Set<string> {
  return new Set(windowMessages(state).map((message) => message.id));
}

/**
 * 往上接一页。空页与整页重复都只把首屏标成"没有更早"，避免同一个游标被反复请求。
 */
export function prependOlder(state: ChatWindowState, window: MessageWindow): ChatWindowState {
  const fresh = pageOf(window);
  const head = state.pages[0];
  if (head === undefined) return fromWindow(window);
  if (fresh.messages.length === 0) return patchPage(state, 0, { hasOlder: false });
  const known = ids(state);
  if (fresh.messages.every((message) => known.has(message.id))) {
    return patchPage(state, 0, { hasOlder: false });
  }
  // 这页之后一定还有东西（就是原来的首屏），所以它的 hasNewer 是事实，不是读回结果。
  return {
    pages: [{ ...fresh, hasNewer: true }, ...state.pages],
    anchor: state.anchor + 1,
    aboveShift: state.aboveShift + 1,
  };
}

/** 往下补一页：只在尾巴被卸载过之后发生，页自带两头的游标与"还有更新"标志。 */
export function appendNewer(state: ChatWindowState, window: MessageWindow): ChatWindowState {
  const fresh = pageOf(window);
  const tail = state.pages.at(-1);
  if (tail === undefined) return fromWindow(window);
  if (fresh.messages.length === 0)
    return patchPage(state, state.pages.length - 1, { hasNewer: false });
  // 这页之前一定还有东西，同理 hasOlder 是事实。
  return {
    ...state,
    pages: [...state.pages, { ...fresh, hasOlder: true }],
  };
}

/**
 * 接本地新消息。只往活尾巴上加，不切页：切出来的页没有首条位置，`before` 就指向别处，
 * 往回翻会读到错位的一段。页因此能长过一页大小，下一次整树重读把边界拉回服务端。
 */
export function appendNew(state: ChatWindowState, messages: Message[]): ChatWindowState {
  if (hasNewer(state)) return state;
  const known = ids(state);
  const fresh = messages.filter((message) => !known.has(message.id));
  if (fresh.length === 0) return state;

  const tail = state.pages.at(-1);
  if (tail === undefined) {
    return {
      pages: [{ messages: fresh, before: null, after: null, hasOlder: false, hasNewer: false }],
      anchor: 0,
      aboveShift: state.aboveShift,
    };
  }
  return {
    ...state,
    pages: [
      ...state.pages.slice(0, -1),
      { ...tail, messages: [...tail.messages, ...fresh], after: null, hasNewer: false },
    ],
  };
}

/**
 * 整树重读只有一页（最新 50 条）时并回窗口。
 *
 * - 这页整段已在窗口里：尾巴是更新的本地消息，不动。
 * - 这页首条落在末页里：保住末页在它之前的那段，再接上这页（重读页读到真尾巴，覆盖到
 *   哪里就是哪里），两个边界仍然各由一次请求给出。
 * - 两边断开且这页更新：留着窗口，把末页标成"还有更新的"，缺口交给「回到最新」按
 *   `after` 逐页补。
 * - 其余（这页比窗口旧，或活尾巴之后没有任何交集）：不动，等下一次增量读。
 */
export function mergeNewest(state: ChatWindowState, window: MessageWindow): ChatWindowState {
  if (state.pages.length === 0) return fromWindow(window);
  const fresh = pageOf(window);
  if (fresh.messages.length === 0) return state;

  const known = ids(state);
  if (fresh.messages.every((message) => known.has(message.id))) return state;

  const tail = state.pages.at(-1)!;
  const at = tail.messages.findIndex((message) => message.id === fresh.messages[0]!.id);
  if (at >= 0) {
    // 重读页可能落在末页中间，尾巴上还挂着它之后才到的本地消息，那部分不能跟着重读一起丢。
    const kept = tail.messages.slice(0, at);
    const freshIds = new Set(fresh.messages.map((message) => message.id));
    let lastOverlap = tail.messages.length - 1;
    while (lastOverlap >= 0 && !freshIds.has(tail.messages[lastOverlap]!.id)) lastOverlap -= 1;
    const newer = tail.messages.slice(lastOverlap + 1);
    const seen = new Set(kept.map((message) => message.id));
    const grown = [...fresh.messages, ...newer].filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
    return {
      ...state,
      pages: [
        ...state.pages.slice(0, -1),
        {
          ...tail,
          messages: [...kept, ...grown],
          after: newer.length > 0 ? null : fresh.after,
          hasNewer: newer.length > 0 ? false : fresh.hasNewer,
        },
      ],
    };
  }

  if (
    tail.after !== null &&
    fresh.before !== null &&
    laterMessageCursor(fresh.before, tail.after) === fresh.before
  ) {
    return patchPage(state, state.pages.length - 1, { hasNewer: true });
  }

  return state;
}

/**
 * 只留锚点上下各 `radius` 页。丢掉的页靠两头的游标重读回来，所以丢上方页时要抬头
 * `aboveShift`（滚动位置按视口里那条消息还原），丢下方页时末页自带的 `hasNewer` 会
 * 让「加载更新 / 回到最新」出现。
 */
export function evictFar(
  state: ChatWindowState,
  anchorPage: number,
  radius: number = MESSAGE_WINDOW_RADIUS,
): ChatWindowState {
  if (state.pages.length === 0) return state;
  const anchor = Math.min(Math.max(anchorPage, 0), state.pages.length - 1);
  const first = Math.max(0, anchor - radius);
  const last = Math.min(state.pages.length - 1, anchor + radius);
  if (first === 0 && last === state.pages.length - 1) {
    return state.anchor === anchor ? state : { ...state, anchor };
  }
  const kept = state.pages.slice(first, last + 1);
  const droppedBelow = last < state.pages.length - 1;
  return {
    // 丢掉下方页之后，新的末页后面确实还有消息：不标这一下，「加载更新」就再也不会出现。
    pages: droppedBelow
      ? [...kept.slice(0, -1), { ...kept[kept.length - 1]!, hasNewer: true }]
      : kept,
    anchor: anchor - first,
    aboveShift: state.aboveShift + (first > 0 ? 1 : 0),
  };
}

/**
 * 在途请求的结果是否还属于当前窗口：发起时的游标不再是当前边界，就说明窗口已经换过，
 * 结果插回去会在新窗口中间接出缺口。
 */
export function stillAtEdge(
  state: ChatWindowState,
  edge: { before?: MessageCursor | null; after?: MessageCursor | null },
): boolean {
  if (state.pages.length === 0) return false;
  if ("before" in edge) return olderCursor(state) === edge.before;
  return newerCursor(state) === edge.after;
}
