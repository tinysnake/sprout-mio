import { afterAll, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_PREFIXES, newId } from "../src/contracts/ids";
import {
  machineBrowseCommandSchema,
  machineBrowseResultListSchema,
} from "../src/contracts/machine-browse";
import {
  browsePathSegments,
  insideRoot,
  listBrowseDirectory,
  readBrowseFileChunk,
} from "../src/worker/browse";

const directory = mkdtempSync(join(tmpdir(), "machine-browse-fence-"));
const root = join(directory, "root");
const projectId = newId(ID_PREFIXES.project);
const working = join(root, projectId);
mkdirSync(join(working, "docs"), { recursive: true });
mkdirSync(join(working, ".git"), { recursive: true });
writeFileSync(join(working, "README.md"), "# 记录\n");
writeFileSync(join(working, "docs", "data.csv"), "name,value\na,1\n");
writeFileSync(join(working, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(directory, "outside.txt"), "不该看到\n");
symlinkSync(join(directory, "outside.txt"), join(working, "escaped.txt"));
symlinkSync(join(working, "README.md"), join(working, "readme-link.md"));

it("只接受根内的相对路径", () => {
  expect(browsePathSegments("docs/data.csv")).toEqual(["docs", "data.csv"]);
  expect(browsePathSegments("")).toEqual([]);
  for (const bad of ["/etc/passwd", "../outside.txt", "docs/../../x", "docs\\data.csv", "a\0b"])
    expect(() => browsePathSegments(bad)).toThrow();
});

it("围栏按分隔符判断，前缀相同的兄弟目录不算根内", () => {
  expect(insideRoot("/a/b", "/a/b")).toBe(true);
  expect(insideRoot("/a/b", "/a/b/c")).toBe(true);
  expect(insideRoot("/a/b", "/a/bc")).toBe(false);
});

it("目录列表跳过大版本库内部与出界符号链接，目录优先", async () => {
  const tree = await listBrowseDirectory(root, projectId, "");
  expect(tree.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
    "directory:docs",
    "file:readme-link.md",
    "file:README.md",
  ]);
  expect(tree.entries.find((entry) => entry.name === "readme-link.md")?.symlink).toBe(true);
  expect(tree.path).toBe("");
});

it("块读取给出偏移、总量与结束标记", async () => {
  const first = await readBrowseFileChunk(root, projectId, "README.md", { maxBytes: 4 });
  expect(Buffer.from(first.base64, "base64")).toEqual(
    Buffer.from(readFileSync(join(working, "README.md")).subarray(0, 4)),
  );
  expect(first.offset).toBe(0);
  expect(first.eof).toBe(false);
  const tail = await readBrowseFileChunk(root, projectId, "README.md", { offset: 5 });
  expect(tail.offset).toBe(5);
  expect(tail.eof).toBe(true);
});

it("出界的符号链接读不到，目录与越界偏移按验证失败处理", async () => {
  await expect(readBrowseFileChunk(root, projectId, "escaped.txt")).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(readBrowseFileChunk(root, projectId, "docs")).rejects.toMatchObject({
    code: "validation_failed",
  });
  await expect(
    readBrowseFileChunk(root, projectId, "README.md", { offset: 10_000 }),
  ).rejects.toMatchObject({ code: "validation_failed" });
  await expect(readBrowseFileChunk(root, projectId, "missing.txt")).rejects.toMatchObject({
    code: "not_found",
  });
});

it("一帧最多八条命令与八条结果，块大小有上限", () => {
  const command = {
    requestId: newId(ID_PREFIXES.request),
    projectId,
    machineId: newId(ID_PREFIXES.machine),
    op: "file_chunk" as const,
    path: "README.md",
    offset: 0,
    maxBytes: 512 * 1024,
  };
  expect(machineBrowseCommandSchema.safeParse(command).success).toBe(true);
  expect(
    machineBrowseCommandSchema.safeParse({ ...command, maxBytes: 512 * 1024 + 1 }).success,
  ).toBe(false);
  expect(machineBrowseResultListSchema.safeParse([]).success).toBe(true);
  expect(
    machineBrowseResultListSchema.safeParse(
      Array.from({ length: 9 }, (_, index) => ({
        requestId: newId(ID_PREFIXES.request),
        ok: false as const,
        code: "not_found" as const,
        message: `第 ${index} 条`,
      })),
    ).success,
  ).toBe(false);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));
