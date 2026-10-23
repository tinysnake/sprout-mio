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
const summary = 'docs/p4a/summary.md';
const probe = 'docs/p4a/probe.md';
const files = [functional, packagePlan, summary, probe];
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
const setBox = (file, prefix, text, heading) => {
  const lines = read(file).split('\n');
  const [start, end] = heading ? within(lines, heading) : [0, lines.length];
  const index = lines.findIndex((line, position) => position >= start && position < end && /^- \[[ x]\] /.test(line) && line.slice(6).startsWith(prefix));
  if (index < 0) throw new Error(`probe could not find ${prefix} in ${file}`);
  lines[index] = `- [x] ${text}`;
  write(file, lines.join('\n'));
};
const evidence = (section, commit, command) => `# Probe 证据\n\n## ${section}\n\n实现提交 \`${commit}\`，重跑 \`${command}\`。\n`;
const acceptance = (human) =>
  `# I-P4a 验收摘要\n\n## 交付范围\n\n章节范围。\n\n## 体验后变更\n\nHuman 体验反馈改变的领域决定。\n\n## 功能交付证据\n\n功能基线 \`${head}\`，重跑 \`bash scripts/verify/s-machine-contracts.sh\`。\n\n## 技术验收证据\n\n独立验收基线 \`${head}\`，重跑 \`bash scripts/verify/s-machine-contracts.sh\`。\n\n## human-体验确认\n\n${human}\n`;
const link = '证据见 [P4a 证据](p4a/probe.md#p4a-证据)。';
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
probeCase('future stage checkbox fails', () => {
  setBox(functional, '实现申请与释放', '临时探针勾选 P4b。');
}, { code: 1, includes: 'P4b checkbox must remain unchecked' });
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
