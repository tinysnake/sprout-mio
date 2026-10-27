#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base="${PROBE_BASE:-$(git -C "$root" rev-parse --verify --quiet main || git -C "$root" rev-parse HEAD)}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/l-docs-probes.XXXXXX")"
tree="$tmp/tree"
cleanup() {
  git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git -C "$root" worktree add --detach "$tree" "$base" >/dev/null 2>&1
rm -rf "$tree/docs" "$tree/scripts" "$tree/.agents"
cp -R "$root/docs" "$root/scripts" "$root/.agents" "$tree/"

PROBE_TREE="$tree" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const tree = process.env.PROBE_TREE;
const head = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
const functional = 'docs/development-plan-functional.md';
const packagePlan = 'docs/development-plan.md';
const uiPlan = 'docs/development-plan-ui.md';
const summary = 'docs/p4a/summary.md';
const probe = 'docs/p4a/probe.md';
const p4bSummary = 'docs/p4b/summary.md';
const p4cSummary = 'docs/p4c/summary.md';
const r1Summary = 'docs/r1/summary.md';
const files = [functional, packagePlan, uiPlan, summary, probe, p4bSummary, p4cSummary, r1Summary];
const originals = new Map(files.map((file) => [file, fs.existsSync(path.join(tree, file)) ? fs.readFileSync(path.join(tree, file), 'utf8') : null]));
const restore = () => {
  for (const [file, text] of originals) {
    const target = path.join(tree, file);
    if (text === null) fs.rmSync(target, { force: true });
    else fs.writeFileSync(target, text);
  }
};
const read = (file) => fs.readFileSync(path.join(tree, file), 'utf8');
const write = (file, text) => fs.writeFileSync(path.join(tree, file), text);
const within = (lines, heading) => {
  const start = lines.findIndex((line) => line.startsWith(`${heading} `));
  if (start < 0) throw new Error(`probe could not find heading ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  for (let index = start + 1; index < lines.length; index++) {
    const marker = lines[index].match(/^(#+) /);
    if (marker && marker[1].length <= level) return [start, index];
  }
  return [start, lines.length];
};
const setBox = (file, prefix, text, heading, state = 'x') => {
  const lines = read(file).split('\n');
  const [start, end] = heading ? within(lines, heading) : [0, lines.length];
  const index = lines.findIndex((line, position) => position >= start && position < end && /^- \[[ x]\] /.test(line) && line.slice(6).startsWith(prefix));
  if (index < 0) throw new Error(`probe could not find ${prefix} in ${file}`);
  lines[index] = `- [${state}] ${text}`;
  write(file, lines.join('\n'));
};
const evidence = (section, commit, command) => `# Probe 证据\n\n## ${section}\n\n实现提交 \`${commit}\`，重跑 \`${command}\`。\n`;
const acceptance = (human) =>
  `# I-P4a 验收摘要\n\n## 交付范围\n\n章节范围。\n\n## 体验后变更\n\nHuman 体验反馈改变的领域决定。\n\n## 功能交付证据\n\n功能基线 \`${head}\`，重跑 \`bash scripts/verify/s-machine-contracts.sh\`。\n\n## 技术验收证据\n\n独立验收基线 \`${head}\`，重跑 \`bash scripts/verify/s-machine-contracts.sh\`。\n\n## human-体验确认\n\n${human}\n`;
const p4bHuman = (line) => {
  const file = path.join(tree, p4bSummary);
  fs.writeFileSync(file, read(p4bSummary).replace('## Human 体验确认\n', `## Human 体验确认\n\n${line}\n`));
};
// 探针必须自己制造「已勾选但没有确认记录」的状态。真实文档可能已经带了合法的
// 确认记录，只勾选 checkbox 无法再触发该校验，探针就会假通过。
const p4bHumanNoRecord = () => {
  const file = path.join(tree, p4bSummary);
  fs.writeFileSync(
    file,
    read(p4bSummary).replace(/^- 确认记录：Human 亲自体验确认通过，版本 `[0-9a-f]{7,40}`$/gm, ''),
  );
};
const p4bSection = (heading, line) => {
  fs.writeFileSync(path.join(tree, p4bSummary), read(p4bSummary).replace(`### ${heading}\n`, `### ${heading}\n\n${line}\n`));
};
const p4cHuman = (line) => {
  const file = path.join(tree, p4cSummary);
  fs.writeFileSync(file, read(p4cSummary).replace('## Human 体验确认\n', `## Human 体验确认\n\n${line}\n`));
};
const p4cHumanBox = () =>
  setBox(packagePlan, 'Human 亲自体验并明确确认通过', 'Human 亲自体验并明确确认通过，编排者已记录确认版本。', '### I-P4c');
const humanBox = () =>
  setBox(packagePlan, 'Human 亲自体验并明确确认通过', 'Human 亲自体验并明确确认通过，编排者已记录确认版本。', '### I-P4b');
const link = '证据见 [P4a 证据](p4a/probe.md#p4a-证据)。';
const p4bLink = '证据见 [申请释放与互斥](p4b/summary.md#1-申请释放与互斥)。';
const p4bLink5 = '证据见 [Project 独立](p4b/summary.md#5-跨-project-独立与不可见)。';
const gate = () => {
  const run = spawnSync('bash', ['scripts/verify/l-docs.sh'], { cwd: tree, encoding: 'utf8', timeout: 180000 });
  return { code: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
};

const failures = [];
const cases = [];
const probeCase = (name, mutate, expectation) => {
  restore();
  mutate();
  const result = gate();
  const passed = expectation.code === 0 ? result.code === 0 : result.code !== 0 && result.output.includes(expectation.includes);
  cases.push({ name, code: result.code, passed });
  if (!passed) failures.push(`${name}: exit ${result.code}, expected ${expectation.code === 0 ? 'success' : `failure containing "${expectation.includes}"`}\n${result.output.trim()}`);
};

probeCase('current docs pass', () => {}, { code: 0 });
probeCase('checked P4a without evidence fails', () => {
  setBox(functional, '实现 macOS Worker 安装与启动', '临时探针勾选，没有章节证据。');
}, { code: 1, includes: 'P4a checkbox 1: missing docs/p4a evidence' });
probeCase('broken evidence link fails', () => {
  setBox(functional, '实现 macOS Worker 安装与启动', '证据见 [P4a 契约](p4a/contracts.md#不存在的章节)。');
}, { code: 1, includes: '不存在的章节' });
probeCase('unresolved commit fails', () => {
  write(probe, evidence('P4a 证据', 'deadbeef', 'bash scripts/verify/s-machine-contracts.sh'));
  setBox(functional, '实现 macOS Worker 安装与启动', link);
}, { code: 1, includes: 'P4a checkbox 1: commit deadbeef does not resolve' });
probeCase('human confirmation without a record fails', () => {
  write(summary, acceptance(`- 待确认：等待 Human 体验，版本 \`${head}\`。`));
  setBox(packagePlan, 'Human 亲自体验并明确确认通过', 'Human 亲自体验并明确确认通过，编排者已记录确认版本。', '### I-P4a');
}, { code: 1, includes: 'I-P4a human acceptance requires an explicit confirmation record' });
probeCase('unchecked P4b stays legal', () => {
  for (const prefix of ['实现申请与释放', '以分身为 holder', '实现 shell、文件与进程操作', '保留宿主工具的原有行为', '验证不同 Projects']) {
    setBox(functional, prefix, '章节尚未开工，保持未勾选。', '### P4b', ' ');
  }
  for (const prefix of ['完成租约与 holder', '展示远端 shell', '在 Chat、Machine 详情']) {
    setBox(uiPlan, prefix, '章节尚未开工，保持未勾选。', '## UI-P4b', ' ');
  }
}, { code: 0 });
probeCase('checked R1 without evidence fails', () => {
  setBox(functional, '在 P4 的身份与授权契约稳定后', '临时探针勾选 R1，没有章节证据。', '## R1');
}, { code: 1, includes: 'R1 checkbox 1: missing docs/r1 evidence' });
probeCase('checked R1 evidence with an unresolved commit fails', () => {
  const file = r1Summary;
  write(file, read(file).replace('## 验收证据与复跑\n', '## 验收证据与复跑\n\n提交 `deadbeef`。\n'));
}, { code: 1, includes: 'R1 checkbox 1: commit deadbeef does not resolve' });
probeCase('checked R1 evidence without a rerun command fails', () => {
  const file = r1Summary;
  write(file, read(file).replace(/`bash scripts\/verify\/z3-mcp-acceptance\.sh`/g, '`bash scripts/verify/nope.sh`'));
}, { code: 1, includes: 'R1 checkbox 1: missing command bash scripts/verify/nope.sh' });
probeCase('checked R1 evidence from another chapter fails', () => {
  setBox(functional, '在 P4 的身份与授权契约稳定后', '证据见 [P4a 验收](p4a/summary.md#技术验收证据)，重跑 `bash scripts/verify/z3-mcp-acceptance.sh`。', '## R1');
}, { code: 1, includes: 'R1 checkbox 1: missing docs/r1 evidence' });
probeCase('checked P4b without evidence fails', () => {
  setBox(functional, '实现申请与释放', '临时探针勾选 P4b，没有章节证据。');
}, { code: 1, includes: 'P4b checkbox 1: missing docs/p4b evidence' });
probeCase('P4b evidence from another chapter fails', () => {
  setBox(functional, '实现申请与释放', '证据见 [P4a 验收](p4a/summary.md#技术验收证据)。');
}, { code: 1, includes: 'P4b checkbox 1: missing docs/p4b/summary.md evidence' });
probeCase('complete P4b evidence passes', () => {
  setBox(functional, '实现申请与释放', p4bLink);
}, { code: 0 });
probeCase('P4b evidence with an unresolved commit fails', () => {
  p4bSection('1. 申请、释放与互斥', '实现提交 `deadbeef`。');
  setBox(functional, '实现申请与释放', p4bLink);
}, { code: 1, includes: 'P4b checkbox 1: commit deadbeef does not resolve' });
probeCase('P4b delivery section without a commit fails', () => {
  const lines = read(p4bSummary).split('\n');
  const start = lines.findIndex((line) => line === '### 5. 跨 Project 独立与不可见');
  if (start < 0) throw new Error('probe could not find the P4b cross-project delivery section');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,3} /.test(lines[index])) {
      end = index;
      break;
    }
  }
  let stripped = false;
  for (let index = start + 1; index < end; index++) {
    const next = lines[index].replace(/`[0-9a-f]{7,40}`/g, '占位');
    if (next !== lines[index]) stripped = true;
    lines[index] = next;
  }
  if (!stripped) throw new Error('probe could not find a commit reference in the P4b cross-project delivery section');
  write(p4bSummary, lines.join('\n'));
  setBox(functional, '验证不同 Projects', p4bLink5);
}, { code: 1, includes: 'P4b checkbox 5: evidence section lacks a Git commit' });
probeCase('P4b delivery section with an unresolvable commit fails', () => {
  const lines = read(p4bSummary).split('\n');
  const start = lines.findIndex((line) => line === '### 5. 跨 Project 独立与不可见');
  if (start < 0) throw new Error('probe could not find the P4b cross-project delivery section');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,3} /.test(lines[index])) {
      end = index;
      break;
    }
  }
  let replaced = false;
  for (let index = start + 1; index < end; index++) {
    const next = lines[index].replace(/`[0-9a-f]{7,40}`/g, replaced ? '$&' : '`deadbeef`');
    if (next !== lines[index]) replaced = true;
    lines[index] = next;
  }
  if (!replaced) throw new Error('probe could not find a commit reference in the P4b cross-project delivery section');
  write(p4bSummary, lines.join('\n'));
  setBox(functional, '验证不同 Projects', p4bLink5);
}, { code: 1, includes: 'P4b checkbox 5: commit deadbeef does not resolve' });
probeCase('checked P4c without evidence fails', () => {
  setBox(functional, '实现稳定请求 ID', '临时探针勾选 P4c，没有章节证据。', '### P4c');
}, { code: 1, includes: 'P4c checkbox 1: missing docs/p4c evidence' });
probeCase('P4c evidence from another chapter fails', () => {
  setBox(functional, '实现稳定请求 ID', '证据见 [P4b 验收](p4b/summary.md#技术验收证据)。', '### P4c');
}, { code: 1, includes: 'P4c checkbox 1: missing docs/p4c/summary.md evidence' });
const p4cLink = '证据见 [稳定标识与取消](p4c/summary.md#1-稳定请求-id执行-id日志游标状态退出结果和显式取消)。';
probeCase('complete P4c evidence passes', () => {
  setBox(functional, '实现稳定请求 ID', p4cLink, '### P4c');
}, { code: 0 });
probeCase('P4c evidence with an unresolved commit fails', () => {
  const file = path.join(tree, p4cSummary);
  fs.writeFileSync(
    file,
    read(p4cSummary).replace(
      '### 1. 稳定请求 ID、执行 ID、日志游标、状态、退出结果和显式取消\n',
      '### 1. 稳定请求 ID、执行 ID、日志游标、状态、退出结果和显式取消\n\n实现提交 `deadbeef`。\n',
    ),
  );
  setBox(functional, '实现稳定请求 ID', p4cLink, '### P4c');
}, { code: 1, includes: 'P4c checkbox 1: commit deadbeef does not resolve' });
probeCase('I-P4c technical acceptance without a summary fails', () => {
  fs.rmSync(path.join(tree, p4cSummary), { force: true });
  setBox(packagePlan, '集成线完成接入与自检', '集成线完成接入与自检，独立技术验收通过。', '### I-P4c');
}, { code: 1, includes: 'I-P4c technical acceptance requires docs/p4c/summary.md' });
probeCase('I-P4c human confirmation without a record fails', () => {
  const file = path.join(tree, p4cSummary);
  fs.writeFileSync(file, read(p4cSummary).replace(/^Human 尚未亲自体验.*$/gm, ''));
  p4cHumanBox();
}, { code: 1, includes: 'I-P4c human acceptance requires an explicit confirmation record' });
probeCase('I-P4c recorded human confirmation passes', () => {
  p4cHuman(`- 确认记录：Human 亲自体验确认通过，版本 \`${head}\``);
  p4cHumanBox();
}, { code: 0 });
probeCase('checked I-P4b technical acceptance passes', () => {
  setBox(packagePlan, '集成线完成接入与自检', '集成线完成接入与自检，独立技术验收通过。', '### I-P4b');
}, { code: 0 });
probeCase('I-P4b human confirmation without a record fails', () => {
  p4bHumanNoRecord();
  humanBox();
}, { code: 1, includes: 'I-P4b human acceptance requires an explicit confirmation record' });
probeCase('I-P4b pending confirmation does not count as confirmed', () => {
  p4bHuman(`- 待确认：等待 Human 体验，版本 \`${head}\`。`);
  humanBox();
}, { code: 1, includes: 'I-P4b human acceptance must not treat pending confirmation as confirmed' });
probeCase('I-P4b recorded human confirmation passes', () => {
  p4bHuman(`- 确认记录：Human 亲自体验确认通过，版本 \`${head}\``);
  humanBox();
}, { code: 0 });
probeCase('complete P4a evidence passes', () => {
  write(probe, evidence('P4a 证据', head, 'bash scripts/verify/s-machine-contracts.sh'));
  write(summary, acceptance(`- 确认记录：Human 亲自体验确认通过，版本 \`${head}\``));
  for (const prefix of ['实现 macOS Worker 安装与启动', '将 Machine 加入 Project', '探测并报告 shell 路径', '验证旧连接不能覆盖新连接']) setBox(functional, prefix, link);
  setBox(packagePlan, '集成线完成接入与自检', '集成线完成接入与自检，独立技术验收通过。', '### I-P4a');
  setBox(packagePlan, 'Human 亲自体验并明确确认通过', 'Human 亲自体验并明确确认通过，编排者已记录确认版本。', '### I-P4a');
}, { code: 0 });

restore();
for (const item of cases) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name} (exit ${item.code})`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`FAIL l-docs-probes ${failures.length} of ${cases.length} probes failed`);
  process.exit(1);
}
console.log(`PASS l-docs-probes ${cases.length} probes passed; no probe was written to the working tree`);
NODE
