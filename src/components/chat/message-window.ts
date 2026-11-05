import type { Message, MessageCursor, MessageWindow } from "../../contracts/chat";

/**
 * 一页消息，外加往两头翻页所需的游标。页是窗口的最小单位：
 * 渲染按页分块（浏览器跳过屏外页），卸载也整页丢掉，不留半页。
 */
export type MessagePage = {
  messages: Message[];
  /** 要这一页之前的页用这个游标；null 表示不知道或没有更早的。 */
  before: MessageCursor | null;
  /** 要这一页之后的页用这个游标；null 表示不知道或没有更新的。 */
  after: MessageCursor | null;
  /** 这一页之前还有没有消息。 */
  hasOlder: boolean;
  /** 这一页之后还有没有消息。 */
  hasNewer: boolean;
};

/**
 * 距离卸载的半径（页数）：锚点页上下各留这么多页，更远的页丢掉，滚回去时再要。
 * 半径 2 = 最多 5 页 = 250 条，和"总消息量超过 300 就批量卸载"的目的一致。
 */
export const MESSAGE_WINDOW_RADIUS = 2;

export type ChatWindowState = {
  pages: MessagePage[];
  /** 页结构变化（翻页、卸载、重读尾巴）时递增，渲染按它刷新。 */
  revision: number;
  /**
   * 只在"视口上方内容变了"时递增：往前插页，或卸载了锚点之上的页。
   * 滚动位置靠 `scrollHeight - scrollTop` 这个不变量还原，只对这种变化有意义；
   * 下方的页变多变少不影响视口，也就用不着还原。
   */
  aboveShift: number;
};

export function fromWindow(page: MessageWindow): ChatWindowState {
  return {
    pages: [
      {
        messages: page.messages,
        before: page.olderCursor,
        after: page.tailCursor,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
      },
    ],
    revision: 0,
    aboveShift: 0,
  };
}

export function windowMessages(state: ChatWindowState): Message[] {
  return state.pages.flatMap((page) => page.messages);
}

/** 首屏那页的上界就是"往上再要一页"的入口；它被卸载后就换成新的首屏。 */
export function olderCursor(state: ChatWindowState): MessageCursor | null {
  return state.pages[0]?.before ?? null;
}

/** 末页的下界就是"往下再要一页"的入口；尾巴被卸载后它就是新的末页。 */
export function newerCursor(state: ChatWindowState): MessageCursor | null {
  return state.pages.at(-1)?.after ?? null;
}

/**
 * 还能往前翻吗：首屏说自己还有更早的，并且手里确实有要这一页的游标。
 * 只有其中一半时按"没有了"处理，免得拿 null 去要一页。
 */
export function hasOlder(state: ChatWindowState): boolean {
  const first = state.pages[0];
  return first === undefined
    ? false
    : first.messages.length > 0 && first.hasOlder && first.before !== null;
}

/** 还能往后翻吗：末页说自己还有更新的，并且手里有游标。 */
export function hasNewer(state: ChatWindowState): boolean {
  const last = state.pages.at(-1);
  return last === undefined
    ? false
    : last.messages.length > 0 && last.hasNewer && last.after !== null;
}

/** 每页首条消息在全量列表里的下标，渲染按这些切分点分块。 */
export function pageBreaks(state: ChatWindowState): number[] {
  const breaks: number[] = [];
  let offset = 0;
  for (const page of state.pages) {
    // 空页不占下标；同一个下标重复出现会让渲染切出零长度分块，因此只收第一个。
    if (page.messages.length > 0 && breaks.at(-1) !== offset) breaks.push(offset);
    offset += page.messages.length;
  }
  return breaks;
}

function idsOf(messages: readonly Message[]): Set<string> {
  return new Set(messages.map((message) => message.id));
}

/**
 * 往前插入一页。空页是"没有更早的了"的答案，只把首屏的 `hasOlder` 收掉，不制造空页。
 * 新页里已经出现过的 id 说明两边重叠，只保留没见过的那些。
 */
