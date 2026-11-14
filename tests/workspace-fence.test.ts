import { afterAll, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listWorkspaceTree,
  openWorkspaceFile,
  workspacePathSegments,
  WorkspaceError,
} from "../src/domain/workspace";
import { workspaceContentType, workspacePreviewKind } from "../src/lib/workspace-preview";

/**
 * 这些用例锁的是边界本身：路径规范化、realpath 之后的符号链接逃逸、
 * 以及 Range 切片的语义。任何一条放松，工作区就变成了能读到宿主任意文件的入口。
 */
const root = mkdtempSync(join(tmpdir(), "workspace-root-"));
const outside = mkdtempSync(join(tmpdir(), "workspace-outside-"));

mkdirSync(join(root, "docs"));
writeFileSync(join(root, "README.md"), "# Hello\n\n正文\n");
writeFileSync(join(root, "data.csv"), "a,b\n1,2\n");
writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
writeFileSync(join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
mkdirSync(join(root, ".git"));
writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(outside, "secret.txt"), "不该读到的内容\n");
symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
symlinkSync(join(root, "README.md"), join(root, "alias.md"));
symlinkSync(join(outside), join(root, "escape-dir"));

const workspace = { kind: "repository" as const, path: root, label: "Project 工作副本" };

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
  return "no_error";
}

it("列出单层目录：目录在前、.git 不暴露、链接出界的条目直接不出现", async () => {
  const tree = await listWorkspaceTree(workspace, "");
  expect(tree.root).toBe("repository");
  expect(tree.path).toBe("");
  expect(tree.truncated).toBe(false);
  expect(tree.entries.map((entry) => entry.name)).toEqual([
    "docs",
    "alias.md",
    "data.csv",
    "pixel.png",
    "README.md",
  ]);
  const alias = tree.entries.find((entry) => entry.name === "alias.md");
  expect(alias).toMatchObject({ kind: "file", symlink: true, previewKind: "markdown" });
  expect(tree.entries.some((entry) => entry.name === ".git")).toBe(false);
  expect(tree.entries.some((entry) => entry.name === "escape.txt")).toBe(false);
  expect(tree.entries.some((entry) => entry.name === "escape-dir")).toBe(false);
  const readme = tree.entries.find((entry) => entry.name === "README.md");
  expect(readme?.size).toBeGreaterThan(0);
  expect(readme?.modifiedAt).toBeTypeOf("string");
});

it("只回请求的那一层，子目录内容要再展开时单独取", async () => {
  const tree = await listWorkspaceTree(workspace, "docs");
  expect(tree.path).toBe("docs");
  expect(tree.entries.map((entry) => [entry.path, entry.kind])).toEqual([
    ["docs/guide.md", "file"],
  ]);
});

it("绝对路径、.. 与反斜杠在规范化阶段就被拒", () => {
  expect(() => workspacePathSegments("/etc/passwd")).toThrow(WorkspaceError);
  expect(() => workspacePathSegments("docs/../../etc/passwd")).toThrow(WorkspaceError);
  expect(() => workspacePathSegments("a\\b")).toThrow(WorkspaceError);
  expect(workspacePathSegments("docs/")).toEqual(["docs"]);
});

it("符号链接解析后落到根外时按 forbidden 拒绝，落在根内的照常读", async () => {
  expect(await failure(listWorkspaceTree(workspace, "escape-dir"))).toBe("forbidden");
  expect(await failure(openWorkspaceFile(workspace, "escape.txt", null))).toBe("forbidden");
  const file = await openWorkspaceFile(workspace, "alias.md", null);
  await file.body.cancel();
  expect(file.name).toBe("alias.md");
  expect(file.size).toBeGreaterThan(0);
});

it("不存在的路径回 not_found，目标是目录时不允许当文件读", async () => {
  expect(await failure(listWorkspaceTree(workspace, "nope"))).toBe("not_found");
  expect(await failure(openWorkspaceFile(workspace, "docs", null))).toBe("validation_failed");
});

it("content-type 与预览分流读同一张扩展名表", () => {
  expect(workspacePreviewKind("README.md")).toBe("markdown");
  expect(workspacePreviewKind("data.csv")).toBe("csv");
  expect(workspacePreviewKind("index.html")).toBe("html");
  expect(workspacePreviewKind("main.ts")).toBe("code");
  expect(workspacePreviewKind("clip.mp4")).toBe("video");
  expect(workspacePreviewKind("doc.pdf")).toBe("pdf");
  expect(workspacePreviewKind("Dockerfile")).toBe("code");
  expect(workspacePreviewKind("blob.bin")).toBe("binary");
  expect(workspaceContentType("README.md")).toBe("text/markdown; charset=utf-8");
  expect(workspaceContentType("pixel.png")).toBe("image/png");
  expect(workspaceContentType("main.ts")).toBe("text/plain; charset=utf-8");
  expect(workspaceContentType("blob.bin")).toBe("application/octet-stream");
});

it("Range 只回请求的那一段，并给出 206 与 Content-Range", async () => {
  const body = "0123456789";
  writeFileSync(join(root, "range.txt"), body);
  const file = await openWorkspaceFile(workspace, "range.txt", "bytes=2-5");
  expect(file.status).toBe(206);
  expect(file.length).toBe(4);
  expect(file.contentRange).toBe(`bytes 2-5/${body.length}`);
  expect(await new Response(file.body).text()).toBe("2345");

  const suffix = await openWorkspaceFile(workspace, "range.txt", "bytes=-3");
  expect(suffix.contentRange).toBe(`bytes 7-9/${body.length}`);
  expect(await new Response(suffix.body).text()).toBe("789");

  const open = await openWorkspaceFile(workspace, "range.txt", null);
  expect(open.status).toBe(200);
  expect(open.length).toBe(body.length);
  expect(await new Response(open.body).text()).toBe(body);
});

it("越界的 Range 回 validation_failed，而不是悄悄回整个文件", async () => {
  expect(await failure(openWorkspaceFile(workspace, "range.txt", "bytes=99-100"))).toBe(
    "validation_failed",
  );
});
