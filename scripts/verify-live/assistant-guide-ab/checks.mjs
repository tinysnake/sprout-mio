import { readFileSync } from "node:fs";

export const cases = Object.freeze([
  {
    id: "report",
    prompt:
      "把这份数据做成一份 HTML 报告发给我：周一 12、周二 18、周三 15。报告展示趋势和总计；说明文字简短。",
    artifact: true,
    maxChars: 600,
  },
  {
    id: "sentence",
    prompt: "只用一句话告诉我：12、18、15 的总和是多少？",
    artifact: false,
    maxChars: 160,
  },
]);

export function artifacts(text) {
  return [...text.matchAll(/^ {0,3}(`{3,}|~{3,})html[^\n]*\n([\s\S]*?)^ {0,3}\1\s*$/gim)].map(
    (match) => ({ html: match[2], index: match.index + match[0].indexOf("\n") + 1 }),
  );
}
const decode = (value) =>
  value
    .replace(/&#(x[\da-f]+|\d+);?/gi, (_, n) =>
      String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n)),
    )
    .replace(
      /&(?:colon|sol|Tab|NewLine);/g,
      (entity) => ({ "&colon;": ":", "&sol;": "/", "&Tab;": "\t", "&NewLine;": "\n" })[entity],
    )
    .replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex, char) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
    );

export function checkHtml(html, theme) {
  const issues = [];
  const add = (rule, index, evidence) => issues.push({ rule, index, evidence });
  const variables = new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const match of html.matchAll(
    /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|(?:url\s*\(\s*|@import\s+(?!url\s*\())(?:"([^"]*)"|'([^']*)'|([^;)]+))/gi,
  )) {
    const value = decode(match.slice(1).find((part) => part !== undefined) ?? "").trim();
    if (/^(?:https?:)?\/\//i.test(value)) add("external-url", match.index, match[0]);
  }
  for (const match of html.matchAll(/\b100(?:\.0+)?vh\b/gi))
    add("viewport-height", match.index, match[0]);
  for (const match of html.matchAll(/var\s*\(\s*(--[\w-]+)/g)) {
    if (!variables.has(match[1])) add("unknown-theme-variable", match.index, match[1]);
  }
  const heights = (text, offset) => {
    for (const m of text.matchAll(
      /(?:^|[;\s])((?:(?:min|max)-)?(?:height|block-size))\s*:\s*([^;}]+)/gi,
    )) {
      const value = m[2].replace(/!important\s*$/i, "").trim();
      if (!/^(?:auto|initial|unset|inherit|none|min-content|max-content|fit-content)$/i.test(value))
        add("root-fixed-height", offset + m.index, m[0].trim());
    }
  };
  const css = html.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      m[1].split(",").some((selector) =>
        /^(?:html|body|:root)(?=$|[.#:[])/i.test(
          selector
            .trim()
            .split(/[\s>+~]+/)
            .at(-1),
        ),
      )
    )
      heights(m[2], m.index + m[0].indexOf("{") + 1);
  }
  for (const m of html.matchAll(/<(?:html|body)\b[^>]*\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = m[1] ?? m[2];
    heights(decode(value), m.index + m[0].indexOf(value));
  }
  return issues;
}

export function checkCase(test, reply, assistantTexts, theme) {
  const issues = [];
  const found = artifacts(reply);
  if (test.artifact && found.length === 0)
    issues.push({
      rule: "missing-html-artifact",
      index: 0,
      evidence: "Expected a fenced html artifact in persisted final reply",
    });
  for (const block of found)
    for (const issue of checkHtml(block.html, theme))
      issues.push({ ...issue, index: issue.index + block.index });
  if (!test.artifact) {
    for (const text of assistantTexts) {
      const html =
        /```\s*html|~~~\s*html|<!doctype\s+html|<\/?[a-z][a-z0-9-]*(?:\s[^<>]*|\/?)>/i.exec(text);
      if (html)
        issues.push({
          rule: "unexpected-html",
          index: reply.indexOf(html[0]) < 0 ? 0 : reply.indexOf(html[0]),
          evidence: html[0],
        });
    }
  }
  const prose = reply
    .replace(/^ {0,3}(`{3,}|~{3,})html[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gim, "")
    .trim();
  if ([...prose].length > test.maxChars)
    issues.push({
      rule: "reply-length",
      index: 0,
      evidence: `${[...prose].length} code points > ${test.maxChars}`,
    });
  return issues;
}

export function diagnose(file, issue) {
  const text = readFileSync(file, "utf8");
  const line = text.slice(0, issue.index).split("\n").length;
  return `${file}:${line}: FAIL ${issue.rule}: ${issue.evidence.replace(/\n/g, " ")}`;
}
