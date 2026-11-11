import { z } from "zod";
import { leaseViewSchema } from "../contracts/lease";
import type { LeaseView } from "../contracts/lease";
import { clampLeaseWaitMs } from "../contracts/lease-timeout";
import type { LeaseWaitFailure } from "../contracts/lease-timeout";
import {
  executionCancellationViewSchema,
  executionLogReadViewSchema,
  executionViewSchema,
  type ExecutionView,
  holderExecutionListViewSchema,
  remoteAgentRequestSchema,
  remoteToolInputSchemas,
} from "../contracts/remote";
import type { RemoteAgentRequest } from "../contracts/remote";
import { waitForLease } from "../domain/lease-wait";
import { waitForExecution } from "../domain/execution-wait";
import {
  clampExecutionWaitMs,
  EXECUTION_WAIT_DEFAULT_MS,
  EXECUTION_WAIT_MAX_MS,
} from "../contracts/tool-wait";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import { objectToolParameters } from "./tool-parameters";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

export const INFO_HUB_TOOL_DESCRIPTION =
  "Read bounded Project, Chat, Agent, or Machine basic facts in this run’s Project. Use sections and nextCursor to page; refresh from page one on info_hub_cursor_stale. Status and held leases are facts, never execution grants. Chat/Task bodies, turn-context capture, and hint delivery are unavailable through this tool. Execution identity comes only from the live process grant.";

/** 取消工具只暴露意图与当前代次：Project 由宿主注入，身份不可由参数冒充。 */
const cancelToolInputSchema = remoteToolInputSchemas.sprout_remote_execution_cancel;
const logReadToolInputSchema = remoteToolInputSchemas.sprout_remote_execution_log;

type ToolName = keyof typeof remoteToolInputSchemas;

