import { Terminal } from "lucide-react";
import { Icon } from "../ui/icon";
import { WORKER_ORIGIN_PLACEHOLDER, installCommands } from "./machine-view";

function Command({ children, testId }: { children: string; testId: string }) {
  return (
    <code
      data-testid={testId}
      className="block overflow-x-auto whitespace-pre rounded-control bg-secondary px-3 py-2 font-mono text-[0.6875rem] leading-6"
    >
      {children}
    </code>
  );
}

export function MachineInstallInstructions({
  machineId,
  origin,
}: {
  machineId: string;
  origin?: string;
}) {
  const commands = installCommands(machineId);
  const shownOrigin = origin || WORKER_ORIGIN_PLACEHOLDER;
  return (
    <div data-testid="machine-install" className="rounded-container border border-border p-4">
      <p className="flex items-center gap-2 text-xs font-medium">
        <Icon as={Terminal} />
        Worker 安装与启动
      </p>
      <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
        在目标 macOS 上初始化一次，再常驻运行。初始化时按提示隐藏输入短期票据，或使用仅本人可读的
        `.ticket-file`；票据不要写进命令、环境变量或日志。安装包由功能线交付后补充具体获取方式。
      </p>
      <div className="mt-3 space-y-2">
        <Command testId="machine-command-init">
          {commands.init.replace(WORKER_ORIGIN_PLACEHOLDER, shownOrigin)}
        </Command>
        <Command testId="machine-command-run">{commands.run}</Command>
      </div>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        `--server` 仅允许 loopback 使用 http，其他 origin 必须为 https。命令参数只包含 Machine ID
        与状态目录，不包含票据或长期凭据。
      </p>
    </div>
  );
}
