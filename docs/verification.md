# 验证约定

本文规定验证范围、编排分工与证据复用。开始验证、编写 worker brief、准备合并或交付前读取本文。领域验收要求仍由对应章节和[前端开发约定](frontend-conventions.md)维护。

## 按改动选择验证范围

先检查实际 diff，再选择能覆盖本次风险的验证。涉及产品行为时，从 [Feature map](feature-map/README.md) 进入受影响功能，核对入口、前置条件、可观察结果与现有脚本的证据边界。不能只按文件扩展名分类，也不能因为要合并就自动扩大到完整验证。

| 改动 | 必需的验证 | 升级条件 |
| --- | --- | --- |
| 普通文档、计划、summary、决策记录、项目规范 | 格式、相关文档门禁、链接、证据引用与内容一致性检查；本仓库文档门禁为 `bash scripts/verify/l-docs.sh` 与 `bash scripts/verify/l-docs-probes.sh` | 文档改变了产品契约或执行流程时，核对对应实现与调用方，再按实际受影响领域增加验证 |
| 产品代码、UI、共享契约或配置 | 受影响领域的定向测试与必要的静态检查；视觉变更保存并查看截图，交互变更验证实际操作 | 跨领域契约、运行环境、依赖、构建或集成行为变化时，扩大到相关领域或完整验证 |
| 验证脚本、测试工具或门禁 | 实际运行被修改的检查，验证合法输入通过与相关非法输入被拒绝 | 影响全局 runner、环境隔离或完整验证调度时，运行完整验证 |
| 包含代码改动的集成批次、章节收尾或交付候选 | 完整验证与独立技术验收 | 验证失败后按失败原因修复并重跑，不能用旧结果覆盖失败 |

纯文档任务不运行全量 `pnpm test`、build、浏览器回归或完整 `pnpm verify`。文档里的命令、代码示例和契约要按其含义检查；若检查揭示必须修改实现，则按新增的实际改动重新选择验证范围。

格式检查使用仓库配置的工具。现有 `pnpm check` 包含格式、lint 与类型检查，若采用它，应如实记录该命令的范围。定向验证与独立验收不能用构建通过代替。

## 运行器、选择与报告

`pnpm verify` 通过 `scripts/verify.sh` 调用 `scripts/verify/runner.mjs`，按文件名字典序串行执行 `scripts/verify/*.sh`。单个脚本失败不会中止后续脚本；全部执行完后，任一失败即退出 1。运行器导出 `SPROUT_PI_ENABLED=false` 和 `SPROUT_VERIFY_RUN_DIR`，领域脚本仍由自身的 trap 管理其后台进程，运行器不承诺超出转发与等待范围的进程隔离。

`pnpm verify --only aa-execution-log-contracts,af-execution-cancel-authority` 只执行列出的脚本 id（文件名去掉 `.sh`）。未知、重复、空或越界的 id，以及未知参数，都在清理数据库和运行脚本之前拒绝；`pnpm verify --help` 只打印用法，不创建运行目录或执行脚本。包管理器转发的单个前导 `--` 会被忽略。

每次运行独占 `.verify/runs/<id>/`：每个脚本的 stdout 与 stderr 通过继承的文件描述符写入该目录下的 `<script>.log`，运行结束写出 `report.json`。报告记录脚本 id、路径、状态、退出码或信号、ISO 开始时间、单调计时得到的 `durationMs` 和日志路径；`durationMs` 只表示实际总耗时，不累加脚本内的嵌套计时。终端按慢到快打印摘要，保留原有的 `Verification scripts=N failed=N` 汇总行，并额外打印总耗时与报告路径。失败脚本会打印有上限的日志尾部用于定位。

完整运行沿用 `.verify/*/verification.sqlite` 的清理；`--only` 只清理选中脚本对应目录的同一文件，避免删除未选中单元的证据。`.verify/runs` 与脚本的数据库目录相互独立。收到 `SIGINT` 或 `SIGTERM` 时，运行器停止派发后续脚本，把信号转发给当前脚本所在的独立进程组，等待其 trap 清理，超时后强制结束并写出部分报告；中断以 130 / 143 退出，绝不计为通过。

## 本地完整验证与 GitHub Actions

完整测试与真实行为验证在本机 macOS 执行。全量 `pnpm test` 由 `pnpm verify` 内的 `scripts/verify/b-tooling.sh` 运行，覆盖真实 Worker 与需要受管 Pi 的 MCP 场景；GitHub Actions 的 Ubuntu runner 不具备这些前提。

`.github/workflows/ci.yml` 的 Linux job 只执行安装、`pnpm check`、server 构建、数据库迁移、生产 smoke、worker 与 extension 产物检查。它证明这些静态检查与构建在 Linux 上通过，不代表全量测试通过，不能替代本地完整验证，也不作为行为或 Worker / MCP 集成的证据。