export function prependOlder(state: ChatWindowState, page: MessageWindow): ChatWindowState {
  const first = state.pages[0];
  if (first === undefined || !hasOlder(state)) return state;
  const stop = (): ChatWindowState => ({
    pages: [{ ...first, hasOlder: false }, ...state.pages.slice(1)],
    revision: state.revision + 1,
    aboveShift: state.aboveShift,
  });
  if (page.messages.length === 0) return stop();
  const seen = idsOf(windowMessages(state));
  const fresh = page.messages.filter((message) => !seen.has(message.id));
  // 整页都在窗口里说明这不是真正更早的一页；收掉 hasOlder，免得反复问同一页。
  if (fresh.length === 0) return stop();
  const inserted: MessagePage = {
    messages: fresh,
    before: page.olderCursor,
    after: page.tailCursor,
    hasOlder: page.hasOlder,
    hasNewer: true,
  };
  return {
    pages: [inserted, ...state.pages],
    revision: state.revision + 1,
    aboveShift: state.aboveShift + 1,
  };
}

/**
 * 往下接一页。末页已经不挨着真尾巴时用它补回来；接上来的页自己带着服务端的
 * `hasNewer`，接不动了就收掉"还有更新的"。
 */
export function appendNewer(state: ChatWindowState, page: MessageWindow): ChatWindowState {
  const last = state.pages.at(-1);
  if (last === undefined || !hasNewer(state)) return state;
  const seen = idsOf(windowMessages(state));
  const fresh = page.messages.filter((message) => !seen.has(message.id));
  if (fresh.length === 0) {
    // 这一页本来就在窗口里，只可能是"没有更多了"的新答案。
    if (last.hasNewer === page.hasNewer) return state;
    return {
      pages: [...state.pages.slice(0, -1), { ...last, hasNewer: page.hasNewer }],
      revision: state.revision + 1,
      aboveShift: state.aboveShift,
    };
  }
  return {
    pages: [
      ...state.pages,
      {
        messages: fresh,
        before: page.olderCursor,
        after: page.tailCursor,
        hasOlder: false,
        hasNewer: page.hasNewer,
      },
    ],
    revision: state.revision + 1,
    aboveShift: state.aboveShift,
  };
}

/**
 * 尾巴页被重读（loader 重载）后替换：旧页里严格早于新页首条的部分原样保留，
 * 之后整页换成新的。页与页之间因此始终连续，不会被新页挤出缝隙。
 * 尾巴已经被卸载（末页不挨着真尾巴）时不并：那会凭空接出一段缺口。
 */
export function mergeNewest(state: ChatWindowState, page: MessageWindow): ChatWindowState {
  if (page.messages.length === 0 || hasNewer(state)) return state;
  const head = page.messages[0];
  const all = windowMessages(state);
  const at = all.findIndex((message) => message.id === head.id);
  // 找到新页起点就砍掉它及之后的消息；找不到说明旧窗口整段都比它早，不用砍。
  const kept = at === -1 ? all : all.slice(0, at);
  const seen = idsOf(kept);
  const fresh = page.messages.filter((message) => !seen.has(message.id));
  if (fresh.length === 0 && kept.length === all.length) return state;
  const pages = splitLike(kept, state);
  // 新页整段都是窗口里已有的消息时不制造空页：空页要占卸载名额，还会切出零长度的渲染块。
  if (fresh.length === 0 && pages.length === 0) return state;
  if (fresh.length > 0)
    pages.push({
      messages: fresh,
      before: page.olderCursor,
      after: page.tailCursor,
      hasOlder: false,
      hasNewer: page.hasNewer,
    });
  // 只有最上面那页回答"还能不能往前翻"，沿用原首屏的答案；卸载过就跟着新的首屏走。
  const top = pages[0];
  const oldTop = state.pages[0];
  if (top !== undefined)
    pages[0] = {
      ...top,
      before: oldTop?.before ?? page.olderCursor,
      hasOlder: oldTop?.hasOlder ?? page.hasOlder,
    };
  return { pages, revision: state.revision + 1, aboveShift: state.aboveShift };
}

