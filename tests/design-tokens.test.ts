import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const themeCss = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");

/** 取出某个顶层选择器块的内容；找不到就返回空串，让断言明确失败。 */
function block(selector: string): string {
  const start = themeCss.indexOf(`${selector} {`);
  if (start < 0) return "";
  const open = themeCss.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < themeCss.length; index += 1) {
    if (themeCss[index] === "{") depth += 1;
    else if (themeCss[index] === "}") {
      depth -= 1;
      if (depth === 0) return themeCss.slice(open + 1, index);
    }
  }
  return "";
}

/** 解析 `--name: value;` 形式的自定义属性，忽略注释。 */
function declarations(css: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const entries = [...withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  return Object.fromEntries(entries.map(([, name, value]) => [name, value.trim()]));
}

const rootTokens = declarations(block(":root"));
const darkTokens = declarations(block(".dark"));
const themeMap = block("@theme inline");

describe("设计令牌", () => {
  it("组件用到的语义令牌在浅色主题里都有定义", () => {
    const required = [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--popover",
      "--popover-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--destructive",
      "--destructive-foreground",
      "--border",
      "--input",
      "--ring",
      "--selected",
      "--hover",
      "--status-running",
      "--status-failed",
    ];
    const missing = required.filter((name) => !rootTokens[name]);
    expect(missing).toEqual([]);
  });

  it("@theme 里的每个映射都指向已定义的变量，避免工具类在构建后失效", () => {
    const mapped = declarations(themeMap);
    const referenced = Object.values(mapped).flatMap((value) => [
      ...value.matchAll(/var\((--[\w-]+)\)/g),
    ]);
    const unresolved = [...new Set(referenced.map((match) => match[1]))].filter(
      (name) => !rootTokens[name] && !darkTokens[name],
    );
    expect(unresolved).toEqual([]);
  });

  it("强调色是单一品牌橙，按钮填充用加深后的 --primary 而不是橙色本身", () => {
    expect(rootTokens["--accent"]).toBe("#f54e00");
    // 橙底白字只有 3.38:1，达不到 AA；按钮必须走加深的 primary，这条断言守住两者不被合并。
    expect(rootTokens["--primary"]).toContain("var(--accent)");
    expect(rootTokens["--primary"]).not.toBe("var(--accent)");
  });

  it("暗色主题只覆盖数值，不新增组件未知的令牌名", () => {
    const unknown = Object.keys(darkTokens).filter((name) => !rootTokens[name]);
    expect(unknown).toEqual([]);
  });
});
