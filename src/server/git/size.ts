import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 递归统计占用；符号链接只计自身，不跟随，避免环与越界。 */
export function directorySizeBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) {
      total += stat.size;
      continue;
    }
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) stack.push(join(current, entry));
  }
  return total;
}
