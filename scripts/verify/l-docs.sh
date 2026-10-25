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
  { pr: 12, merge: '2b814eb', head: 'bf7ffa4', doc: 'chat-dm', script: 'i-chat' },
  { pr: 13, merge: 'da4aebb', head: 'dc11b8a', doc: 'info-hub', script: 'j-info-hub' },
  { pr: 14, merge: 'd8f4e2b', head: '872e62d', doc: 'acceptance', script: 'k-acceptance' },
];
const p3Units = [
  { pr: 19, merge: '34b078e', head: 'dcd1ddd' },
  { pr: 20, merge: 'a73770c', head: '32eac6c' },
  { pr: 21, merge: '0d51b1f', head: 'e51fe69' },
  { pr: 22, merge: '55da85f', head: 'eb4d141' },
  { pr: 23, merge: 'e5e2b4e', head: 'aa41061' },
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
for (const file of fs.globSync('docs/**/*.md')) {
  const text = fs.readFileSync(file, 'utf8');
  const body = withoutFences(text);
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const sections = new Map();
  for (let i = 0; i < headings.length; i++) {
    sections.set(slug(headings[i][1]), body.slice(headings[i].index, headings[i + 1]?.index ?? body.length));
  }
  documents.set(path.resolve(file), { file, text, body, sections });
  for (const match of (file.startsWith('docs/p2/') ? text : '').matchAll(/(?<![\w/])src\/(?:domain|server\/functions|routes|contracts|components)\/[^\s`"'<>),;，。]+/g)) {
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

const plan = fs.readFileSync('docs/development-plan-functional.md', 'utf8');
const stageTable = plan.match(/^## 按依赖安排开发\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
const p2Status = stageTable.split('\n').find((line) => /^\| P2 \|/.test(line))?.split('|')[4]?.trim() ?? '';
check(p2Status.includes('已完成') && linksIn(p2Status).includes('p2/summary.md'), 'P2 stage status must be completed and link to p2/summary.md');
const nextTask = plan.trim().split(/\n\s*\n/).at(-1) ?? '';
check(nextTask.startsWith('当前下一任务是 P4') && /P4[ab]/.test(nextTask) && !/下一任务是\s*P2/.test(plan) && linksIn(nextTask).includes('p3/summary.md#未验证项汇总'), 'final next task must point to P4a or P4b progress with P3 limits and never to P2');
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
  const commands = checkEvidence(boxes[i][2], 'docs/development-plan-functional.md', `P2 checkbox ${i + 1}`);
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
const p3 = plan.match(/^## P3 [^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';
const p3Boxes = [...p3.matchAll(/^- \[([^\]])\] (.+)$/gm)];
const p3States = ['x', ' ', 'x', 'x', 'x', 'x', 'x'];
check(p3Boxes.length === p3States.length, `P3 must contain seven checkboxes, found ${p3Boxes.length}`);
const p3Summary = documents.get(path.resolve('docs/p3/summary.md'));
const p3Acceptance = documents.get(path.resolve('docs/p3/acceptance.md'));
check(Boolean(p3Summary), 'missing docs/p3/summary.md');
check(Boolean(p3Acceptance), 'missing docs/p3/acceptance.md');
const p3Rows = (p3Summary?.sections.get('p3-清单最终状态') ?? '').split('\n').filter((line) => /^\| [1-7]，/.test(line));
check(p3Rows.length === p3States.length, `P3 summary must map seven checkboxes, found ${p3Rows.length}`);
for (let i = 0; i < p3States.length; i++) {
  const box = p3Boxes[i];
  const row = p3Rows.find((line) => line.startsWith(`| ${i + 1}，`)) ?? '';
  check(box?.[1] === p3States[i], `P3 checkbox ${i + 1} must ${i === 1 ? 'remain unchecked' : 'be checked'}`);
  const status = row.split('|')[2]?.trim();
  check(status === (i === 1 ? '未勾选，部分交付' : '已勾选'), `P3 summary checkbox ${i + 1} status differs`);
  check(linksIn(box?.[2] ?? '').some((link) => link.startsWith('p3/')), `P3 checkbox ${i + 1} lacks P3 evidence`);
  check(linksIn(row).some((link) => link.startsWith('acceptance.md#')), `P3 summary checkbox ${i + 1} lacks acceptance evidence`);
}
check(/。部分交付[：:]/.test(p3Boxes[1]?.[2] ?? '') && linksIn(p3Boxes[1]?.[2] ?? '').includes('p3/summary.md#第-2-条部分交付的理由与决定'), 'P3 checkbox 2 must explain partial delivery and link to the decision');
check(p3Summary?.sections.has('第-2-条部分交付的理由与决定') && p3Summary?.sections.has('未验证项汇总') && p3Summary?.sections.has('验收家族与方法'), 'P3 summary lacks decision, limits or acceptance independence');
check(p3Acceptance?.text.includes('未完整交付（部分交付）') && p3Acceptance?.text.includes('store 未损坏'), 'P3 acceptance must retain partial delivery and corrected F2 verdict');
const p3Status = stageTable.split('\n').find((line) => /^\| P3 \|/.test(line))?.split('|')[4]?.trim() ?? '';
check(p3Status.includes('已完成') && p3Status.includes('第 2 条部分交付') && linksIn(p3Status).includes('p3/summary.md'), 'P3 stage status must be completed with partial delivery and summary link');
const p3Completions = records.split('\n').filter((line) => /^\| P3 \|/.test(line));
check(p3Completions.length === 1, `completion table must contain one P3 row, found ${p3Completions.length}`);
const p3Completion = p3Completions[0] ?? '';
check(p3Completion.includes('已完成') && p3Completion.includes('第 2 条部分交付') && linksIn(p3Completion).includes('p3/summary.md'), 'P3 completion lacks status, partial delivery or summary');
const p3Prs = [...p3Completion.matchAll(/PR #(\d+)/g)].map((match) => Number(match[1]));
check(p3Prs.length === p3Units.length && p3Units.every((unit) => p3Prs.includes(unit.pr)), 'P3 completion PR numbers differ from merged units');
const p3UnitTable = p3Summary?.sections.get('各-unit-结论与复跑入口') ?? '';
for (const unit of p3Units) {
  const row = p3UnitTable.split('\n').find((line) => line.includes(`PR #${unit.pr}，`)) ?? '';
  check(row.includes(`head \`${unit.head}\``) && row.includes(`merge \`${unit.merge}\``), `P3 summary lacks PR #${unit.pr} identity`);
  check(p3Completion.includes(`PR #${unit.pr} head \`${unit.head}\` merge \`${unit.merge}\``), `P3 completion lacks PR #${unit.pr} head or merge`);
  check(git('show', '-s', '--format=%s', unit.merge).startsWith(`Merge pull request #${unit.pr} `), `PR #${unit.pr} differs from merge commit title`);
  check(git('rev-parse', `${unit.merge}^2`) === git('rev-parse', unit.head), `PR #${unit.pr} head differs from second merge parent`);
  git('merge-base', '--is-ancestor', unit.merge, 'e5e2b4e');
}
check(completion.includes('P2 最终实现、验收与合入范围 `28d4fb2..db185f8`') && summary?.text.includes('`28d4fb2..db185f8`'), 'P2 final range must end at db185f8 in plan and summary');
check(p3Completion.includes('实现基线 `db185f8`') && p3Completion.includes('`db185f8..e5e2b4e`') && p3Summary?.text.includes('`db185f8..e5e2b4e`'), 'P3 baseline and final range must be db185f8..e5e2b4e in plan and summary');
check(git('show', '-s', '--format=%s', 'db185f8').startsWith('Merge pull request #18 '), 'P2 final commit must match PR #18');
check(git('rev-parse', 'db185f8^2') === git('rev-parse', '6886bfa'), 'P2 final commit must have the verified PR #18 head');
check(git('rev-parse', '34b078e^1') === git('rev-parse', 'db185f8'), 'P3 baseline differs from first merge parent');
const p3Merges = git('log', '--first-parent', '--format=%h', 'db185f8..e5e2b4e').split('\n');
check(p3Merges.join(',') === [...p3Units].reverse().map((unit) => unit.merge).join(','), 'P3 range differs from five recorded Git merges');
git('merge-base', '--is-ancestor', '28d4fb2', 'db185f8');
const commitExists = (sha) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { timeout: 10000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const boxesIn = (section) => [...section.matchAll(/^- \[([ x])\] (.+)$/gm)].map((match) => ({ state: match[1], text: match[2] }));
const sectionOf = (text, heading, level) =>
  text.match(new RegExp(`^${'#'.repeat(level)} ${heading} [^\\n]*\\n([\\s\\S]*?)(?=^${'#'.repeat(level)} |^${'#'.repeat(level - 1)} |$(?![\\s\\S]))`, 'm'))?.[1] ?? '';
const evidenceTargets = (line, source, prefix) =>
  linksIn(line)
    .filter((link) => !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link))
    .map((link) => {
      const [file, fragment = ''] = link.split('#');
      return { file: path.resolve(path.dirname(source), decodeURIComponent(file)), fragment: decodeURIComponent(fragment) };
    })
    .filter((target) => target.file.startsWith(path.resolve(prefix) + path.sep));
const commitPattern = /`([0-9a-f]{7,40})`/g;
const commandPattern = /`(bash scripts\/verify\/[\w-]+\.sh)`/g;
const commitRefsIn = (body) => [...body.matchAll(commitPattern)].map((match) => match[1]);
const requireCommits = (commits, label) => {
  check(commits.length > 0, `${label}: evidence section lacks a Git commit`);
  for (const sha of commits) check(commitExists(sha), `${label}: commit ${sha} does not resolve`);
  totals.commits += commits.length;
};
const commandsInBody = (body, label) => {
  const commands = [...body.matchAll(commandPattern)].map((match) => match[1]);
  check(commands.length > 0, `${label}: evidence section lacks a rerun command`);
  for (const command of commands) {
    totals.commands++;
    check(fs.existsSync(command.slice(5)), `${label}: missing command ${command}`);
  }
};
const evidenceIn = (body, label) => {
  requireCommits(commitRefsIn(body), label);
  commandsInBody(body, label);
};
const resolveEvidence = (line, label, source, prefix) => {
  const evidence = evidenceTargets(line, source, prefix);
  check(evidence.length > 0, `${label}: missing ${prefix} evidence`);
  const targets = [];
  for (const target of evidence) {
    totals.evidence++;
    const document = documents.get(target.file);
    check(Boolean(document), `${label}: missing evidence document ${target.file}`);
    check(Boolean(target.fragment) && Boolean(document?.sections.has(target.fragment)), `${label}: missing evidence section ${target.fragment}`);
    targets.push({ document, body: document?.sections.get(target.fragment) ?? '' });
  }
  return targets;
};
const checkP4aLine = (line, label, source) => {
  for (const { body } of resolveEvidence(line, label, source, 'docs/p4a')) evidenceIn(body, label);
};
// P4b 的五条交付行必须指向 docs/p4b/summary.md 的真实小节。命令按行核验：至少一条
// 被引用的小节必须带可执行的重跑命令；可解析的 Git commit 是 P4b 小结的交付基线，
// 五行共用同一基线，所以按同一证据文档核验。交叉引用的补充小节（如安全边界）
// 只需 fragment 可解析，不必自己再写一份重跑命令。
const p4bEvidenceFile = path.resolve('docs/p4b/summary.md');
const checkP4bLine = (line, label, source) => {
  const targets = resolveEvidence(line, label, source, 'docs/p4b');
  check(targets.some(({ document }) => document && path.resolve(document.file) === p4bEvidenceFile), `${label}: missing docs/p4b/summary.md evidence`);
  const commands = targets.flatMap(({ body }) => [...body.matchAll(commandPattern)].map((match) => match[1]));
  check(commands.length > 0, `${label}: evidence section lacks a rerun command`);
  for (const command of commands) {
    totals.commands++;
    check(fs.existsSync(command.slice(5)), `${label}: missing command ${command}`);
  }
  requireCommits(commitRefsIn(documents.get(p4bEvidenceFile)?.body ?? ''), label);
};
const functional = 'docs/development-plan-functional.md';
const p4 = sectionOf(plan, 'P4', 2);
const p4a = sectionOf(p4, 'P4a', 3);
const p4aBoxes = boxesIn(p4a);
check(p4aBoxes.length === 4, `P4a must contain four checkboxes, found ${p4aBoxes.length}`);
for (let i = 0; i < p4aBoxes.length; i++) {
  if (p4aBoxes[i].state === 'x') checkP4aLine(p4aBoxes[i].text, `P4a checkbox ${i + 1}`, functional);
}
const p4bBoxes = boxesIn(sectionOf(p4, 'P4b', 3));
check(p4bBoxes.length === 5, `P4b must contain five checkboxes, found ${p4bBoxes.length}`);
for (let i = 0; i < p4bBoxes.length; i++) {
  if (p4bBoxes[i].state === 'x') checkP4bLine(p4bBoxes[i].text, `P4b checkbox ${i + 1}`, functional);
}
for (const sub of ['P4c', 'P4d']) {
  const boxes = boxesIn(sectionOf(p4, sub, 3));
  for (const box of boxes) check(box.state === ' ', `${sub} checkbox must remain unchecked: ${box.text}`);
}
const packagePlan = fs.readFileSync('docs/development-plan.md', 'utf8');
const integration = sectionOf(packagePlan, 'I-P4a', 3);
const integrationBoxes = boxesIn(integration);
check(integrationBoxes.length === 4, `I-P4a must contain four checkboxes, found ${integrationBoxes.length}`);
const integrationSummary = documents.get(path.resolve('docs/p4a/summary.md'));
const technicalBox = integrationBoxes[2];
if (technicalBox?.state === 'x') {
  const body = integrationSummary?.sections.get('技术验收证据') ?? '';
  check(Boolean(integrationSummary), 'I-P4a technical acceptance requires docs/p4a/summary.md');
  check(Boolean(body), 'I-P4a technical acceptance requires docs/p4a/summary.md#技术验收证据');
  evidenceIn(body, 'I-P4a technical acceptance');
}
const humanBox = integrationBoxes[3];
if (humanBox?.state === 'x') {
  const body = integrationSummary?.sections.get('human-体验确认') ?? '';
  check(Boolean(integrationSummary), 'I-P4a human acceptance requires docs/p4a/summary.md');
  check(Boolean(body), 'I-P4a human acceptance requires docs/p4a/summary.md#human-体验确认');
  const record = body.match(/^- 确认记录：Human 亲自体验确认通过，版本 `([0-9a-f]{7,40})`$/m)?.[1] ?? '';
  check(Boolean(record), 'I-P4a human acceptance requires an explicit confirmation record');
  check(Boolean(record) && commitExists(record), `I-P4a human acceptance version ${record || '(none)'} does not resolve`);
  check(!/^[-*]\s*待确认/m.test(body), 'I-P4a human acceptance must not treat pending confirmation as confirmed');
}
const integrationP4b = sectionOf(packagePlan, 'I-P4b', 3);
const integrationP4bBoxes = boxesIn(integrationP4b);
check(integrationP4bBoxes.length === 4, `I-P4b must contain four checkboxes, found ${integrationP4bBoxes.length}`);
const p4bSummary = documents.get(path.resolve('docs/p4b/summary.md'));
const p4bTechnicalBox = integrationP4bBoxes[2];
if (p4bTechnicalBox?.state === 'x') {
  const body = p4bSummary?.sections.get('技术验收证据') ?? '';
  check(Boolean(p4bSummary), 'I-P4b technical acceptance requires docs/p4b/summary.md');
  check(Boolean(body), 'I-P4b technical acceptance requires docs/p4b/summary.md#技术验收证据');
  evidenceIn(body, 'I-P4b technical acceptance');
}
const p4bHumanBox = integrationP4bBoxes[3];
if (p4bHumanBox?.state === 'x') {
  const body = p4bSummary?.sections.get('human-体验确认') ?? '';
  check(Boolean(p4bSummary), 'I-P4b human acceptance requires docs/p4b/summary.md');
  check(Boolean(body), 'I-P4b human acceptance requires docs/p4b/summary.md#human-体验确认');
  const record = body.match(/^- 确认记录：Human 亲自体验确认通过，版本 `([0-9a-f]{7,40})`$/m)?.[1] ?? '';
  check(Boolean(record), 'I-P4b human acceptance requires an explicit confirmation record');
  check(Boolean(record) && commitExists(record), `I-P4b human acceptance version ${record || '(none)'} does not resolve`);
  check(!/^[-*]\s*待确认/m.test(body), 'I-P4b human acceptance must not treat pending confirmation as confirmed');
}
for (const stage of ['I-P4c', 'I-P4d', 'I-P5a', 'I-P5b', 'I-P6', 'I-P7']) {
  const boxes = boxesIn(sectionOf(packagePlan, stage, 3));
  check(boxes.length > 0, `${stage} checklist missing`);
  for (const box of boxes) check(box.state === ' ', `${stage} checkbox must remain unchecked: ${box.text}`);
}
const uiPlan = fs.readFileSync('docs/development-plan-ui.md', 'utf8');
const uiP4bBoxes = boxesIn(sectionOf(uiPlan, 'UI-P4b', 2));
check(uiP4bBoxes.length === 3, `UI-P4b must contain three checkboxes, found ${uiP4bBoxes.length}`);
for (let i = 0; i < uiP4bBoxes.length; i++) {
  if (uiP4bBoxes[i].state === 'x') checkP4bLine(uiP4bBoxes[i].text, `UI-P4b checkbox ${i + 1}`, 'docs/development-plan-ui.md');
}
for (const stage of ['UI-P4c', 'UI-P4d', 'UI-P5a', 'UI-P5b', 'UI-P6', 'UI-P7']) {
  const boxes = boxesIn(sectionOf(uiPlan, stage, 2));
  check(boxes.length > 0, `${stage} checklist missing`);
  for (const box of boxes) check(box.state === ' ', `${stage} checkbox must remain unchecked: ${box.text}`);
}
let futureCount = 0;
for (const stage of ['P5', 'P6', 'P7', 'P8', 'R1']) {
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
console.log('PASS P2 stage status is completed with summary link; final next task points to P4 with P3 limits');
console.log('PASS P3 seven checkboxes and summary states match: six checked, checkbox 2 unchecked with partial delivery');
console.log('PASS P3 summary, acceptance, stage status and completion record; PR #19 to #22 match Git titles and second parents');
console.log('PASS P2 final range 28d4fb2..db185f8 and P3 range db185f8..e5e2b4e match Git baselines and merges');
console.log(`PASS P4a accepts evidence-linked commits and commands; unchecked=${p4aBoxes.filter((box) => box.state !== 'x').length}`);
console.log(`PASS P4b and UI-P4b accept checked rows with resolvable evidence; functional checked=${p4bBoxes.filter((box) => box.state === 'x').length} ui checked=${uiP4bBoxes.filter((box) => box.state === 'x').length} integration checked=${integrationP4bBoxes.filter((box) => box.state === 'x').length}`);
console.log('PASS P4c, P4d and later checkboxes remain unchecked in functional, plan and UI documents');
console.log(`PASS P5 to P8 and R1 checkboxes remain unchecked=${futureCount}`);
console.log(`PASS external HTTP links declared only, no network requests; P2 links=${totals.external}`);
console.log('PASS l-docs all checks passed');
NODE
