import type { Message, MessageCursor, MessageWindow } from "../../contracts/chat";
import { laterMessageCursor } from "../../contracts/chat";

/**
 * 一页消息与它自己的边界：`before`/`after` 是这首末条各自的位置，来自把它读回来的那次
 * 请求。页从不重切，客户端也不重算游标，所以"翻回去读的到底是哪一段"永远可回答。
 */
export type MessagePage = {
  messages: Message[];
  /** 首条自身的位置，作为更早一页的 `before`；空窗或本地新消息时为 null。 */
  before: MessageCursor | null;
  /** 末条自身的位置，作为更新一页的 `after`；接在活尾巴上时为 null。 */
  after: MessageCursor | null;
  /** 首条之前还有消息。 */
  hasOlder: boolean;
  /** 末条之后还有消息。 */
  hasNewer: boolean;
};

export type ChatWindowState = {
  pages: MessagePage[];
  /** 视口所在页。随插页与卸载一起平移，外部只报"现在看的是第几页"。 */
  anchor: number;
  revision: number;
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
    revision: 0,
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
    revision: state.revision + 1,
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
  if (head === undefined) return { ...fromWindow(window), revision: state.revision + 1 };
  if (fresh.messages.length === 0) return patchPage(state, 0, { hasOlder: false });
  const known = ids(state);
  if (fresh.messages.every((message) => known.has(message.id))) {
    return patchPage(state, 0, { hasOlder: false });
  }
  // 这页之后一定还有东西（就是原来的首屏），所以它的 hasNewer 是事实，不是读回结果。
  return {
    pages: [{ ...fresh, hasNewer: true }, ...state.pages],
    anchor: state.anchor + 1,
    revision: state.revision + 1,
    aboveShift: state.aboveShift + 1,
  };
}

/** 往下补一页：只在尾巴被卸载过之后发生，页自带两头的游标与"还有更新"标志。 */
export function appendNewer(state: ChatWindowState, window: MessageWindow): ChatWindowState {
  const fresh = pageOf(window);
  const tail = state.pages.at(-1);
  if (tail === undefined) return { ...fromWindow(window), revision: state.revision + 1 };
  if (fresh.messages.length === 0)
    return patchPage(state, state.pages.length - 1, { hasNewer: false });
  // 这页之前一定还有东西，同理 hasOlder 是事实。
  return {
    ...state,
    pages: [...state.pages, { ...fresh, hasOlder: true }],
    revision: state.revision + 1,
  };
}

/**
 * 接本地新消息。尾巴不挨着真尾巴时不接，否则会在窗口中间接出一段没人能翻回来的缺口。
 *
 * 撑页时只把"这页读回来时还没有的那些消息"切成新页，新页 `before` 用旧页 `after`
 * （那正是它的前一条），所以新页边界依然由服务端游标描述；旧页的 `after` 也仍然指着
 * 自己的末条，不动。接在活尾巴上的页 `after` 为空，它再长也不会被切。
 */
export function appendNew(
  state: ChatWindowState,
  messages: Message[],
  pageSize: number,
): ChatWindowState {
  if (hasNewer(state)) return state;
  const known = ids(state);
  const fresh = messages.filter((message) => !known.has(message.id));
  if (fresh.length === 0) return state;

  const tail = state.pages.at(-1);
  if (tail === undefined) {
    return {
      pages: [{ messages: fresh, before: null, after: null, hasOlder: false, hasNewer: false }],
      anchor: 0,
      revision: state.revision + 1,
      aboveShift: state.aboveShift,
    };
  }

  const grown = [...tail.messages, ...fresh];
  if (grown.length > pageSize && tail.after !== null) {
    return {
      pages: [
        ...state.pages.slice(0, -1),
        { ...tail, hasNewer: true },
        { messages: fresh, before: tail.after, after: null, hasOlder: true, hasNewer: false },
      ],
      anchor: state.anchor,
      revision: state.revision + 1,
      aboveShift: state.aboveShift,
    };
  }
  return {
    ...state,
    pages: [
      ...state.pages.slice(0, -1),
      { ...tail, messages: grown, after: null, hasNewer: false },
    ],
    revision: state.revision + 1,
  };
}

/**
 * 整树重读只有一页（最新 50 条）时，把它并回窗口。
 *
 * - 本地尾巴整段落在这页里：换成这页，边界跟服务端对齐（本地接出来的消息本来也在其中）。
 * - 这页整段已在窗口里：尾巴是更新的本地消息，不动。
 * - 两边断开：留着本地窗口，把尾巴标成"还有更新的"，缺口交给「回到最新」按 `after` 补。
 * - 尾巴是活的本地新消息（`after` 为空）而两边又没有交集：这页比窗口旧，等下一次增量读补上。
 * - 剩下的是真交叉（页比窗口旧或两头都断）：整窗换新。
 */
export function mergeNewest(state: ChatWindowState, window: MessageWindow): ChatWindowState {
  const fresh = pageOf(window);
  if (state.pages.length === 0) return fromWindow(window);
  if (fresh.messages.length === 0) return state;

  const tail = state.pages.at(-1)!;
  const freshIds = new Set(fresh.messages.map((message) => message.id));
  if (tail.messages.every((message) => freshIds.has(message.id))) {
    return { ...state, pages: [...state.pages.slice(0, -1), fresh], revision: state.revision + 1 };
  }

  const known = ids(state);
  if (fresh.messages.every((message) => known.has(message.id))) return state;

  if (tail.after === null) return state;

  if (fresh.before !== null && laterMessageCursor(fresh.before, tail.after) === fresh.before) {
    return patchPage(state, state.pages.length - 1, { hasNewer: true });
  }

  return {
    ...fromWindow(window),
    revision: state.revision + 1,
    aboveShift: state.aboveShift + 1,
    anchor: 0,
  };
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
    revision: state.revision + 1,
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