/** 按原来的页边界把留下的消息切回页结构；切不齐的尾巴并进最后一页。 */
function splitLike(kept: Message[], state: ChatWindowState): MessagePage[] {
  if (kept.length === 0) return [];
  const pages: MessagePage[] = [];
  let index = 0;
  for (const page of state.pages) {
    if (index >= kept.length) break;
    const slice = kept.slice(index, index + page.messages.length);
    if (slice.length > 0)
      pages.push({
        messages: slice,
        before: page.before,
        after: page.after,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
      });
    index += page.messages.length;
  }
  if (index < kept.length)
    pages.push({
      messages: kept.slice(index),
      before: null,
      after: null,
      hasOlder: false,
      hasNewer: false,
    });
  return pages;
}

/** 增量读到的消息接到最后一页；超过一页就开新页，页大小与首屏一致。 */
export function appendNew(
  state: ChatWindowState,
  messages: readonly Message[],
  pageSize: number,
): ChatWindowState {
  // 末页不挨着真尾巴时不能就地追加：那会在中间插进一段更新的消息。
  if (hasNewer(state)) return state;
  const seen = idsOf(windowMessages(state));
  const fresh = messages.filter((message) => !seen.has(message.id));
  if (fresh.length === 0) return state;
  const last = state.pages.at(-1);
  if (last === undefined) {
    return {
      pages: [
        { messages: [...fresh], before: null, after: null, hasOlder: false, hasNewer: false },
      ],
      revision: state.revision + 1,
      aboveShift: state.aboveShift,
    };
  }
  const merged = [...last.messages, ...fresh];
  const pages = state.pages.slice(0, -1);
  for (let start = 0; start < merged.length; start += pageSize) {
    const slice = merged.slice(start, start + pageSize);
    const isFirst = start === 0;
    const isLast = start + pageSize >= merged.length;
    pages.push({
      messages: slice,
      // 只有原来那页的头部还带着服务端的更早游标；切出来的后半页没有游标可用，
      // 抄前一页的游标会让它当首屏时去要一段不属于自己的历史。
      before: isFirst ? last.before : null,
      after: isLast ? last.after : null,
      hasOlder: isFirst ? last.hasOlder : false,
      hasNewer: isLast ? last.hasNewer : true,
    });
  }
  return { pages, revision: state.revision + 1, aboveShift: state.aboveShift };
}

/**
 * 距卸载：留锚点页上下各 `radius` 页，更远的页整页丢掉，滚回去时再按需重读。
 * 丢锚点之上的页要还原滚动位置（`aboveShift`），丢下方的页不用。
 */
export function evictFar(
  state: ChatWindowState,
  anchorPage: number,
  radius = MESSAGE_WINDOW_RADIUS,
): ChatWindowState {
  if (anchorPage < 0 || anchorPage >= state.pages.length) return state;
  const first = Math.max(0, anchorPage - radius);
  const last = Math.min(state.pages.length - 1, anchorPage + radius);
  if (first === 0 && last === state.pages.length - 1) return state;
  const droppedAbove = first > 0;
  const droppedBelow = last < state.pages.length - 1;
  // 丢掉锚点之上的页之后，往更早那头的入口换成了新的首屏。新首屏还带着自己的游标，
  // 而被丢掉那段确实还在，所以只要原来首屏说"上面还有"，就得让新首屏也这么回答。
  const recoverOlder = droppedAbove && (state.pages[0]?.hasOlder ?? false);
  const kept = state.pages
    .slice(first, last + 1)
    .map((page, index) => (index === 0 && recoverOlder ? { ...page, hasOlder: true } : page));
  const tail = kept.at(-1);
  const pages =
    droppedBelow && tail !== undefined ? [...kept.slice(0, -1), { ...tail, hasNewer: true }] : kept;
  return {
    pages,
    revision: state.revision + 1,
    aboveShift: droppedAbove ? state.aboveShift + 1 : state.aboveShift,
  };
}
