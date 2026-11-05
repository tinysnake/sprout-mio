export type SkillToken = Readonly<{ name: string; start: number; end: number }>;

export function isSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && !/[\s【】\u0000-\u001f\u007f]/u.test(name);
}

export function scanSkillTokens(body: string): readonly SkillToken[] {
  return [...body.matchAll(/【技能:([^【】\s]+)】/gu)]
    .filter((match) => isSkillName(match[1]))
    .map((match) => ({ name: match[1], start: match.index, end: match.index + match[0].length }));
}

export function skillQueryAt(body: string, caret: number) {
  if (scanSkillTokens(body).some((span) => caret > span.start && caret < span.end)) return null;
  const match = /(?:^|\s)#([^\s#【】]*)$/u.exec(body.slice(0, caret));
  return match ? { query: match[1], start: caret - match[1].length - 1, end: caret } : null;
}

export function insertSkill(body: string, range: { start: number; end: number }, name: string) {
  if (!isSkillName(name)) throw new Error("无法表示的技能名称");
  const token = `【技能:${name}】 `;
  return { text: body.slice(0, range.start) + token + body.slice(range.end), caret: range.start + token.length };
}
