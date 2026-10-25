import { APP_ERROR_CODES } from "../../contracts/result";
import type { AppError, AppErrorCode } from "../../contracts/result";

/** 领域错误按原码透出；`internal` 只留给真正的未知错误。
 * `lease_result_unconfirmed` 是客户端等待收据的状态，同样由共享枚举登记，
 * 不代表服务端租约冲突或执行失败。
 */
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
    if (error instanceof cls)
      return {
        code: isDomainErrorCode(error.code) ? error.code : "conflict",
        message: error.message,
        requestId,
      };
  }
  return undefined;
}
