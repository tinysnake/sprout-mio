export type SkillToken = Readonly<{ name: string; start: number; end: number }>;

/** 输入框里敲它开候选；它不进入正文。 */
export const SKILL_TRIGGER = "$";
/** 正文里的技能标记，扫描、展开与 chip 都认它。 */
export const SKILL_MARK = "📖";
/** 两枚标记之间至少留两个半角空格：只隔一个半角空格时两枚各让一半，剩不下看得见的空档。 */
const TOKEN_SPACES = 2;

const escape = (value: string) => value.replace(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
const TRIGGER = escape(SKILL_TRIGGER);
const MARK = escape(SKILL_MARK);
const QUERY_AT_END = new RegExp(`(?:^|\\s)${TRIGGER}([^\\s${TRIGGER}]*)$`, "u");
const TOKEN_SCAN = new RegExp(`${MARK}([^\\s${MARK}]+)`, "gu");

export function isSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    !/[\s📖]/u.test(name) &&
    ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

export function skillToken(name: string): string {
  if (!isSkillName(name)) throw new Error("无法表示的技能名称");
  return `${SKILL_MARK}${name}`;
}

export function scanSkillTokens(body: string): readonly SkillToken[] {
  return [...body.matchAll(TOKEN_SCAN)]
    .filter((match) => isSkillName(match[1]))
    .map((match) => ({ name: match[1], start: match.index, end: match.index + match[0].length }));
}

export function skillQueryAt(body: string, caret: number) {
  if (scanSkillTokens(body).some((span) => caret > span.start && caret < span.end)) return null;
  const match = QUERY_AT_END.exec(body.slice(0, caret));
  return match
    ? { query: match[1], start: caret - match[1].length - SKILL_TRIGGER.length, end: caret }
    : null;
}

const TOKEN_BEFORE = /(📖[^\s📖]*)( *)$/u;
const TOKEN_AFTER = /^( *)(📖[^\s📖]+)/u;

/**
 * 插入标记，并把与相邻标记之间的空隙补到两个半角空格。想办法不改变原文本，只有标记之间的
 * 空隙会变宽：那点空隙是两枚标记的圆角矩形各自让出留白后剩下的全部内容。
 */
export function insertSkill(body: string, range: { start: number; end: number }, name: string) {
  const token = `${skillToken(name)} `;
  const head = body.slice(0, range.start);
  const tail = body.slice(range.end);
  const before = TOKEN_BEFORE.exec(head);
  const after = TOKEN_AFTER.exec(tail);
  // 左侧的空隙全由 head 末尾的空格构成；右侧还算上 token 自带的那个尾随空格。
  const lead = before ? " ".repeat(Math.max(0, TOKEN_SPACES - before[2].length)) : "";
  const trail = after ? " ".repeat(Math.max(0, TOKEN_SPACES - 1 - after[1].length)) : "";
  return {
    text: head + lead + token + trail + tail,
    caret: head.length + lead.length + token.length,
  };
}
