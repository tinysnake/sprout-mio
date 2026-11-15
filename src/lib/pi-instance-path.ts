import { join } from "node:path";
import { config } from "./config";

/**
 * Pi 实例的目录布局只有这里一份。读取侧不能调用会建目录的 piInstancePaths，
 * 否则「看一眼工作区」会在磁盘上留下空壳。
 */
export function piInstanceWorkspacePath(instanceId: string) {
  return join(config.SPROUT_PI_DATA_DIR, instanceId, "workspace");
}

export function piInstanceSessionDirectory(instanceId: string) {
  return join(config.SPROUT_PI_DATA_DIR, instanceId, "sessions");
}
