import { z } from "zod";
import {
  executionCancellationViewSchema,
  executionLogReadViewSchema,
  holderExecutionListViewSchema,
  remoteAgentRequestSchema,
  remoteToolInputSchemas,
} from "../contracts/remote";
import type { RemoteAgentRequest } from "../contracts/remote";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

/** 取消工具只暴露意图与当前代次：Project 由宿主注入，身份不可由参数冒充。 */
const cancelToolInputSchema = remoteToolInputSchemas.sprout_remote_execution_cancel;
const logReadToolInputSchema = remoteToolInputSchemas.sprout_remote_execution_log;

type ToolName = keyof typeof remoteToolInputSchemas;

const descriptions: Record<ToolName, string> = {
  sprout_chat_automation_get:
    "读取当前 Chat 的自动接续模式、周期检查、提醒和投递状态；不能暂停、停止、恢复或重发。",
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
  sprout_remote_execution_list:
    "列出当前 holder 可接续读取的远端执行，按 createdAt/id 倒序分页；machineId 必填，limit 默认 20、最多 100，before 使用原样 nextCursor。authority=holder 表示本分身在当前代次发起；inherited 是继承的历史执行，不能声称是自己刚执行的。原 authorizationGeneration 是发起代次，取消必须使用 currentAuthorizationGeneration。",
  sprout_remote_execution_cancel:
    "显式取消显式指定的远端 Machine 上一次执行，绝非宿主进程。machineId、executionId 与当前租约 authorizationGeneration 必填；authorizationGeneration 必须取 execution_get/list 的 currentAuthorizationGeneration，不得取原始 authorizationGeneration。requestId 标识同一次取消请求，重试请沿用同一个。policy 为 term_then_kill 或 kill，termWaitMs 最多 10000。取消是显式动作：送达（delivered）只说明 Worker 收到意图，不表示进程已停；取消不成功（failed / unknown / 停在 requested）不得当作已停止，仍需 execution_get 确认退出。取消不会释放租约、不会删除文件。",
  sprout_remote_execution_log:
    "按游标增量读取显式指定的远端 Machine 上一次执行的日志，绝非宿主文件。machineId 必填，cursor 为 {executionId,nextSequence} 或 null 从起点读；用别的执行的游标会被 execution_log_cursor_stale 拒绝，limitBytes 最多 65536。frames 为空只表示该范围无帧，不等于没有输出。gapRanges 非空或 logState 为 gap / truncated 表示日志不完整，必须当作不完整展示；logState 为 none 才是确知无输出；workerOnline 为 false 时未收到的部分仍是 unknown。",
};

