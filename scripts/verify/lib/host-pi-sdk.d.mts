export interface HostDependencyProbe {
  available: boolean;
  /** 缺少的是什么：`宿主托管 Pi SDK` 或 `宿主托管 Pi SDK 的 native MCP 模块`。 */
  label: string;
  agentDir: string;
  /** 探测成功时的解析结果。 */
  root?: string;
  /** 探测失败时的原因（来自解析器的报错或本模块的路径判断）。 */
  reason?: string;
}

export const HOST_PI_SDK_EXIT: number;
export const MCP_MODULE_GATES: Set<string>;
export function hostAgentDir(environment?: Record<string, string | undefined>): string;
export function probeHostPiSdk(
  environment?: Record<string, string | undefined>,
): Promise<HostDependencyProbe>;
export function probeHostPiMcpModule(
  environment?: Record<string, string | undefined>,
): Promise<HostDependencyProbe>;
export function skipLines(gate: string, probe: HostDependencyProbe): string[];
