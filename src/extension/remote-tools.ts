import { z } from "zod";
import { remoteAgentRequestSchema, remoteToolInputSchemas } from "../contracts/remote";
import type { RemoteAgentRequest } from "../contracts/remote";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

type ToolName = keyof typeof remoteToolInputSchemas;
const descriptions: Record<ToolName, string> = {
  sprout_lease_acquire:
    "申请当前 Project 中显式指定的远端 Machine 租约。machineId 必填，expectedGeneration 来自 lease_get；requestId 标识同一次请求。空闲分身也可持有租约。",
  sprout_lease_release:
    "释放显式指定的远端 Machine 租约。必须提供 machineId 与当前 expectedGeneration；pending 表示旧操作尚在排空。释放不会终止进程或删除文件。",
  sprout_lease_handoff:
    "将显式指定的远端 Machine 租约交接给同 Project/Chat 的 targetInstanceId。必须提供 machineId 与 expectedGeneration；pending 尚未完成。不会终止进程或删除文件。",
  sprout_lease_get:
    "查询当前 Project 中显式指定的远端 Machine 租约及可选 mutationId 的交接/释放进度。machineId 必填。此工具不选择默认 Machine。",
  sprout_remote_shell:
    "在显式指定的远端 Machine 执行 shell，绝非宿主 shell。machineId 与当前租约 authorizationGeneration 必填。以 Worker 用户权限执行，cwd 不是安全边界；省略 cwd 使用该 Machine 已确认的项目目录。waitMs 最多 10000；非终态用 execution_get 查询，切勿为查询而重复执行。",
  sprout_remote_file_read:
    "读取显式指定的远端 Machine 上的绝对路径文件，绝非宿主文件。machineId 与当前租约 authorizationGeneration 必填；maxBytes 限制返回大小。",
  sprout_remote_file_write:
    "写入显式指定的远端 Machine 上的绝对路径文件，绝非宿主文件。machineId 与当前租约 authorizationGeneration 必填；mode 为 overwrite 或 append。requestId 相同只表示同一次请求。",
  sprout_remote_process_list:
    "列出显式指定的远端 Machine 上的进程，绝非宿主进程。machineId 与当前租约 authorizationGeneration 必填；limit 限制返回条数。",
  sprout_remote_process_signal:
    "向显式指定的远端 Machine 上的 pid 发送 TERM/INT/KILL，绝非宿主进程。machineId 与当前租约 authorizationGeneration 必填。租约释放/交接不会自动调用此操作。",
  sprout_remote_execution_get:
    "查询显式指定的远端 Machine 上一次 executionId 的状态与有界结果。machineId 必填。queued/dispatched/running/draining 不是执行成功；unknown 不表示没有执行，勿自动重试有副作用的操作。",
};

function buildRequest(name: ToolName, parameters: unknown, projectId: string): RemoteAgentRequest {
  const input = remoteToolInputSchemas[name].parse(parameters);
  let call: unknown;
  if (name === "sprout_lease_get") {
    call = { type: "lease_get", input: { ...input, projectId } };
  } else if (name === "sprout_remote_execution_get") {
    call = { type: "execution_get", input: { ...input, projectId } };
  } else if (name.startsWith("sprout_lease_")) {
    call = {
      type: "lease_mutate",
      input: { ...input, projectId, action: name.slice("sprout_lease_".length) },
    };
  } else if ("authorizationGeneration" in input) {
    const { machineId, requestId, authorizationGeneration, ...operation } = input;
    call = {
      type: "execution_submit",
      input: {
        projectId,
        machineId,
        requestId,
        authorizationGeneration,
        operation: { kind: name.slice("sprout_remote_".length), ...operation },
      },
    };
  } else {
    throw new Error("无效远端工具");
  }
  return remoteAgentRequestSchema.parse({ version: 2, call });
}

function result(response: RemoteToolResponse): SproutToolResult {
  let details: Record<string, unknown>;
  let isError: boolean;
  if (response.outcome === "unknown") {
    details = {
      ...response,
      message: "远端请求结果未知；操作可能已执行。不要自动重试有副作用的操作。",
    };
    isError = true;
  } else if (!response.result.ok) {
    details = {
      outcome: "failed",
      error: response.result.error,
      requestId: response.result.requestId,
    };
    isError = true;
  } else {
    const { data, requestId } = response.result;
    const outcome =
      "executionId" in data
        ? data.state
        : "state" in data && data.state === "pending"
          ? "pending"
          : "succeeded";
    details = { outcome, data, requestId };
    isError = ["failed", "rejected", "timed_out", "unknown"].includes(outcome);
  }
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError };
}

export function registerRemoteTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
): void {
  for (const name of Object.keys(remoteToolInputSchemas) as ToolName[]) {
    pi.registerTool({
      name,
      label: name,
      description: descriptions[name],
      parameters: z.toJSONSchema(remoteToolInputSchemas[name], {
        target: "draft-7",
        io: "input",
        unrepresentable: "any",
      }),
      async execute(_toolCallId, parameters, signal) {
        let request: RemoteAgentRequest;
        try {
          request = buildRequest(name, parameters, client.projectId);
        } catch {
          const details = {
            outcome: "failed",
            error: {
              code: "validation_failed",
              message: "远端工具参数无效；必须显式提供合法 machineId，且不得声明调用者身份。",
            },
          };
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
            isError: true,
          };
        }
        try {
          return result(await client.request(request, signal));
        } catch {
          return result({ outcome: "unknown", reason: "transport_error" });
        }
      },
    });
  }
}