const descriptions: Record<ToolName, string> = {
  sprout_chat_continuation_get:
    "读取当前 Chat 的对话接续模式、周期检查、提醒和投递状态；不能暂停、停止、恢复或重发。",
  sprout_lease_acquire:
    "申请当前 Project 中显式指定的远端 Machine 租约。machineId 必填，expectedGeneration 来自 lease_get；requestId 标识同一次请求。空闲分身也可持有租约。",
  sprout_lease_release:
    "释放显式指定的远端 Machine 租约。必须提供 machineId 与当前 expectedGeneration；pending 表示旧操作尚在排空。释放不会终止进程或删除文件。",
  sprout_lease_handoff:
    "将显式指定的远端 Machine 租约交接给同 Project/Chat 的 targetInstanceId。必须提供 machineId 与 expectedGeneration；pending 尚未完成。不会终止进程或删除文件。",
  sprout_lease_escrow:
    "把自己持有的显式 Machine 租约挂靠到当前 Project 的一个 Group 或 Public Channel（chatId），可加 targetAgentProfileId 限定该 Group 内的某个 Agent。必须提供 machineId 与当前 expectedGeneration。挂靠后 Machine 仍被占用、持有者仍是自己，但自己随即失去操作权：挂靠会把代次 +1，沿用旧代次的远端操作会得到 lease_stale_generation，用 lease_get 刷新后仍会被拒 lease_not_holder。只有目标 Group 内的分身领取才改变持有者。不能挂靠到 DM。不会终止进程或删除文件。",
  sprout_lease_claim:
    "以本分身身份领取一条处于挂靠中的显式 Machine 租约，需要 machineId、当前 expectedGeneration 与挂靠行 escrowId。只对挂靠目标 Group 内的分身有效（限定 Agent 时必须就是它），先到先得。成功后本分身成为新持有者、代次 +1；不能领取已领取或已撤销的挂靠。",
  sprout_lease_escrow_cancel:
    "撤销自己发起、尚未被领取的挂靠，需要 machineId、当前 expectedGeneration 与 escrowId。操作权回到发起者，代次 +1；已被领取或已被收回的挂靠不能再撤销。对已被自己撤销的同一条挂靠再次撤销，会原样返回原收据、不推进代次，便于响应丢失后重试。不会终止进程或删除文件。",
  sprout_lease_get:
    "查询当前 Project 中显式指定的远端 Machine 租约及可选 mutationId 的交接/释放进度。machineId 必填。此工具不选择默认 Machine。",
  sprout_lease_wait:
    "阻塞等待显式指定的远端 Machine 租约变得可用：machineId 必填，waitMs 是自己愿意忍多久（建议 300000，超过 3600000 一律钳到 3600000）。等待只反复读租约：不抢占、不释放、不向持有者发送任何请求，对持有者完全不可见。ok 表示已经可以继续（拿到、空闲或本来就在自己手里）；到点返回 failed + reason=timed_out，同一身份再次并发等待返回 reason=identity_busy。是否结束当前 run 由自己决定。",
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
  sprout_remote_execution_wait: `阻塞等待远程 execution 到终态，machineId 与 executionId 必填。默认等待 ${EXECUTION_WAIT_DEFAULT_MS / 60_000} 分钟，最多 ${EXECUTION_WAIT_MAX_MS / 60_000} 分钟，waitMs 不足 1 秒按 1 秒算；返回的 data 是最后一次读到的 ExecutionView。outcome 为 timed_out 时要按字段分开看：带 requestedMs 与 waitedMs 的，是自己的等待预算到点、执行可能仍在跑，不要据此重试有副作用的操作；只带 requestId 的，是 execution 自身以 timed_out 终态结束，那是真超时。等待期间可用取消中断。`,
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
  if (name === "sprout_chat_continuation_get") {
    call = {
      type: "chat_continuation_get",
      input: {
        ...remoteToolInputSchemas.sprout_chat_continuation_get.parse(parameters),
        projectId,
      },
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

/** 等待工具只比别的工具多声明一个 waitMs；身份与 Project 一样由宿主注入。 */
const leaseWaitToolInputSchema = remoteToolInputSchemas.sprout_lease_wait;

function validationFailure(message: string): SproutToolResult {
  const details = {
    outcome: "failed",
    error: { code: "validation_failed", message },
  };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
}

/** 读租约失败要把原始远端响应原样带回 `result()`，不能伪装成等待结果。 */
class LeaseWaitReadFailed extends Error {
  readonly response: RemoteToolResponse;
  constructor(response: RemoteToolResponse) {
    super("lease wait read failed");
    this.response = response;
  }
}

function leaseWaitRequest(machineId: string, projectId: string): RemoteAgentRequest {
  return remoteAgentRequestSchema.parse({
    version: 2,
    call: { type: "lease_get", input: { projectId, machineId } },
  });
}

function readLeaseView(response: RemoteToolResponse): LeaseView {
  if (response.outcome !== "response" || !response.result.ok)
    throw new LeaseWaitReadFailed(response);
  const data = response.result.data as { lease?: unknown };
  const parsed = leaseViewSchema.safeParse(data.lease);
  if (!parsed.success)
    throw new LeaseWaitReadFailed({ outcome: "unknown", reason: "invalid_response" });
  return parsed.data;
}

/** 等待可被取消：signal 中断时立即结束本次 sleep，由下一轮请求带回 cancelled。 */
function sleepUntilAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

function leaseWaitResult(
  reason: LeaseWaitFailure,
  requestedMs: number,
  lease: LeaseView | undefined,
): SproutToolResult {
  const details = {
    outcome: reason,
    reason,
    requestedMs,
    waitedLease: lease ?? null,
    message:
      reason === "timed_out"
        ? `等待 ${requestedMs}ms 后租约仍不可用；本工具不抢占、不释放、也不通知持有者。是否结束当前 run 由你自行决定。`
        : "本分身已有一处等待在进行；同一身份同时只允许一次等待。",
  };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
}

/**
 * N1–N8：反复读 `lease_get`，直到拿到、不再有对象或到点（N5：阻塞当前 run）。
 * 全程只读轮询：不抢占、不释放、不向持有者发任何请求（N3），对持有者完全不可见。
 */
async function runLeaseWait(
  client: RemoteToolClient,
  machineId: string,
  requestedMs: number | undefined,
  signal?: AbortSignal,
): Promise<SproutToolResult> {
  let lastRequest = leaseWaitRequest(machineId, client.projectId);
  let lastResponse: RemoteToolResponse = { outcome: "unknown", reason: "transport_error" };
  let lastLease: LeaseView | undefined;
  try {
    const outcome = await waitForLease({
      // instanceId 由宿主注入；缺失时只退化成「不判断已持有」，不会冒充身份。
      requesterInstanceId: client.instanceId ?? "",
      requestedMs,
      deps: {
        readLease: async () => {
          lastRequest = leaseWaitRequest(machineId, client.projectId);
          lastResponse = await client.request(lastRequest, signal);
          const lease = readLeaseView(lastResponse);
          lastLease = lease;
          return lease;
        },
        sleep: (ms) => sleepUntilAborted(ms, signal),
        now: () => new Date(),
      },
    });
    if (outcome.ok) return result(lastRequest, lastResponse);
    return leaseWaitResult(outcome.reason, clampLeaseWaitMs(requestedMs), lastLease);
  } catch (error) {
    if (error instanceof LeaseWaitReadFailed) return result(lastRequest, error.response);
    return result(lastRequest, { outcome: "unknown", reason: "transport_error" });
  }
}

class ExecutionWaitReadFailed extends Error {
  constructor(readonly response: RemoteToolResponse) {
    super("execution wait read failed");
  }
}

function readExecutionView(
  response: RemoteToolResponse,
  projectId: string,
  machineId: string,
  executionId: string,
): ExecutionView {
  if (response.outcome !== "response" || !response.result.ok)
    throw new ExecutionWaitReadFailed(response);
  const parsed = executionViewSchema.safeParse(response.result.data);
  if (
    !parsed.success ||
    parsed.data.projectId !== projectId ||
    parsed.data.machineId !== machineId ||
    parsed.data.executionId !== executionId
  ) {
    throw new ExecutionWaitReadFailed({ outcome: "unknown", reason: "invalid_response" });
  }
  return parsed.data;
}

async function runExecutionWait(
  client: RemoteToolClient,
  machineId: string,
  executionId: string,
  waitMs: number | undefined,
  signal?: AbortSignal,
  now = Date.now,
): Promise<SproutToolResult> {
  const request = buildRequest(
    "sprout_remote_execution_get",
    { machineId, executionId },
    client.projectId,
  );
  let response: RemoteToolResponse = { outcome: "unknown", reason: "transport_error" };
  const startedAt = now();
  const cancelled = (): SproutToolResult => {
    const details = { outcome: "cancelled", message: "已取消等待；远程 execution 可能仍在运行。" };
    return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false };
  };
  try {
    const outcome = await waitForExecution({
      requestedMs: waitMs,
      deps: {
        readExecution: async () => {
          if (signal?.aborted)
            throw new ExecutionWaitReadFailed({ outcome: "unknown", reason: "cancelled" });
          response = await client.request(request, signal);
          if (signal?.aborted)
            throw new ExecutionWaitReadFailed({ outcome: "unknown", reason: "cancelled" });
          return readExecutionView(response, client.projectId, machineId, executionId);
        },
        sleep: (ms) => sleepUntilAborted(ms, signal),
        now: () => new Date(now()),
      },
    });
    if (outcome.ok) return result(request, response);
    const requestedMs = clampExecutionWaitMs(waitMs);
    const details = {
      outcome: "timed_out",
      data: outcome.view,
      requestedMs,
      waitedMs: now() - startedAt,
      message: `等待 ${requestedMs}ms 后 execution 仍在跑；这不是执行失败，不要据此重试有副作用的操作。`,
    };
    return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
  } catch (error) {
    if (signal?.aborted) return cancelled();
    if (error instanceof ExecutionWaitReadFailed) {
      if (error.response.outcome === "unknown" && error.response.reason === "cancelled")
        return cancelled();
      return result(request, error.response);
    }
    return result(request, { outcome: "unknown", reason: "transport_error" });
  }
}

export function registerRemoteTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
): void {
  for (const name of Object.keys(remoteToolInputSchemas) as ToolName[]) {
    // 等待在扩展侧轮询既有读取接口，因此单独注册。
    if (name === "sprout_lease_wait" || name === "sprout_remote_execution_wait") continue;
    pi.registerTool({
      name,
      label: name,
      description: descriptions[name],
      parameters: objectToolParameters(remoteToolInputSchemas[name], {
        unrepresentable: "any",
      }),
      async execute(_toolCallId, parameters, signal) {
        let request: RemoteAgentRequest;
        try {
          request = buildRequest(name, parameters, client.projectId);
        } catch {
          return validationFailure(
            "远端工具参数无效；必须显式提供合法 machineId，且不得声明调用者身份。",
          );
        }
        try {
          return result(request, await client.request(request, signal));
        } catch {
          return result(request, { outcome: "unknown", reason: "transport_error" });
        }
      },
    });
  }
  pi.registerTool({
    name: "sprout_lease_wait",
    label: "sprout_lease_wait",
    description: descriptions.sprout_lease_wait,
    parameters: objectToolParameters(leaseWaitToolInputSchema, { unrepresentable: "any" }),
    async execute(_toolCallId, parameters, signal) {
      let input: z.infer<typeof leaseWaitToolInputSchema>;
      try {
        input = leaseWaitToolInputSchema.parse(parameters);
      } catch {
        return validationFailure(
          "等待工具参数无效；必须显式提供合法 machineId（waitMs 可选，正整数），且不得声明调用者身份。",
        );
      }
      return runLeaseWait(client, input.machineId, input.waitMs, signal);
    },
  });
  pi.registerTool({
    name: "sprout_remote_execution_wait",
    label: "sprout_remote_execution_wait",
    description: descriptions.sprout_remote_execution_wait,
    parameters: objectToolParameters(remoteToolInputSchemas.sprout_remote_execution_wait, {
      unrepresentable: "any",
    }),
    async execute(_toolCallId, parameters, signal) {
      const parsed = remoteToolInputSchemas.sprout_remote_execution_wait.safeParse(parameters);
      if (!parsed.success)
        return validationFailure(
          "等待工具参数无效；必须提供合法 machineId、executionId，waitMs 可选且为正整数，不得声明调用者身份或授权代次。",
        );
      const input = parsed.data;
      return runExecutionWait(client, input.machineId, input.executionId, input.waitMs, signal);
    },
  });
}
