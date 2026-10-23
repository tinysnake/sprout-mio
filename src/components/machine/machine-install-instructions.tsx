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
        在源码 checkout 构建并复制单文件产物，再初始化本地身份并常驻运行。实测 macOS arm64、Node
        v26.11.1；x64 与其他 Node
        版本尚未实测。初始化时按提示隐藏输入短期票据，票据不要写进命令、环境变量或日志。
      </p>
      <div className="mt-3 space-y-2">
        <Command testId="machine-command-install">
          {
            'pnpm install --frozen-lockfile\npnpm worker:build\nmkdir -p "$HOME/.local/share/sprout-worker"\ncp dist/worker/main.js "$HOME/.local/share/sprout-worker/main.mjs"'
          }
        </Command>
        <Command testId="machine-command-init">
          {commands.init.replace(WORKER_ORIGIN_PLACEHOLDER, shownOrigin)}
        </Command>
        <Command testId="machine-command-run">{commands.run}</Command>
      </div>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        仅 loopback 允许 HTTP，其他 origin 必须为 HTTPS。按隐藏输入提示粘贴票据。
        长期身份保存在本机私有目录。Worker 使用 stat、realpath
        与访问权限检查目录，不创建或试写目录。
      </p>
    </div>
  );
}
