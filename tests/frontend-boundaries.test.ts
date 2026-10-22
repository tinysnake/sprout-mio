import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(repoRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:tsx?|css)$/.test(path) ? [path] : [];
  });
}

function within(path: string, directory: string) {
  return path === directory || path.startsWith(directory + sep);
}

function sourceTree(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void) {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function location(path: string, source: ts.SourceFile, node: ts.Node) {
  return `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/i;
const paletteUtility =
  /(?:^|[\s:!])(?:bg|text|border|ring|fill|stroke|outline|from|via|to|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d+|\b)/;
const foundationColor =
  /var\(--(?:bg|surface|surface-warm|fg|fg-2|meta|accent-on|accent-hover|accent-active|success|warn|danger)\)/;

describe("前端代码边界", () => {
  it("正式模块不依赖开发 fixture、演示或冻结归档", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(sourceRoot)) {
      if (!/\.tsx?$/.test(path) || within(path, join(sourceRoot, "dev"))) continue;
      const source = sourceTree(path);
      visit(source, (node) => {
        let specifier: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          specifier = node.moduleSpecifier;
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteralLike(specifier)) return;
        const value = specifier.text;
        const target = value.startsWith(".")
          ? resolve(dirname(path), value)
          : value.startsWith("@/") || value.startsWith("#/")
            ? resolve(sourceRoot, value.slice(2))
            : value.startsWith("/")
              ? value
              : undefined;
        if (
          target &&
          (within(target, join(sourceRoot, "dev")) ||
            within(target, join(repoRoot, "design", "archive")))
        ) {
          violations.push(`${location(path, source, node)} → ${value}`);
        }
      });
    }
    expect(violations, "正式代码只能复用正式组件；请把模拟数据和操作留在 src/dev").toEqual([]);
  });

  it("页面和组件使用语义色，不能另建色板或绕过 token", () => {
    const violations: string[] = [];
    const files = [join(sourceRoot, "components"), join(sourceRoot, "routes")].flatMap(sourceFiles);
    for (const path of files) {
      if (path.endsWith(".css")) {
        const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        if (rawColor.test(source) || foundationColor.test(source))
          violations.push(`${relative(repoRoot, path)}: CSS 颜色应引用语义 token`);
        continue;
      }
      const source = sourceTree(path);
      visit(source, (node) => {
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          if (
            rawColor.test(node.text) ||
            paletteUtility.test(node.text) ||
            foundationColor.test(node.text)
          ) {
            violations.push(`${location(path, source, node)}: ${node.text.slice(0, 120)}`);
          }
        }
        if (
          !ts.isJsxAttribute(node) ||
          node.name.getText(source) !== "style" ||
          !node.initializer ||
          !ts.isJsxExpression(node.initializer) ||
          !node.initializer.expression ||
          !ts.isObjectLiteralExpression(node.initializer.expression)
        )
          return;
        for (const property of node.initializer.expression.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = property.name.getText(source).replace(/["']/g, "");
          if (
            !/^(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke|boxShadow)$/.test(
              key,
            )
          )
            continue;
          visit(property.initializer, (value) => {
            if (
              ts.isStringLiteralLike(value) &&
              !/^(?:var\(--[\w-]+\)|currentColor|transparent|inherit|none)$/.test(value.text)
            ) {
              violations.push(`${location(path, source, value)}: inline ${key} 应引用语义 token`);
            }
          });
        }
      });
    }
    expect(violations, "颜色定义只放在 src/theme.css；组件使用语义工具类或语义变量").toEqual([]);
  });
});
