#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const documents = new Map();
const failures = [];
const totals = { links: 0, paths: 0, generated: 0, templates: 0, absent: 0 };
const generated = /^(?:\.verify|\.output|dist|data|node_modules|\.tanstack)\//;
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const slug = (heading) => heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
const withoutFences = (text) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');

for (const file of fs.globSync('docs/**/*.md')) {
  const text = fs.readFileSync(file, 'utf8');
  const body = withoutFences(text);
  const sections = new Map();
  const duplicates = new Map();
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const base = slug(heading[1]);
    const count = duplicates.get(base) ?? 0;
    duplicates.set(base, count + 1);
    sections.set(count ? `${base}-${count}` : base, body.slice(heading.index, headings[i + 1]?.index ?? body.length));
  }
  for (const anchor of body.matchAll(/<(?:a|[a-z]+)\s+[^>]*id=["']([^"']+)["'][^>]*>/g)) sections.set(anchor[1], body);
  documents.set(path.resolve(file), { file, text, body, sections });
}

const linksIn = (body) => {
  const definitions = new Map([...body.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)].map((match) => [match[1].toLowerCase(), match[2]]));
  const links = [...body.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\)/g)].map((match) => match[1]);
  for (const match of body.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const key = (match[2] || match[1]).toLowerCase();
    check(definitions.has(key), `undefined reference link [${key}]`);
    if (definitions.has(key)) links.push(definitions.get(key));
  }
  return [...links, ...definitions.values()];
};

const resolveLink = (source, link) => {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) return null;
  const [target, fragment = ''] = link.split('#');
  return { file: path.resolve(path.dirname(source), decodeURIComponent(target.split('?')[0])), fragment: decodeURIComponent(fragment) };
};

for (const [source, doc] of documents) {
  for (const link of linksIn(doc.body)) {
    const target = resolveLink(source, link);
    if (!target) continue;
    totals.links++;
    check(fs.existsSync(target.file), `${doc.file}: missing link ${link}`);
    if (target.fragment && documents.has(target.file)) {
      check(documents.get(target.file).sections.has(target.fragment), `${doc.file}: missing section ${link}`);
    }
  }
  if (!doc.file.startsWith('docs/p1/')) continue;
  for (const match of doc.body.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1];
    if (!/^(?:src|scripts|tests|docs|experiments|drizzle|\.github|\.verify|\.output|dist|data|node_modules|\.tanstack)\//.test(token) || /\s/.test(token)) continue;
    if (generated.test(token)) { totals.generated++; continue; }
    if (/<(?:feature|unit)>/.test(token)) { totals.templates++; continue; }
    const exists = token.includes('*') ? fs.globSync(token).length > 0 : ['', '.ts', '.tsx', '.js', '.mjs'].some((extension) => fs.existsSync(token + extension));
    const start = doc.body.lastIndexOf('\n\n', match.index);
    const end = doc.body.indexOf('\n\n', match.index);
    const paragraph = doc.body.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
    if (!exists && /不存在|未创建|没有创建/.test(paragraph)) { totals.absent++; continue; }
    totals.paths++;
    check(exists, `${doc.file}: missing repository path ${token}`);
  }
}

const plan = fs.readFileSync('docs/development-plan.md', 'utf8');
const p1 = plan.match(/^## P1 [^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
const boxes = [...p1.matchAll(/^- \[([ x])\] (.+)$/gm)];
check(boxes.length === 7, `P1 must contain seven checkboxes, found ${boxes.length}`);
const summary = documents.get(path.resolve('docs/p1/summary.md'));
check(Boolean(summary), 'missing docs/p1/summary.md');
const rows = (summary?.text ?? '').split('\n').filter((line) => /^\| [1-7]，/.test(line));
check(rows.length === 7, `summary must map seven checkboxes, found ${rows.length}`);

for (let i = 0; i < boxes.length; i++) {
  const checked = boxes[i][1] === 'x';
  const line = boxes[i][2];
  const row = rows.find((candidate) => candidate.startsWith(`| ${i + 1}，`)) ?? '';
  check(row.includes(checked ? '已勾选' : '未勾选'), `summary status differs for checkbox ${i + 1}`);
  if (!checked) continue;
  const evidence = linksIn(line).map((link) => resolveLink(path.resolve('docs/development-plan.md'), link)).filter((target) => target && target.file.startsWith(path.resolve('docs/p1') + path.sep) && target.fragment);
  check(evidence.length > 0, `checkbox ${i + 1} lacks a P1 document section`);
  const commands = [...line.matchAll(/`(bash scripts\/verify\/(?:[\w-]+\.sh)|bash scripts\/verify\.sh)`/g)].map((match) => match[1]);
  check(commands.length > 0, `checkbox ${i + 1} lacks a rerun command`);
  for (const command of commands) {
    check(fs.existsSync(command.slice(5)), `checkbox ${i + 1}: missing command file ${command}`);
    check(row.includes(`\`${command}\``), `checkbox ${i + 1}: summary lacks ${command}`);
    check(evidence.some((target) => documents.get(target.file)?.sections.get(target.fragment)?.includes(command)), `checkbox ${i + 1}: evidence section lacks ${command}`);
  }
}

check(/^\| P1 \|.*已完成/m.test(plan) === (boxes.length === 7 && boxes.every((box) => box[1] === 'x')), 'P1 stage status differs from checklist');
check(/^\| P1 \|.*919ce92\.\.c3af8ad.*真实跨机.*真实 macOS Worker.*P4/m.test(plan), 'P1 completion row lacks commit range or P4 limits');
for (const file of ['docs/p1/skeleton.md', 'docs/p1/conventions.md']) {
  const text = fs.readFileSync(file, 'utf8');
  check(text.includes('BETTER_AUTH_SECRET') && text.includes('p1-d-runtime') && text.includes('监听前') && text.includes('至少 32 字符'), `${file}: final auth secret requirement missing`);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`FAIL f-docs ${failures.length} checks failed`);
  process.exit(1);
}
console.log(`PASS seven P1 checklist entries have section and command evidence; checked=${boxes.filter((box) => box[1] === 'x').length}`);
console.log(`PASS docs internal links and anchors=${totals.links}; docs/link is represented by the docs link scan`);
console.log(`PASS P1 repository paths=${totals.paths}; generated=${totals.generated}; templates=${totals.templates}; documented absent=${totals.absent}`);
console.log('PASS P1 summary, completion range, stage status and final auth secret requirements');
console.log('PASS f-docs all checks passed');
NODE
