import { CircleHelp, Terminal } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Icon } from "../ui/icon";
import { installCommands } from "./machine-view";

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
  enrollmentStatus,
}: {
  machineId: string;
  origin?: string;
  enrollmentStatus: "pending" | "active";
}) {
  const commands = installCommands(machineId, origin);
  return (
    <div
      data-testid="machine-install"
      className="min-w-0 rounded-container border border-border p-4"
    >
      <p className="flex items-center gap-2 text-xs font-medium">
        <Icon as={Terminal} />
        Worker 安装与启动
      </p>
      <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
        在源码目录构建并复制 Worker，然后启动。
        {enrollmentStatus === "pending"
          ? "首次配对运行 init，按提示隐藏输入票据；不要将票据写入命令或日志。"
          : "已初始化的 Worker 直接运行 run，无需再次配对。"}
      </p>
      <div className="mt-3 space-y-2">
        <Command testId="machine-command-install">
          {
            'pnpm install --frozen-lockfile\npnpm worker:build\nmkdir -p "$HOME/.local/share/sprout-worker"\ncp dist/worker/main.js "$HOME/.local/share/sprout-worker/main.mjs"'
          }
        </Command>
        {enrollmentStatus === "pending" && (
          <Command testId="machine-command-init">{commands.init}</Command>
        )}
        <Command testId="machine-command-run">{commands.run}</Command>
      </div>
      <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <span>HTTP / HTTPS 配置</span>
        <Dialog>
          <DialogTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            aria-label="HTTP / HTTPS 与 allow-http 配置说明"
            data-testid="machine-http-help"
          >
            <Icon as={CircleHelp} />
          </DialogTrigger>
          <DialogContent data-testid="machine-http-note">
            <DialogHeader>
              <DialogTitle>HTTP / HTTPS 配置</DialogTitle>
              <DialogDescription>
                默认只接受 loopback HTTP；非 loopback HTTP 需显式授权。HTTPS 无需开关。
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs leading-6">
              本机开发时，将 init 命令的 --server 设为 http://127.0.0.1:3330（或
              localhost、[::1]）。连接其他主机时，默认将 --server 设为该主机的 HTTPS 地址。
            </p>
            <p className="text-xs leading-6">
              非 loopback HTTP 必须在 init 时显式添加 --allow-http &lt;完整 origin&gt;，例如
              --allow-http http://192.168.1.10:3210。授权只对该完整
              origin（含端口）生效，不放开同网段其他地址；授权保存在身份文件中，run
              重启后仍有效。HTTP 以明文传输，请只对你确认的目标授权。
            </p>
            <p className="text-xs leading-6 text-muted-foreground">
              安装命令是示例，执行 init 成功后才完成配置。已实测 macOS arm64、Node v26.11.1；x64
              与其他 Node 版本尚未实测。 长期身份保存在本机私有目录。Worker
              只检查目录，不创建或试写目录。
            </p>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
