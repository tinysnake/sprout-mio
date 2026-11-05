/**
 * 解析本机托管安装的 Pi release，供 `experiments/` 下的独立脚本复用。
 *
 * 这些脚本不参与 verify 门禁，但也不该把 Pi 版本写死：同一份探针要能在
 * 1.4.0、1.5.0 或后续版本上重放。解析规则与 `src/extension/mcp-load.ts` 一致：
 * 从 `install/releases` 按版本号降序找第一个装有所需包的有效 release。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const parseSemver = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
};

const compareSemver = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference;
  }
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return left.prerelease.localeCompare(right.prerelease);
};

export function agentDirectory(
  agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
) {
  return agentDir;
}

/**
 * 返回第一个同时装有所需 `@earendil-works/*` 包的 release 的 `node_modules` 目录。
 * 默认只要求 `pi-coding-agent`；需要 MCP 的脚本传两个包，避免选到缺 MCP 的 release。
 */
export function piReleaseNodeModules(
  packages = ["pi-coding-agent"],
  agentDir = agentDirectory(),
) {
  const releases = join(agentDir, "install", "releases");
  if (!existsSync(releases)) {
    throw new Error(
      `找不到托管 Pi release 目录：${releases}（可用 PI_CODING_AGENT_DIR 覆盖 agent 目录）`,
    );
  }
  const candidates = readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ version: entry.name, semver: parseSemver(entry.name) }))
    .filter((entry) => entry.semver !== null)
    .sort((left, right) => compareSemver(right.semver, left.semver))
    .map((entry) => join(releases, entry.version, "node_modules"))
    .filter((nodeModules) =>
      packages.every((name) =>
        existsSync(join(nodeModules, "@earendil-works", name, "package.json")),
      ),
    );
  const nodeModules = candidates[0];
  if (!nodeModules) {
    throw new Error(
      `在 ${releases} 下找不到装有以下包的 Pi release：${packages.join(", ")}；` +
        "请确认托管安装完整，或用 PI_CODING_AGENT_DIR 指向正确的 agent 目录",
    );
  }
  return nodeModules;
}

export function piPackageDirectory(
  name,
  packages = ["pi-coding-agent"],
  agentDir = agentDirectory(),
) {
  return join(piReleaseNodeModules(packages, agentDir), "@earendil-works", name);
}
