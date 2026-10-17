#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
bash scripts/verify/f-docs.sh
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const units = [
  { pr: 10, merge: '6836b06', head: 'cfa5d4d', doc: 'identity-data', script: 'g-identity-data' },
  { pr: 11, merge: '53c9cb7', head: 'fdad1ca', doc: 'project-agents', script: 'h-project-agents' },
  { pr: 12, merge: '2b814eb', head: 'bf7ffa4', doc: 'conversation-dm', script: 'i-conversation' },
  { pr: 13, merge: 'da4aebb', head: 'dc11b8a', doc: 'info-hub', script: 'j-info-hub' },
  { pr: 14, merge: 'd8f4e2b', head: '872e62d', doc: 'acceptance', script: 'k-acceptance' },
];
const failures = [];
const totals = { paths: 0, commands: 0, evidence: 0, commits: 0, external: 0 };
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    check(false, `git ${args.join(' ')} failed`);
    return '';
  }
};
const slug = (heading) => heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/ /g, '-');
const withoutFences = (text) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
const documents = new Map();
for (const file of fs.globSync('docs/p2/*.md')) {
  const text = fs.readFileSync(file, 'utf8');
  const body = withoutFences(text);
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const sections = new Map();
  for (let i = 0; i < headings.length; i++) {
    sections.set(slug(headings[i][1]), body.slice(headings[i].index, headings[i + 1]?.index ?? body.length));
  }
  documents.set(path.resolve(file), { file, text, body, sections });
  for (const match of text.matchAll(/(?<![\w/])src\/(?:domain|server\/functions|routes|contracts|components)\/[^\s`"'<>),;，。]+/g)) {
    const token = match[0];
    totals.paths++;
    check(token.includes('*') ? fs.globSync(token).length > 0 : fs.existsSync(token), `${file}: missing source path ${token}`);
  }
  totals.external += [...body.matchAll(/\]\(https?:\/\/[^\s)]+\)/g)].length;
}
const linksIn = (text) => [...text.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?\)/g)].map((match) => match[1]);
const commandsIn = (text) => [...text.matchAll(/`(bash scripts\/verify\/[\w-]+\.sh)`/g)].map((match) => match[1]);
const checkEvidence = (text, source, label) => {
  const evidence = linksIn(text).filter((link) => !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)).map((link) => {
    const [file, fragment = ''] = link.split('#');
    return { file: path.resolve(path.dirname(source), decodeURIComponent(file)), fragment: decodeURIComponent(fragment) };
  }).filter((target) => target.file.startsWith(path.resolve('docs/p2') + path.sep));
  check(evidence.length > 0, `${label}: missing P2 document evidence`);
  for (const target of evidence) {
    totals.evidence++;
    check(fs.existsSync(target.file), `${label}: missing document ${target.file}`);
    check(Boolean(target.fragment) && documents.get(target.file)?.sections.has(target.fragment), `${label}: missing evidence section ${target.fragment}`);
  }
  const commands = commandsIn(text);
  check(commands.length > 0, `${label}: missing rerun command`);
  for (const command of commands) {
    totals.commands++;
    check(fs.existsSync(command.slice(5)), `${label}: missing command ${command}`);
    check(evidence.some((target) => documents.get(target.file)?.text.includes(command)), `${label}: evidence documents lack ${command}`);
  }
  return commands;
};

const plan = fs.readFileSync('docs/development-plan.md', 'utf8');
const stageTable = plan.match(/^## 按依赖安排开发\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
const p2Status = stageTable.split('\n').find((line) => /^\| P2 \|/.test(line))?.split('|')[4]?.trim() ?? '';
check(p2Status.includes('已完成') && linksIn(p2Status).includes('p2/summary.md'), 'P2 stage status must be completed and link to p2/summary.md');
const nextTask = plan.trim().split(/\n\s*\n/).at(-1) ?? '';
check(nextTask.startsWith('当前下一任务是 P3') && !/下一任务是\s*P2/.test(plan), 'final next task must point to P3 and never to P2');
const p2 = plan.match(/^## P2 [^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
const boxes = [...p2.matchAll(/^- \[([^\]])\] (.+)$/gm)];
check(boxes.length === 6, `P2 must contain six checkboxes, found ${boxes.length}`);
const summary = documents.get(path.resolve('docs/p2/summary.md'));
check(Boolean(summary), 'missing docs/p2/summary.md');
const checklist = summary?.sections.get('p2-清单证据对照') ?? '';
const rows = checklist.split('\n').filter((line) => /^\| [1-6]，/.test(line));
check(rows.length === 6, `summary must map six checkboxes, found ${rows.length}`);
for (let i = 0; i < boxes.length; i++) {
  check(boxes[i][1] === 'x', `P2 checkbox ${i + 1} must be checked`);
  const row = rows.find((line) => line.startsWith(`| ${i + 1}，`)) ?? '';
  check(row.includes('| 已勾选 |'), `summary checkbox ${i + 1} must be checked`);
  const commands = checkEvidence(boxes[i][2], 'docs/development-plan.md', `P2 checkbox ${i + 1}`);
  checkEvidence(row, 'docs/p2/summary.md', `summary checkbox ${i + 1}`);
  for (const command of commands) check(row.includes(`\`${command}\``), `summary checkbox ${i + 1} lacks ${command}`);
}
const exits = summary?.sections.get('p2-出口条件对照') ?? '';
const exitNames = ['重启后同一对话仍对应同一分身', '消息与配置保留', '两个 Project 的上下文与查询边界可验证'];
const exitRows = exits.split('\n').filter((line) => /^\| (?:重启后|消息与配置|两个 Project)/.test(line));
check(exitRows.length === 3, `summary must map three exit conditions, found ${exitRows.length}`);
for (const name of exitNames) {
  const row = exitRows.find((line) => line.split('|')[1]?.trim() === name) ?? '';
  check(Boolean(row), `missing exit condition ${name}`);
  checkEvidence(row, 'docs/p2/summary.md', `exit condition ${name}`);
}
const unitTable = summary?.sections.get('各-unit-结论与复跑入口') ?? '';
for (const unit of units) {
  const row = unitTable.split('\n').find((line) => line.includes(`PR #${unit.pr}，`)) ?? '';
  check(row.includes(`head \`${unit.head}\``) && row.includes(`merge \`${unit.merge}\``), `summary lacks PR #${unit.pr} identity`);
  check(row.includes(`${unit.doc}.md#`) && row.includes(`bash scripts/verify/${unit.script}.sh`), `summary lacks PR #${unit.pr} evidence or rerun command`);
  checkEvidence(row, 'docs/p2/summary.md', `unit PR #${unit.pr}`);
}
check(summary?.sections.has('未验证项汇总'), 'summary lacks unverified limits');

const records = plan.match(/^## 分派任务并管理完成记录\n([\s\S]*)/m)?.[1] ?? '';
const completionRows = records.split('\n').filter((line) => /^\| P2 \|/.test(line));
check(completionRows.length === 1, `completion table must contain one P2 row, found ${completionRows.length}`);
const completion = completionRows[0] ?? '';
check(completion.includes('已完成') && completion.includes('`28d4fb2..d8f4e2b`'), 'P2 completion lacks status or commit range');
check(completion.includes('真实 Chromium') && completion.includes('重启') && completion.includes('两用户隔离'), 'P2 completion lacks verification scope');
check(/https:\/\/github\.com\/tinysnake\/sprout-mio\/actions\/runs\/\d+/.test(completion) && completion.includes('success'), 'P2 completion lacks CI URL or conclusion');
check(linksIn(completion).includes('p2/summary.md'), 'P2 completion lacks summary link');
for (const match of completion.matchAll(/`([0-9a-f]{7,40})(?:\.\.([0-9a-f]{7,40}))?`/g)) {
  for (const sha of match.slice(1).filter(Boolean)) {
    git('cat-file', '-e', `${sha}^{commit}`);
    totals.commits++;
  }
}
const recordedPrs = [...completion.matchAll(/PR #(\d+)/g)].map((match) => Number(match[1]));
check(recordedPrs.length === units.length && units.every((unit) => recordedPrs.includes(unit.pr)), 'P2 completion PR numbers differ from merged units');
for (const unit of units) {
  check(completion.includes(`PR #${unit.pr} head \`${unit.head}\` merge \`${unit.merge}\``), `P2 completion lacks PR #${unit.pr} head or merge`);
  const subject = git('show', '-s', '--format=%s', unit.merge);
  check(subject.startsWith(`Merge pull request #${unit.pr} `), `PR #${unit.pr} differs from merge commit title`);
  check(git('rev-parse', `${unit.merge}^2`) === git('rev-parse', unit.head), `PR #${unit.pr} head differs from second merge parent`);
  git('merge-base', '--is-ancestor', unit.merge, 'd8f4e2b');
}
check(git('rev-parse', '6836b06^1') === git('rev-parse', '28d4fb2'), 'P2 implementation baseline differs from first merge parent');
let futureCount = 0;
for (const stage of ['P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'R1']) {
  const section = plan.match(new RegExp(`^## ${stage} [^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
  const futureBoxes = [...section.matchAll(/^- \[([^\]])\] /gm)];
  check(futureBoxes.length > 0, `${stage} checklist missing`);
  for (const box of futureBoxes) check(box[1] === ' ', `${stage} checkbox must remain unchecked: ${box[0]}`);
  futureCount += futureBoxes.length;
}
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`FAIL l-docs ${failures.length} checks failed`);
  process.exit(1);
}
console.log(`PASS six P2 checklist entries checked with document sections and commands; summary rows=${rows.length}`);
console.log(`PASS three P2 exit conditions and five unit mappings; evidence=${totals.evidence} commands=${totals.commands}`);
console.log(`PASS P2 source paths=${totals.paths}; docs internal links and anchors verified by f-docs`);
console.log(`PASS P2 completion PR #10 to #14 match Git merge titles and head parents; commit references=${totals.commits}`);
console.log('PASS P2 stage status is completed with summary link; final next task points to P3');
console.log(`PASS P3 to P8 and R1 checkboxes remain unchecked=${futureCount}`);
console.log(`PASS external HTTP links declared only, no network requests; P2 links=${totals.external}`);
console.log('PASS l-docs all checks passed');
NODE
