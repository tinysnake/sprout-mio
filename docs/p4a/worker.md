# 安装并运行 macOS Worker

本指南适用于 macOS arm64 或 x64。当前交付实测环境为 macOS arm64、Node v26.11.1。其他 Node 版本尚未验证。安装不创建 LaunchAgent。

1. 在源码 checkout 安装依赖并构建。

   ```sh
   pnpm install --frozen-lockfile
   pnpm worker:build
   ```

2. 把单文件产物复制到安装位置。Effect 与 Zod 已随文件打包，安装位置不需要 node_modules。

   ```sh
   mkdir -p "$HOME/.local/share/sprout-worker"
   cp dist/worker/main.js "$HOME/.local/share/sprout-worker/main.mjs"
   node "$HOME/.local/share/sprout-worker/main.mjs" version
   node "$HOME/.local/share/sprout-worker/main.mjs" help
   ```

   version 输出应用版本、protocol=1 和实际 Node 版本。

3. 通过已登录的服务创建 Machine，取得其 Machine ID 和一次性显示的票据。票据有效期为十分钟。只有 pending Machine 可以续签，续签使旧票据失效。

4. 初始化本地身份。将参数中的服务 origin 与 Machine ID 替换为实际值。

   ```sh
   node "$HOME/.local/share/sprout-worker/main.mjs" init \
     --server http://127.0.0.1:3000 \
     --machine mch_00000000-0000-4000-8000-000000000001 \
     --state-dir "$HOME/.local/share/sprout-worker/identity"
   ```

   在隐藏输入提示后粘贴票据并回车。不要把票据或长期 secret 放进参数、环境变量或 URL。自动验收可使用 `--ticket-file /absolute/private/file`。该文件必须由当前用户所有，权限为 0600，不能是符号链接。使用后删除自己的票据文件。

   state-dir 权限必须为 0700。identity.json 权限必须为 0600。Worker 在联网前生成并持久保存 secret。相同身份的 init 可以重试。损坏、权限错误或另一 Machine 的身份不会被覆盖。不要删除身份来处理临时网络错误。

5. 启动 Worker。

   ```sh
   node "$HOME/.local/share/sprout-worker/main.mjs" run \
     --state-dir "$HOME/.local/share/sprout-worker/identity"
   ```

   成功后输出 worker.open 与 worker.exchange，只含 Machine ID、boot、generation、seq 和观察数量。临时网络错误按 Effect Schedule 退避，最多间隔十秒。SIGTERM 或 Ctrl-C 中断等待，并在最多两秒的关闭预算内尝试 close。认证、版本或 superseded 错误终止进程，需要先核对服务与身份。

6. 通过已登录服务把 Machine 加入 Project，保存说明与绝对工作目录。null 目录只表示已绑定且未设置目录。Worker 在后续 exchange 获取绑定并探测目录。保存意图不证明目录存在。

默认仅 localhost、127.0.0.1 和 ::1 允许 HTTP。非 loopback HTTP 需在 `init` 时用 `--allow-http <完整 origin>` 逐 origin 显式授权，含端口精确匹配，不放行同网段其他地址；授权写入身份文件，`run` 时重新校验。HTTPS 无需开关。Worker 仍拒绝 redirect 与 TLS 校验绕过，`--allow-http` 不关闭 TLS 验证。

固定 shell 探测使用 /bin/zsh、/bin/bash 与 /bin/sh。$SHELL 为其他绝对路径时保留 unknown 与 unsupported 事实，不执行该程序。探测不载入用户 profile，执行版本查询和固定自检，单次子进程限时三秒、输出上限 4 KiB。目录探测只使用 stat、realpath 与访问权限检查，不创建目录或试写文件。

工作目录是 Machine 的默认操作位置。它不表示 host 分析目录，也不是 OS 安全边界。P4a 只交付连接与观察。远端 shell 工具、租约、任务与自动接续尚未交付。

运行可复跑验收前先执行 `pnpm worker:build` 和 `pnpm build`，再执行 `bash scripts/verify/t-machine-worker.sh`。脚本分配独立端口、SQLite 与 state-dir，默认同时验证 production 与 dev，证据写入新的 `.verify/t-machine-worker-*`。它把产物复制到系统临时目录后启动，不依赖项目 node_modules 的查找链。`SPROUT_VERIFY_DEV=0` 只用于明确跳过 dev 的针对性复跑。
