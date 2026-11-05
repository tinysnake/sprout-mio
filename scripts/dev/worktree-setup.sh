#!/usr/bin/env bash
# 新 worktree 的开发环境准备。gitignore 掉的本地文件（.env.local、AGENTS.local.md、.agents/dev-pipeline、
# orchestrate/、.obelisk/memories、.pi/、data/）不会随 git 检出进入 worktree，缺了它们 agent 会退回主 checkout
# 干活，隔离就失效了。
#
# 本地文件一律软链到主 checkout（同一份真值，不复制）：改动只有一处，各 worktree 读到的就是那份。
# 只有 data/ 是 worktree 独占（每个 worktree 独立建库并迁移，避免多份写同一个 sqlite）。
# 每一步都打印 linked / keep / skip，免得再出现「以为拷了其实没有」的排查。

set -uo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

root="${T3CODE_WORKTREE_PATH:-}"
if [ -z "$root" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "当前目录不在 git 工作区里，也没有 T3CODE_WORKTREE_PATH"
fi
# 取 porcelain 输出的第一条 worktree（git 保证主 checkout 排第一）。不用 head -1：
# 在 set -o pipefail 下上游 sed 会吃 SIGPIPE(141)，虽然这里不会致命，但没有必要留着。
main_checkout="$(git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | sed -n '1p')"

[ -n "$main_checkout" ] || fail "找不到主 checkout"
[ "$root" = "$main_checkout" ] && fail "$root 是主 checkout，只用于 main 的集成与评审，不在这里准备开发环境"

# .pi/settings.json 里的相对包源是按主 checkout 的位置写的，而 pi 解析 project 包时以 <cwd>/.pi
# 为 base、不做 realpath：worktree 在 .t3/ 下时 `../../pi-stuff/pi-pstack` 会指到不存在的目录，
# 该包的 extension 与 skills 静默加载不到（`pi list` 里这一项下面没有解析出的路径行）。
# 这里按主 checkout 的 .pi 解析成绝对路径写回；幂等，没有相对源时不动文件。
normalize_pi_package_sources() {
  local settings="$root/.pi/settings.json"
  [ -f "$settings" ] || return 0
  node - "$settings" "$main_checkout/.pi" <<'NODE' || fail "规范化 .pi/settings.json 失败"
const fs = require("node:fs");
const path = require("node:path");
const [file, baseDir] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(settings.packages)) process.exit(0);
const normalize = (source) =>
  source.startsWith("./") || source.startsWith("../") ? path.resolve(baseDir, source) : source;
let changed = false;
settings.packages = settings.packages.map((entry) => {
  if (typeof entry === "string") {
    const source = normalize(entry);
    if (source !== entry) changed = true;
    return source;
  }
  if (entry && typeof entry === "object" && typeof entry.source === "string") {
    const source = normalize(entry.source);
    if (source !== entry.source) changed = true;
    return { ...entry, source };
  }
  return entry;
});
if (changed) fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
NODE
}

cd "$root" || fail "进入 $root 失败"

# 本地专属文件与目录先就位，再装依赖：建 worktree 与启动 pi 之间没有等待关系，
# 软链排在 pnpm install 之后时，pi 可能已经在没有 .pi 的目录里启动，扩展与 skills 都加载不到。
# orchestrate/ 有 200MB 以上（含设计原型与评审证据），复制会把 4 秒的准备拖成几十秒，
# 而且会产生两处真值；.obelisk/memories 同理。
link_paths=(.env.local AGENTS.local.md .agents/dev-pipeline .pi orchestrate .obelisk/memories .sprout-pi-sessions .sprout-pi-workspaces)
for name in "${link_paths[@]}"; do
  if [ -L "$root/$name" ]; then
    printf 'link ok   %s\n' "$name"
    continue
  fi
  # 用 -L 先判：悬空软链用 -e 测不出来
  if [ -e "$root/$name" ]; then
    printf 'keep      %s（worktree 里已有实体，不覆盖）\n' "$name"
    continue
  fi
  if [ ! -e "$main_checkout/$name" ]; then
    printf 'skip      %s（主 checkout 里没有这个路径）\n' "$name"
    continue
  fi
  mkdir -p "$root/$(dirname "$name")" || fail "建 $name 的父目录失败"
  ln -s "$main_checkout/$name" "$root/$name" || fail "链接 $name 失败"
  printf 'linked    %s -> %s\n' "$name" "$main_checkout/$name"
done

normalize_pi_package_sources

pnpm install --prefer-offline || fail "pnpm install 失败"

mkdir -p data || fail "建 data/ 失败"
pnpm db:migrate >/dev/null || fail "本地库迁移失败（也未拷贝主 checkout 的种子库，见 docs/project-conventions.md）"

printf 'worktree ready: %s\nbranch: %s\n' "$root" "$(git branch --show-current)"
