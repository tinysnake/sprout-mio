import type { RemoteAgentRequest } from "../../src/contracts/remote";
import type { RemoteToolClient } from "../../src/extension/remote-client";

/** x2 驱动的最小读取器：只要成功载荷，失败时把错误码带进异常（不打印任何秘密）。 */
export async function readResponseForProbe(
  remote: RemoteToolClient,
  request: RemoteAgentRequest,
): Promise<unknown> {
  const response = await remote.request(request);
  if (response.outcome !== "response") throw new Error(`real HTTP 结果未知：${response.reason}`);
  if (!response.result.ok) throw new Error(`real HTTP 拒绝：${response.result.error.code}`);
  return response.result.data;
}
