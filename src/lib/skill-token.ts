export type SkillToken = Readonly<{ name: string; start: number; end: number }>;

/** 输入框里敲它开候选；它不进入正文。 */
export const SKILL_TRIGGER = "$";
/** 正文里的技能标记，扫描、展开与 chip 都认它。 */
export const SKILL_MARK = "📖";

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

export function insertSkill(body: string, range: { start: number; end: number }, name: string) {
  const token = `${skillToken(name)} `;
  return {
    text: body.slice(0, range.start) + token + body.slice(range.end),
    caret: range.start + token.length,
  };
}
