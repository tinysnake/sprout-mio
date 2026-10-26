import { APP_ERROR_CODES } from "../../contracts/result";
import type { AppError, AppErrorCode } from "../../contracts/result";

/** 领域错误按原码透出；`internal` 只留给真正的未知错误。
 * `lease_result_unconfirmed` 是客户端等待收据的状态，同样由共享枚举登记，
 * 不代表服务端租约冲突或执行失败。
 * 执行日志与取消的 6 个码必须在此显式登记：未登记的 code 会退回 `conflict`，
 * 让「日志不可读」或「取消无法确认」伪装成租约冲突。消息使用固定文案，
 * 不透出路径、命令正文或 token。
 */
export const EXECUTION_ERROR_MESSAGES = {
  execution_log_gap: "日志区段已被裁剪，请从新的可读起点重新读取",
  execution_log_cursor_stale: "日志游标已过期，请重新读取",
  execution_log_unavailable: "日志尚不可用",
  cancellation_not_found: "取消请求不存在",
  cancellation_already_terminal: "该取消请求已有终态",
  cancellation_delivery_unconfirmed: "取消尚未送达，命令可能仍在运行",
} as const;
type DomainErrorCode = AppErrorCode;
type DomainErrorClass = abstract new (...args: never[]) => Error & {
  code: string;
  message: string;
};

async function loadDomainErrorClasses(): Promise<readonly DomainErrorClass[]> {
  const [project, agent, access, chat, agentRun, repository, machine, lease, remote] =
    await Promise.all([
      import("../../domain/project"),
      import("../../domain/agent"),
      import("../../domain/access"),
      import("../../domain/chat"),
      import("../../domain/agent-run"),
      import("../../domain/repository"),
      import("../../domain/machine"),
      import("../lease"),
      import("../remote"),
    ]);
  return [
    project.ProjectError,
    agent.AgentError,
    access.ProjectAccessError,
    chat.ChatError,
    agentRun.AgentRunError,
    repository.RepositoryError,
    machine.MachineError,
    lease.LeaseError,
    remote.RemoteError,
  ];
}

function isDomainErrorCode(code: string): code is DomainErrorCode {
  return APP_ERROR_CODES.some((value) => value === code);
}

export async function toDomainAppError(
  error: unknown,
  requestId: string,
): Promise<AppError | undefined> {
  let classes: readonly DomainErrorClass[];
  try {
    classes = await loadDomainErrorClasses();
  } catch {
    return undefined;
  }
  for (const cls of classes) {
    if (error instanceof cls) {
      const code = isDomainErrorCode(error.code) ? error.code : "conflict";
      return {
        code,
        message:
          code in EXECUTION_ERROR_MESSAGES
            ? EXECUTION_ERROR_MESSAGES[code as keyof typeof EXECUTION_ERROR_MESSAGES]
            : error.message,
        requestId,
      };
    }
  }
  return undefined;
}
