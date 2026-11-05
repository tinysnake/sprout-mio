import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
export function sdkRoot(agentDir) {
  const releases = join(agentDir, "install", "releases");
  const candidates = [];
  try {
    const executable = realpathSync(join(agentDir, "bin", "pi"));
    let current = dirname(executable);
    while (current !== dirname(current)) {
      if (existsSync(join(current, "package.json"))) {
        const pkg = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") candidates.push(current);
      }
      current = dirname(current);
    }
  } catch {}
  if (existsSync(releases)) {
    const versions = readdirSync(releases).filter((value) =>
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value),
    );
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions)
      candidates.push(
        join(releases, version, "node_modules", "@earendil-works", "pi-coding-agent"),
      );
  }
  const root = candidates.find((path) => existsSync(join(path, "dist", "index.js")));
  if (!root) throw new Error("找不到 Pi SDK，请在 PI_CODING_AGENT_DIR 对应目录安装托管 Pi");
  return root;
}

export function jsonFile(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

export async function resolveHostSkillPaths(sdk, config) {
  // Project 配置按分身的实际 cwd 生效。
  const settingsManager = sdk.SettingsManager.create(config.cwd, config.agentDir);
  const packageManager = new sdk.DefaultPackageManager({
    cwd: config.cwd,
    agentDir: config.agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve(async () => "skip");
  return resolved.skills.filter((skill) => skill.enabled).map((skill) => skill.path);
}

