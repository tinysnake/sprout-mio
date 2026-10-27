import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExecutionLogReadInput } from "../contracts/remote";
import type {
  ExecutionCancellationView,
  ExecutionLogReadView,
  ExecutionView,
} from "../contracts/remote";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type { AppError, AppResult } from "../contracts/result";
import type {
  ExecutionCanceller,
  ExecutionLogReadRequest,
  ExecutionLogReader,
  LogConnection,
} from "../components/machine/presentation";
import { cancelExecutionFn, readExecutionLogFn } from "../server/functions/remote";

/**
 * 正式页面与真实服务端入口之间的接线层。
 *
 * 呈现组件（`ExecutionLogViewer` / `ExecutionCancelControl`）只接受注入的读取与取消函数，
 * 自己不发明结果。这里负责把页面上已知的事实（Project、执行的 Machine、浏览器在线状态、
 * 服务端返回的取消事实）映射成服务端 Fn 需要的形状，并把返回结果原样交回组件。
 *
 * 三条不许越过的线：
 * - 日志分页预算固定 32768 字节，页面不自己改，也不在客户端拼页。
 * - 取消的 requestId 每次用户动作生成一次；只有没收到结果（抛错）的重试才复用同一个。
 * - 取消成功不等于进程已停：这里只把取消视图交给页面，不改写执行终态。
 */

/** 冻结的日志读取预算：一页最多 32768 字节，超出就用游标继续读。 */
export const EXECUTION_LOG_PAGE_BYTES = 32768;

/** 服务端日志读取入口的形状，与 `executionLogReadInputSchema` 对齐。 */
export type ExecutionLogReadTransport = (
  input: ExecutionLogReadInput,
) => Promise<AppResult<ExecutionLogReadView>>;

/** 服务端取消入口的形状，与 `executionCancelRequestSchema` 对齐。 */
export type ExecutionCancelTransport = (input: {
  executionId: string;
  requestId: string;
}) => Promise<AppResult<ExecutionCancellationView>>;

export const serverExecutionLogRead: ExecutionLogReadTransport = (input) =>
  readExecutionLogFn({ data: input });

export const serverExecutionCancel: ExecutionCancelTransport = (input) =>
  cancelExecutionFn({ data: input });

/** 页面不知道 Machine 时给出的失败：不拿别的 Machine 的租约键去猜。 */
function missingMachineError(): AppError {
  return {
    code: "not_found",
    message: "页面没有这条执行的 Machine 上下文，无法读取日志。",
    requestId: "unavailable",
  };
}

/** 把呈现层的读取请求映射成服务端输入；executionId 是唯一锚点，Machine 由列表事实提供。 */
export function executionLogInput(
  request: ExecutionLogReadRequest,
  projectId: string,
  machineId: string | null | undefined,
): ExecutionLogReadInput | null {
  if (!machineId) return null;
  return {
    projectId,
    machineId,
    executionId: request.executionId,
    cursor: request.cursor,
    limitBytes: EXECUTION_LOG_PAGE_BYTES,
  };
}

/** 读取入口：映射请求后交给真实服务端 Fn，失败时保留 AppResult 的错误分支。 */
export function executionLogReader(
  source: {
    projectId: string;
    machineIdOf: (executionId: string) => string | null | undefined;
  },
  transport: ExecutionLogReadTransport = serverExecutionLogRead,
): ExecutionLogReader {
  return async (request) => {
    const input = executionLogInput(
      request,
      source.projectId,
      source.machineIdOf(request.executionId),
    );
    if (!input) {
      const error = missingMachineError();
      return { ok: false, error, requestId: error.requestId };
    }
    return transport(input);
  };
}

/**
 * 取消入口：每次用户动作生成一个 requestId。抛错（没有收到服务端结论）时保留同一个，
 * 让重试是幂等重放；拿到服务端结论后清掉，下一次点击是新请求。
 */
export function executionCanceller(
  transport: ExecutionCancelTransport = serverExecutionCancel,
  mintRequestId: () => string = () => newId(ID_PREFIXES.request),
): ExecutionCanceller {
  const pending = new Map<string, string>();
  return async (executionId: string) => {
    const requestId = pending.get(executionId) ?? mintRequestId();
    pending.set(executionId, requestId);
    // 抛错时不会走到 delete：没有服务端结论就保留 requestId，重试才是同一次请求的重放。
    const result = await transport({ executionId, requestId });
    pending.delete(executionId);
    return result;
  };
}

/**
 * 合并取消事实：服务端返回的取消视图是唯一来源。页面本地刚收到的取消视图优先，
 * 避免刷新前后的旧事实把新状态盖回去。没有变化时返回 null，不触发额外渲染。
 */
export function mergeExecutionCancellations(
  current: Readonly<Record<string, ExecutionCancellationView>>,
  executions: readonly ExecutionView[],
): Record<string, ExecutionCancellationView> | null {
  let next: Record<string, ExecutionCancellationView> | null = null;
  for (const execution of executions) {
    const fact = execution.cancellation;
    if (!fact || current[execution.executionId]) continue;
    next ??= { ...current };
    next[execution.executionId] = fact;
  }
  return next;
}

/**
 * 页面的执行接线：读取、取消、取消事实与连接状态。
 * `listError` 是执行列表查询的失败；查询失败时连接按离线呈现，让组件自己说明
 * 「已知事实不能当作当前状态」，页面不另写成功文案。
 */
export function useExecutionWiring({
  projectId,
  executions,
  listError = null,
}: {
  projectId: string;
  executions: readonly ExecutionView[];
  listError?: AppError | null;
}): {
  logReader: ExecutionLogReader;
  canceller: ExecutionCanceller;
  cancellations: Readonly<Record<string, ExecutionCancellationView>>;
  connection: LogConnection;
  onCancelled: (view: ExecutionCancellationView) => void;
} {
  const [cancellations, setCancellations] = useState<Record<string, ExecutionCancellationView>>(
    () => mergeExecutionCancellations({}, executions) ?? {},
  );
  const [browserOffline, setBrowserOffline] = useState(false);

  // 执行列表每次刷新都会换 identity，用 ref 保留最新的 Machine 归属，读取函数保持稳定。
  const machineIds = useRef(new Map<string, string>());
  machineIds.current = new Map(executions.map((item) => [item.executionId, item.machineId]));

  const logReader = useMemo(
    () =>
      executionLogReader({
        projectId,
        machineIdOf: (executionId) => machineIds.current.get(executionId),
      }),
    [projectId],
  );
  const canceller = useMemo(() => executionCanceller(), []);

  useEffect(() => {
    setCancellations((current) => mergeExecutionCancellations(current, executions) ?? current);
  }, [executions]);

  useEffect(() => {
    const sync = () =>
      setBrowserOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const onCancelled = useCallback((view: ExecutionCancellationView) => {
    setCancellations((current) => ({ ...current, [view.executionId]: view }));
  }, []);

  const connection = useMemo<LogConnection>(() => {
    if (listError) return { online: false, detail: `执行列表查询失败：${listError.message}` };
    if (browserOffline) return { online: false, detail: "浏览器已离线：请求无法送达服务端。" };
    return { online: true, detail: null };
  }, [listError, browserOffline]);

  return { logReader, canceller, cancellations, connection, onCancelled };
}