因此两处不重复执行全量测试：执行 `pnpm verify` 时不再另加 `pnpm test`，因为前者已包含（见[完整验证与去重](#完整验证与去重)）。集成与交付节点仍按本文要求执行完整验证；本地证据必须绑定当前 diff，按[证据复用与失效](#证据复用与失效)记录基准 commit、完整 diff 与内容哈希。

## 验证中的模型调用

`pnpm verify` 默认使用 `SPROUT_VERIFY_CHAT_MODE=model-fixture`。`a-base` 的 Pi CLI 状态探针与 `z-lease-integration` 的 Chat 场景都复用本地 SSE 模型 fixture。前者仍启动真实已安装 Pi CLI、加载 `dist/extension/main.js` 并断言一次成功的 `sprout_status` 完成事件；后者仍经过真实 Chat、`scripts/pi-host-runner.mjs`、Pi SDK、remote tools、HTTP、SQLite 和 Worker，保留原有 14 项验收条件，包括实际 shell PID/文件、授权拒绝、代次 fencing 和强制收据刷新。

fixture 从 `PI_CODING_AGENT_DIR` 或默认 `~/.pi/agent` 发现已安装 SDK，仅在临时私有 agent 目录链接 SDK 可执行文件，并写入自己的 models.json、空 auth/settings 和 dummy key。模型目录只配置 loopback endpoint；operator、non-holder 和 CLI status 使用各自固定模型，reasoning=false、thinking=off。不会复制用户凭据、设置或扩展，也不替换 runner、SDK 事件或工具结果。CLI 使用 `--offline` 禁用启动联网。fixture 缺失、SDK 不可用或计划不符均失败，不转入 live；fixture 模式不读取 `SPROUT_VERIFY_PI_MODEL`，z 同时拒绝自定义 `SPROUT_PI_RUNNER`。

每个场景有独立的有序工具计划。首次 toolCall 前必须验证本轮最新 user message：直接 Chat 请求逐字匹配预期；UI 租约请求验证固定消息格式以及 driver 指定的 action、Machine、generation 和 target，再将 UI 产生的 requestId 绑定到该次工具调用，原有收据检查继续核对该 requestId。历史消息不能满足新轮次。endpoint 核对注册工具 schema、固定参数和当前 call ID 的实际结果后才推进。它只发送 assistant toolCalls 与最终文本，不生成 toolResult、数据库事实或 shell 副作用。未使用步骤、错误模型、异常请求或结果顺序使验证失败。

显式执行真实 provider 验证：`SPROUT_VERIFY_CHAT_MODE=live pnpm verify --only z-lease-integration`；CLI 探针可用 `--only a-base`。live 沿用真实模型选择和凭据，支持 `SPROUT_VERIFY_PI_MODEL=provider/model`。空值和未知 mode 在脚本准备产物前拒绝。fixture 通过证明真实工具与生命周期链路，不证明真实 provider 的认证、可达性或模型遵循指令的能力；这些能力应单独以 live 验证。

stdout 和 `a-base/model-mode.json`、`p4b-integration/evidence/run-*/model-mode.json` 标明实际 mode、provider/model、thinking、请求数、完成计划和未使用步骤；live 中未跟踪的请求/计划数记为 null。导出的元数据不包含私有 prompt、session 或凭据。零付费模型调用的依据是私有模型目录、loopback endpoint 和所有调用方的模型固定配置，并非整台宿主的网络抓包结论。完整 runner 已令其他应用脚本的 `SPROUT_PI_ENABLED=false`，`n-pi-session` 使用明确的协议 stub；单独运行其他脚本时仍需另行判断其模型开关。fixture 需要本机已安装的 Pi SDK，不消除这一前提。

## 当前 run 的构建准备

构建调用统一通过 `node scripts/verify/prepare.mjs install|server|worker|extension [--fresh]`。运行器在新建的 `.verify/runs/<id>/context.json` 记录仓库根目录、run id 和 owner PID。helper 只在目录、根目录和活着的 owner 均匹配时读取该 run 的成功 receipt；传入失效或损坏的内部 context 会明确失败。没有 `SPROUT_VERIFY_RUN_DIR` 时，独立调用总会基于当前源码执行，不因旧产物存在而跳过。不同 run 不复用；同一 checkout 仍只支持一个串行验证调用。

receipt 记录 artifact kind、仓库根目录、输入指纹、原始成功日志、实际构建耗时和必要产物路径。源码、依赖清单与 lockfile、构建配置、`.env` 输入及相关编译环境参与指纹；只保存哈希，不写入秘密值。构建完成后重新计算指纹以包含生成的 route tree。复用还要求原始日志和必要产物仍存在，不对完整输出目录或 `node_modules` 反复做内容哈希。输入变化、产物缺失、构建失败或中断均不能获得复用成功。主动中断即使被调用命令的 trap 返回 0 也失败，日志保留实际 code、signal 和中断原因。

server 准备固定使用 `NODE_ENV=production` 并删除 `BETTER_AUTH_SECRET`，保留其他继承的编译配置。领域的运行时数据库、origin 和随机 auth secret 不导致相同编译配置反复构建。`d-runtime` 明确使用 `server --fresh` 再执行一次实际 secretless build，保留它自身数据库的无 `runtime_boot` 行检查和真实构建日志。`--fresh` 成功替换 receipt，旧原始日志仍保留。

同 run 的第二次 install 请求复用首次成功安装，不删除前序脚本已构建的产物；需要实际安装时才清理 `node_modules`、`dist`、`.output`，同时使旧构建 receipt 失效。复用输出明确的 `REUSE` 和原生产者日志，不能称为新执行的构建；`durationMs` 表示原生产者的执行耗时。独立调用的原始日志保留在 `.verify/preparation-*/`。

## worker 与 coordinator 的职责

每份 brief 的验证计划写明以下内容：

- 实际改动范围与需要证明的行为或文档事实。
- 必须执行的命令或人工检查及通过条件；脚本内含的检查及与其他命令的重叠项。先读取脚本实际内容，再列命令。
- 本次不执行的昂贵验证及理由。
- 什么新增改动或风险会触发验证范围升级。

worker 按验证计划执行，不因“保险起见”自行追加全量验证。发现计划外风险时，记录具体风险和调整依据，再更新验证计划。报告区分计划执行、实际执行、通过、失败与跳过。

coordinator 在合并前独立核对 diff、证据，并复跑该单元所需范围。worker 自报通过是证据，不代替 coordinator 验证。文档单元复跑文档检查，代码单元复跑受影响领域检查；独立复跑不等于全量复跑。复跑前核对脚本内含的检查，去掉本轮执行计划中的重复项；保留重复项时写明新增风险或独立取证的理由。

完整验证安排在明确的集成批次或交付节点，不在每个中间单元重复执行。独立验收的范围覆盖该节点的交付要求，不能因为单元定向验证通过而省略。在集成分支上，先把它与 `main` 同步、解决冲突，再在同步后的头部跑完整验证与独立验收，并把该 commit 记成受验对象；之后 `main` 只接收这个受验形态。

## 完整验证与去重

`pnpm verify` 调用 `scripts/verify.sh`，包含全量 `pnpm test`。`scripts/verify/b-tooling.sh` 是完整验证中全量测试的唯一执行入口，其他验收脚本保留领域定向测试。

同一轮完整验证不再另外追加全量测试。领域验证同样去重。例如 `scripts/verify/g-identity-data.sh` 已包含 `pnpm check` 和 `tests/identity-data.test.ts` 的定向测试，未发生相关改动时，不在同一执行者的同一轮计划中另加相同检查。修复前后对照、快速定位失败或独立验收需要重复执行时，保留并说明目的。

只有后续改动、验证失败或尚未解决的具体风险要求时，才扩大或重复验证，并记录原因。

`aa-execution-log-contracts`、`af-execution-cancel-authority`、`ai-execution-accept-fixes`、`ak-execution-accept-fixes-2` 通过各自的 Vitest wrapper 执行一次隔离 fixture，移除脚本内相同 fixture 的直接重复调用。wrapper 保留独立子进程、私有数据库、test 环境、禁用 Pi、所需随机 auth secret、proxy 前提、PASS/退出与超时检查，并在 finally 清理临时目录。独立 live/browser 验收和 `b-tooling` 全量测试仍保留。`ac-execution-recovery-log` 与测试中的 recovery fixture 尚未证明环境等价，继续各自取证。

## 证据复用与失效

验证记录注明覆盖的 commit、实际命令、退出码、日志或其他产物。验证未提交改动时，同时保存基准 commit、完整 diff 和必要的内容哈希，不要求先 commit 才能验证。仅创建 commit，不自动触发重跑；门禁或产物绑定 commit 时，按其实际要求重跑。

耗时区分 runner 执行时间、工具等待与工作流总时间，不能把后台启动命令返回的时间当作任务执行时间。

已有完整验证通过后，仅补说明、修链接或记录 Human 判定，不会自动使代码验证失效。保留原代码 commit 的验证证据，另记本次文档检查；不得写成本次 HEAD 已重新全量验证通过。

证据复用前，确认原受验 commit 与当前版本的关系、此后的完整 diff，以及运行环境和外部依赖是否仍符合原验证前提。对改变了受验行为、依赖、构建、数据库、环境或门禁的后续改动，按其影响重新验证。对绑定当前内容哈希或 commit 的产物，按对应门禁重新检查，不能仅因祖先关系成立就沿用。

Human 体验确认与技术验收分别记录。仅在文档中记录 Human 判定不触发完整技术验证。
