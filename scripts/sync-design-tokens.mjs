#!/usr/bin/env node
/**
 * 把仓库的 `src/theme.css` 同步成 OpenDesign 设计稿的令牌文件。
 *
 * 颜色只有一个定义处：仓库的 `src/theme.css`。设计稿不自己维护一份数值，
 * 这里读它、原样写出 `src/tokens.css`，设计稿的样式表再引用这份产物。
 *
 *   node scripts/sync-design-tokens.mjs
 *   OD_PROJECT_DIR=<设计稿目录> node scripts/sync-design-tokens.mjs --check
 *
 * `--check` 只比对不写入，用于在两边漂移时报错。
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerPath = path.join(repoRoot, "src/theme.css");
const defaultTarget =
  "/Users/snake/Library/Application Support/Open Design/namespaces/release-stable/data/projects/5308157a-31ed-4f1d-ad69-64cacf6ad76c";
const targetDir = process.env.OD_PROJECT_DIR ?? defaultTarget;
const targetPath = path.join(targetDir, "src/tokens.css");

/** 抽出 `:root { ... }`、`.dark { ... }` 与 `@theme inline { ... }` 三个顶层块。 */
function extractBlocks(css) {
  const blocks = [];
  // @theme inline 是 Tailwind 的映射语法，设计稿自己维护 --color-*，不需要搬过去。
  for (const selector of [":root", ".dark"]) {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`theme.css 里找不到 ${selector} 块`);
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(css.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return blocks;
}

const owner = await readFile(ownerPath, "utf8");
const blocks = extractBlocks(owner);
const generated = `/*
 * 生成文件，请勿直接编辑。
 * 来源：sprout-mio/src/theme.css
 * 重新生成：node scripts/sync-design-tokens.mjs
 */

${blocks.join("\n\n")}
`;

if (process.argv.includes("--check")) {
  const current = await readFile(targetPath, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("设计稿的 tokens.css 与仓库 theme.css 不一致，请重新生成。");
    process.exit(1);
  }
  console.log("tokens.css 与 theme.css 一致。");
} else {
  await writeFile(targetPath, generated);
  console.log(`已写入 ${targetPath}`);
}
