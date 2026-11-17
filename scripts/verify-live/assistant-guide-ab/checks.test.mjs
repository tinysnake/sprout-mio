import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artifacts, cases, checkCase, checkHtml, diagnose } from "./checks.mjs";
const theme = readFileSync(new URL("../../../src/theme.css", import.meta.url), "utf8");

void test("external CDN red → self-contained themed HTML green, with file:line evidence", () => {
  const redFile = fileURLToPath(new URL("fixtures/cdn.html", import.meta.url));
  const red = checkHtml(readFileSync(redFile, "utf8"), theme);
  assert.equal(red.length, 1);
  assert.equal(red[0].rule, "external-url");
  console.log(`RED (expected) ${diagnose(redFile, red[0])}`);
  const greenFile = fileURLToPath(new URL("fixtures/inline.html", import.meta.url));
  assert.deepEqual(checkHtml(readFileSync(greenFile, "utf8"), theme), []);
  console.log(`GREEN PASS ${greenFile}:1 all HTML assertions`);
});

void test("external URLs in HTML/CSS, including numeric entities, CSS escapes and protocol relative links", () => {
  for (const html of [
    '<img src="https://cdn.example/x.png">',
    "<a href='http://example.test/'>x</a>",
    "<img src=https://cdn.example/x.png>",
    "<style>p{background:url(https://cdn.example/a)}</style>",
    '<style>@import "https://cdn.example/a.css";</style>',
    '<style>@import url("https://cdn.example/a.css");</style>',
    '<img src="&#104;ttps://cdn.example/x.png">',
    "<style>p{background:url(\\68 ttps://cdn.example/a)}</style>",
    '<link href="//cdn.example/a.css">',
  ])
    assert(
      checkHtml(html, theme).some((i) => i.rule === "external-url"),
      html,
    );
  assert.deepEqual(
    checkHtml('<img src="data:image/png;base64,eA=="><a href="#chart">chart</a>', theme),
    [],
  );
});

void test("root sizing rejects fixed/viewport heights and permits content-driven roots and fixed chart heights", () => {
  for (const html of [
    "<style>html{height:800px}</style>",
    "<style>@media (width > 400px){body{height:100%}}</style>",
    '<body style="height: 50rem">',
    '<html style="min-height: 10px">',
    "<style>.box{height:100vh}</style>",
    "<style>:root{block-size: 800px}</style>",
  ])
    assert(checkHtml(html, theme).length > 0, html);
  for (const html of [
    "<style>body{height:auto}.chart{height:300px}</style>",
    "<style>body .chart{height:300px}</style>",
    "<style>html, body {height: fit-content}</style>",
  ])
    assert.deepEqual(checkHtml(html, theme), [], html);
});

void test("theme variables resolve definitions, not the guide's shorter list; unknown names fail even with fallback", () => {
  for (const name of [
    "border-soft",
    "card-foreground",
    "primary-foreground",
    "accent-foreground",
    "font-body",
    "font-display",
  ]) {
    assert.deepEqual(checkHtml(`<p style="color:var(--${name})">x</p>`, theme), []);
  }
  assert.equal(
    checkHtml('<p style="color:var(--invented, red)">x</p>', theme)[0].rule,
    "unknown-theme-variable",
  );
});

void test("artifact delivery, plain/intermediate HTML rejection and Unicode prose bounds", () => {
  const report = "已整理。\n```html\n<main>45</main>\n```";
  assert.equal(artifacts(report).length, 1);
  assert.equal(artifacts(report.replaceAll("```", "~~~")).length, 1);
  assert.deepEqual(checkCase(cases[0], report, [report], theme), []);
  assert(
    checkCase(cases[0], "已完成", ["已完成"], theme).some(
      (i) => i.rule === "missing-html-artifact",
    ),
  );
  assert(checkCase(cases[1], report, [report], theme).some((i) => i.rule === "unexpected-html"));
  assert(
    checkCase(cases[1], "45。", ["<div>intermediate</div>", "45。"], theme).some(
      (i) => i.rule === "unexpected-html",
    ),
  );
  assert(checkCase(cases[1], "长".repeat(161), [], theme).some((i) => i.rule === "reply-length"));
  assert.deepEqual(checkCase(cases[1], "总和是 45。", ["总和是 45。"], theme), []);
  assert(
    checkCase(cases[1], "<main>45</main>", ["<main>45</main>"], theme).some(
      (i) => i.rule === "unexpected-html",
    ),
  );
  assert.deepEqual(
    checkCase(cases[1], "参考 <https://example.test>", ["参考 <https://example.test>"], theme),
    [],
  );
  assert.deepEqual(
    checkCase(
      cases[0],
      `已整理。\n\n\`\`\`html\n<main>${"图".repeat(2000)}</main>\n\`\`\``,
      [],
      theme,
    ),
    [],
  );
});