function buildRequest(name: ToolName, parameters: unknown, projectId: string): RemoteAgentRequest {
  let call: unknown;
  if (name === "sprout_chat_automation_get") {
    call = {
      type: "chat_automation_get",
      input: { ...remoteToolInputSchemas.sprout_chat_automation_get.parse(parameters), projectId },
    };
  } else if (name === "sprout_remote_execution_cancel") {
    call = {
      type: "execution_cancel",
      input: { ...cancelToolInputSchema.parse(parameters), projectId },
    };
  } else if (name === "sprout_remote_execution_log") {
    call = {
      type: "execution_log_read",
      input: { ...logReadToolInputSchema.parse(parameters), projectId },
    };
  } else {
    const input =
      remoteToolInputSchemas[name as keyof typeof remoteToolInputSchemas].parse(parameters);
    if (name === "sprout_lease_get") {
      call = { type: "lease_get", input: { ...input, projectId } };
    } else if (name === "sprout_remote_execution_get") {
      call = { type: "execution_get", input: { ...input, projectId } };
    } else if (name === "sprout_remote_execution_list") {
      call = { type: "execution_list", input: { ...input, projectId } };
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
  }
  return remoteAgentRequestSchema.parse({ version: 2, call });
}

/** 取消的可见状态到工具展示文案：只有 `exited_observed` 才是已停。 */
function cancellationDetail(view: z.infer<typeof executionCancellationViewSchema>) {
  const stopped = view.state === "exited_observed";
  const note = stopped
    ? "取消后已观测到进程退出。"
    : view.state === "already_exited"
      ? "命令在取消送达前已自然退出；原执行结果不被改写。"
      : view.state === "delivered"
        ? "取消意图已送达 Worker，但不表示进程已停；用 execution_get 确认是否退出。"
        : view.state === "requested"
          ? "取消意图已入队但尚未送达，命令可能仍在运行。"
          : view.state === "unknown"
            ? "无法确认取消是否生效，命令可能仍在运行。"
            : "取消未成功，命令可能仍在运行。";
  return {
    outcome: view.state,
    stopped,
    cancellation: view,
    message: note,
    detail: {
      cancelId: view.cancelId,
      executionId: view.executionId,
      state: view.state,
      signalOutcome: view.signalOutcome,
      failureReason: view.failureReason,
      deliveredAt: view.deliveredAt,
      exitedAt: view.exitedAt,
    },
  };
}

/** 日志读取的可见事实：不完整一律显式。 */
function logDetail(view: z.infer<typeof executionLogReadViewSchema>) {
  const incomplete =
    view.logState === "gap" ||
    view.logState === "truncated" ||
    view.logState === "partial" ||
    view.gapRanges.length > 0;
  const note =
    view.logState === "none"
      ? "该执行尚无日志；这是确知的空，不是未收到。"
      : view.logState === "gap"
        ? "日志存在被裁掉的区段（gapRanges），从 availableFromSequence 重新读取；不要把缺口当作没有输出。"
        : view.logState === "truncated"
          ? "日志已按预算截断；已收到的帧不是全部输出。"
          : view.logState === "partial"
            ? "仅收到部分帧：未产生的部分仍是 unknown，不得当作执行已完成或没有输出。"
            : "日志已完整落盘到当前游标。";
  return {
    outcome: incomplete ? "incomplete" : "succeeded",
    logState: view.logState,
    incomplete,
    hasMore: view.hasMore,
    gapRanges: view.gapRanges,
    frames: view.frames,
    nextCursor: view.nextCursor,
    availableFromSequence: view.availableFromSequence,
    acknowledgedThroughSequence: view.acknowledgedThroughSequence,
    producedThroughSequence: view.producedThroughSequence,
    workerOnline: view.workerOnline,
    message: note,
  };
}

function result(request: RemoteAgentRequest, response: RemoteToolResponse): SproutToolResult {
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
  } else if (request.call.type === "execution_cancel") {
    const parsed = executionCancellationViewSchema.safeParse(response.result.data);
    // 只能是对本次请求那一次执行的取消；其余一律不可信。
    const mismatched = parsed.success && parsed.data.executionId !== request.call.input.executionId;
    if (!parsed.success || mismatched) {
      details = {
        outcome: "unknown",
        reason: "invalid_response",
        message: "取消响应不可信；取消是否生效未知，命令可能仍在运行。",
      };
      isError = true;
    } else {
      details = { ...cancellationDetail(parsed.data), requestId: response.result.requestId };
      // 只有观测到退出才算停；delivered / requested / failed / unknown 都不是「已停」。
      isError = parsed.data.state === "failed" || parsed.data.state === "unknown";
    }
  } else if (request.call.type === "execution_log_read") {
    const parsed = executionLogReadViewSchema.safeParse(response.result.data);
    const mismatched = parsed.success && parsed.data.executionId !== request.call.input.executionId;
    if (!parsed.success || mismatched) {
      details = {
        outcome: "unknown",
        reason: "invalid_response",
        message: "日志响应不可信；是否存在输出未知。",
      };
      isError = true;
    } else {
      details = { ...logDetail(parsed.data), requestId: response.result.requestId };
      isError = false;
    }
  } else if (request.call.type === "execution_list") {
    const input = request.call.input;
    const parsed = holderExecutionListViewSchema.safeParse(response.result.data);
    if (
      !parsed.success ||
      parsed.data.executions.some(
        (view) =>
          view.projectId !== input.projectId ||
          view.machineId !== input.machineId ||
          view.authority === "history",
      )
    ) {
      details = { outcome: "unknown", reason: "invalid_response", message: "执行列表响应不可信。" };
      isError = true;
    } else {
      details = {
        outcome: "succeeded",
        data: parsed.data,
        requestId: response.result.requestId,
        message:
          "authority=inherited 是可接续读取的历史执行，原 holder/run 不变；取消使用 currentAuthorizationGeneration。",
      };
      isError = false;
    }
  } else {
    const { data, requestId: responseRequestId } = response.result;
    const outcome =
      "executionId" in data
        ? (data as { state: string }).state
        : "state" in data && data.state === "pending"
          ? "pending"
          : "succeeded";
    details = { outcome, data, requestId: responseRequestId };
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
          return result(request, await client.request(request, signal));
        } catch {
          return result(request, { outcome: "unknown", reason: "transport_error" });
        }
      },
    });
  }
}
