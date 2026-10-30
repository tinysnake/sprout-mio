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

`pnpm verify` 通过 `scripts/verify.sh` 调用 `scripts/verify/runner.mjs`。`scripts/verify/lib/suite-plan.mjs` 为当前 50 个 gate 声明资源、准备需求和隔离方式。运行器先按 install、server、worker、extension 的固定顺序串行准备本批所需共享产物；选中 b-tooling 时先让它独占六个入口完成完整单元套件，再按历史耗时优先派发能取得全部资源的其他 gate。入口配额为 6，native fixture 配额为 6，browser 为 3，重测试/check 和 development 各为 2，SDK 为 1，普通 API/docs 为 2；这些是调度配额，不是 OS 进程、CPU 核或 Chromium renderer 的数量上限。AH 占 3 个 native 配额，AJ 占 4，可与另外 2 个配额的 fixture 重叠；其他真实 native fixture 也计费。嵌套 MCP 验收与共享原树的其他 SDK gate 互斥，避免证据目录发现串扰；私有树的 a-base/b-tooling 使用独立 agent 和证据目录，不占原树 SDK 锁；i-chat 禁用 Pi，n-pi-session/q-info-hub-runs 使用独立 protocol stub，也不占 SDK 锁。默认端口相同的 e-project/ag-execution-wiring-ui 与 drain-http/j-info-hub 分别互斥，保留原端口和显式环境配置。退出归属的短时限验收 AL 占满入口配额，避免其 短时限与退出证据场景与其他受管 gate 争用；原有断言与限时保持不变。verify context 内的小范围 Vitest 调用最多同时运行 4 个 test-file worker；独占入口的 b-tooling 完整套件沿用 Vitest 默认可用并行度。两者都保留默认文件隔离与完整测试集合；这是每次调用的 worker 并发限制，套件内部派生进程仍由各测试负责。未知 gate 作为串行屏障，先等待左侧批次结束，执行自身后才派发右侧批次。单个脚本失败不会中止后续可运行脚本；任一失败即退出 1。运行器导出 `SPROUT_PI_ENABLED=false` 和 `SPROUT_VERIFY_RUN_DIR`，领域脚本仍负责自身后台进程的正常清理。

`a-base`、`b-tooling`、`c-data-auth`、`d-runtime`、`ad-execution-log-ui`、`y-lease-ui`、`t-machine-worker` 通过 `scripts/verify/sandbox.mjs` 在私有测试树内执行原脚本。源码取当前 working tree 的实际内容，保留 staged index、脏改动和删除状态；Git refs/index/config、依赖可写目录、缓存、数据库、输出和 runtime 状态独立。macOS 使用 APFS COW 复制，Linux 使用 reflink/copy；依赖文件不与原树 hard link。私有树有自己的有效 run context，真实 install/build 建立自己的 receipt，不借用或伪造共享 producer receipt。fresh build、真实源码编辑/HMR、migration drift、完整 check/test 和现有时间契约都保留。私有树在结束后移除，选定日志、截图和模型/断言证据导出到原树 `.verify/<gate>/`，以 `sandbox-artifacts.json` 列出本次文件；数据库、身份、agent/session state 和 `.env` 不导出。强制 SIGKILL 无法运行 launcher 清理；正常中断使用 SIGINT/SIGTERM 并等待有界后代清理。

`pnpm verify --only aa-execution-log-contracts,af-execution-cancel-authority` 只执行列出的脚本 id（文件名去掉 `.sh`）。未知、重复、空或越界的 id，以及未知参数，都在清理数据库和运行脚本之前拒绝；`pnpm verify --help` 只打印用法，不创建运行目录或执行脚本。包管理器转发的单个前导 `--` 会被忽略。

每次运行独占 `.verify/runs/<id>/`：每个脚本的 stdout 与 stderr 通过继承的文件描述符写入 `<script>.log`，结束写出 `report.json`。报告记录脚本 id、路径、状态、真实退出码或信号、ISO 开始时间、单调计时的 `durationMs` 和日志路径；outcomes 按原始发现顺序排列，不受并行完成顺序影响。池内 gate 另记资源配额、排队耗时及 sandbox/shared-read-only 模式。`resourceEvents` 记录单调时钟的 acquire/release 和当时占用，配合 `resourceTimeOrigin`、`resourceCapacity` 审核资源上限。总 `durationMs` 包含串行准备、排队和清理的实际总耗时，不累加并行脚本的嵌套计时。`preparation` 单独保存每次实际准备调用的结果和日志；跨未知 gate 的后续批次使用独立日志名。准备失败时，依赖该准备的 gate 不启动，退出码和信号记 null，`blockedBy` 及日志指向实际失败调用；不依赖共享准备的 gate 继续。终端保留 `Verification scripts=N failed=N`、总耗时、报告路径和有上限的失败日志尾部。

完整运行沿用 `.verify/*/verification.sqlite` 的清理；`--only` 只清理选中脚本对应目录的同一文件，避免删除未选中单元的证据。`.verify/runs` 与脚本的数据库目录相互独立。收到第一个 `SIGINT` 或 `SIGTERM` 时，运行器停止派发，把信号转发给所有活跃 gate（或准备进程）的独立进程组，给 launcher 和 trap 留出同一个 10 秒清理窗口。运行器在转发前记录后代进程，并在清理期间继续观察；截止后强制终止仍存活的已观察后代，包括脱离 gate 进程组的后代，再写出部分报告。重复信号继续忽略，中断以首个信号对应的 130 / 143 退出，绝不计为通过。

## 本机与 GitHub Actions 分工

日常使用 `pnpm verify:local` 运行必须依赖真实 macOS 或已安装 Pi 的部分；GitHub Actions 的 Ubuntu job 执行其余部分。`pnpm verify` 仍是单机全量入口，包含全部原始断言与全量单测，便于完整复现；它不因分工而静默缩减范围。分工入口先校验完整门禁与测试文件清单，新文件未分类时立即失败。归属清单见 `scripts/verify/lib/targets-plan.mjs` 与 `scripts/verify/lib/test-targets.mjs`。

CI 分为 base、tooling、docs、contracts、api、turns、browser 七个独立 checkout 的 job，最多六个同时执行，每个 job 内串行运行自己的门禁，避免在 hosted runner 内再次过量并发。共接管 35 个门禁，本机保留 17 个；A/B 是两边明确拆分的部分，联合覆盖原有全部 50 个门禁。A 的类型/静态检查、生产和开发启动、SPA/HTTP、Worker CLI 与 extension 构建交给 CI，真实 Pi CLI 调用留在本机；B 的静态检查、生产 smoke 及通用测试交给 CI，本机只执行专属测试文件。单机全量入口仍执行 A/B 原有全部内容。

63 个测试文件中，CI 执行 60 个，本机执行 `tests/machine-worker.test.ts`（Darwin/sandbox-exec 分支）、`tests/extension-mcp.test.ts`（真实 Pi McpClient）和 `tests/worker-report-budget.test.ts`（真实 runWorker 环境探测）。`pnpm test:ci` 与 `pnpm test:local` 可单独运行各自测试集合；两边都保留文件隔离。CI 测试最多两个 file worker，使用空的临时 Pi agent 目录、清除 inherited Pi runner/module 设置并关闭 MCP_EVERYTHING，避免借用个人安装掩盖依赖。N/Q 等使用生成 protocol stub 的验证属于 CI，不因名称含 Pi 就保留本机；真实 Pi SDK、MCP extension、真实 Worker 初始化/环境探测仍留本机。

`pnpm verify:ci --group docs` 可复现一个 CI job；省略 `--group` 顺序运行全部 CI 门禁。选择清单可通过 `pnpm verify:local --list`、`pnpm verify:ci --list`、`pnpm test:ci --list` 查看。范围由入口设置 `SPROUT_VERIFY_TARGET`，逐门禁报告和 `.verify/targets/<target>-<group>.json` 记录实际范围与退出结果；一个 CI 门禁失败仍继续执行该组其余门禁，最终保留失败退出码。原有 `--only` 继续用于单机全量入口。

Actions 触发于 push、pull request 或 workflow_dispatch，取消同分支旧运行。Linux 中按 lockfile 安装依赖，浏览器组及包含页面链路的 API/turns 组安装 Chromium 和系统依赖，通过显式 `PLAYWRIGHT_BROWSERS_PATH` 供私有测试树读取同一份浏览器程序；可写缓存、数据库与 runtime 状态仍独立。生产生命周期场景直接启动当前 Node 的 `.output/server/index.mjs`，将信号及退出码断言绑定到 server 本身；A/B 的 package start smoke 继续覆盖 `pnpm start` 入口。不安装 Pi、不导入个人认证。仅上传报告及明确列出的 `.log`，不上传整个 `.verify`、数据库、身份或 session；artifact 保留七天。仓库所有者的 Actions 月度计算和存储预算仍适用，多个 job 的耗时分别累计。

集成或交付可使用同一 commit 的 Actions 全部 job 成功结果，加上对应 commit 的 `verify:local` 成功结果，联合证明完整范围。单独一边通过不能称为完整验证通过；有未提交改动时，远端未包含的 diff 必须单独验证并按[证据复用与失效](#证据复用与失效)记录。单机全量验证也继续有效，不再额外重复执行 `pnpm test`。尚未实际运行的 Actions 配置只能报告为已配置，不能报告为 Ubuntu 门禁已通过。

## 验证中的模型调用

`pnpm verify` 默认使用 `SPROUT_VERIFY_CHAT_MODE=model-fixture`。`a-base` 的 Pi CLI 状态探针、`z-lease-integration` 的 Chat 场景和 `az-p5a-live-worker` 的 group/channel 场景都复用本地 SSE 模型 fixture。前者仍启动真实已安装 Pi CLI、加载 `dist/extension/main.js` 并断言一次成功的 `sprout_status` 完成事件；`z` 仍经过真实 Chat、`scripts/pi-host-runner.mjs`、Pi SDK、remote tools、HTTP、SQLite 和 Worker，保留原有 14 项验收条件，包括实际 shell PID/文件、授权拒绝、代次 fencing 和强制收据刷新。`az-p5a-live-worker` 同样经过真实 Chat、Pi SDK、真实 Worker、remote lease/shell 工具、HTTP 和 SQLite，两个场景分别证明 group fanout 与 public channel mention 的唤醒、同一 Agent 串行输入以及实际 shell 标记由 Worker 返回；fixture 只替换模型端点和计划，不替换这些链路。

fixture 从 `PI_CODING_AGENT_DIR` 或默认 `~/.pi/agent` 发现已安装 SDK，仅在临时私有 agent 目录链接 SDK 可执行文件，并写入自己的 models.json、空 auth/settings 和 dummy key。模型目录只配置 loopback endpoint；operator、non-holder 和 CLI status 使用各自固定模型，reasoning=false、thinking=off。不会复制用户凭据、设置或扩展，也不替换 runner、SDK 事件或工具结果。CLI 使用 `--offline` 禁用启动联网。fixture 缺失、SDK 不可用或计划不符均失败，不转入 live；fixture 模式不读取 `SPROUT_VERIFY_PI_MODEL`，z 与 az-p5a-live-worker 同时拒绝自定义 `SPROUT_PI_RUNNER`。

每个场景有独立的有序工具计划。首次 toolCall 前必须验证本轮最新 user message：直接 Chat 请求逐字匹配预期；UI 租约请求验证固定消息格式以及 driver 指定的 action、Machine、generation 和 target，再将 UI 产生的 requestId 绑定到该次工具调用，原有收据检查继续核对该 requestId。历史消息不能满足新轮次。endpoint 核对注册工具 schema、固定参数和当前 call ID 的实际结果后才推进。它只发送 assistant toolCalls 与最终文本，不生成 toolResult、数据库事实或 shell 副作用。未使用步骤、错误模型、异常请求或结果顺序使验证失败。

显式执行真实 provider 验证：`SPROUT_VERIFY_CHAT_MODE=live pnpm verify --only z-lease-integration`；`az-p5a-live-worker` 用 `SPROUT_VERIFY_CHAT_MODE=live pnpm verify --only az-p5a-live-worker`，也可以直接运行 `SPROUT_VERIFY_CHAT_MODE=live bash scripts/verify/az-p5a-live-worker.sh`；CLI 探针可用 `--only a-base`。live 沿用真实凭据，但不猜模型：`SPROUT_VERIFY_PI_MODEL=provider/model` 从环境变量或仓库根 `.env` 读取（`scripts/verify/lib/live-model.sh` 的 `sprout_live_model`），两处都没有时脚本在准备产物前报错退出并说明如何配置，不存在内置默认值。空值和未知 mode 同样在准备产物前拒绝。fixture 通过证明真实工具与生命周期链路，不证明真实 provider 的认证、可达性或模型遵循指令的能力；这些能力应单独以 live 验证。`az-p5a-live-worker` 的 live 模式保留提供方偶发失败的一次重试；显式选择的模型不存在或没余额时报错停下，不换模型。fixture 模式不重试，失败即失败。

stdout 和 `a-base/model-mode.json`、`p4b-integration/evidence/run-*/model-mode.json`、`.verify/p5a-live-*/model-mode.json` 标明实际 mode、provider/model、thinking、请求数、完成计划和未使用步骤；live 中未跟踪的请求/计划数记为 null。导出的元数据不包含私有 prompt、session 或凭据。零付费模型调用的依据是私有模型目录、loopback endpoint 和所有调用方的模型固定配置，并非整台宿主的网络抓包结论。完整 runner 已令其他应用脚本的 `SPROUT_PI_ENABLED=false`，`n-pi-session` 使用明确的协议 stub；单独运行其他脚本时仍需另行判断其模型开关。fixture 需要本机已安装的 Pi SDK，不消除这一前提。

## 当前 run 的构建准备

构建调用统一通过 `node scripts/verify/prepare.mjs install|server|worker|extension [--fresh]`。运行器在新建的 `.verify/runs/<id>/context.json` 记录仓库根目录、run id 和 owner PID。helper 只在目录、根目录和活着的 owner 均匹配时读取该 run 的成功 receipt；传入失效或损坏的内部 context 会明确失败。没有 `SPROUT_VERIFY_RUN_DIR` 时，独立调用总会基于当前源码执行，不因旧产物存在而跳过。不同 run 不复用；同一 checkout 仍只支持一个验证调用。

`--only` 仍只执行精确选中的 gate；选中的共享消费者也先准备其声明的产物，不依赖 `a-base` 先运行。共享 server、worker、extension 的准备使用 `NODE_ENV=production`；Worker artifact helper 仅对编译调用固定该环境，保留调用方后续测试及 runtime 的环境。共享消费者导出的内部环境 `SPROUT_VERIFY_PREPARED_ONLY=1` 使 helper 只允许复用已验证 receipt；输入变化、缺失产物、无有效 context 或 `--fresh` 等生产请求均在删除 receipt、产物或创建生产日志前失败。隔离 launcher 在自己的树内改为 prepared-only=0，允许私有实际生产。批次期间不能外部修改共享源码或构建输入；同一 checkout 仍只支持一个验证调用。该保护不改变 standalone helper 的正常构建语义。

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

coordinator 在合并前独立核对 diff、证据，并复跑该单元所需范围。worker 自报通过是证据，不代替 coordinator 验证。文档单元复跑文档检查，代码单元复跑受影响领域检查；独立复跑不等于全量复跑。复跑前核对脚本内含的检查，去掉本轮执行计划中的重复项；保留重复项时写明新增风险或独立取证的理由。交付前的整段复核用 `pnpm verify:local`：它只跑 `scripts/verify/lib/targets-plan.mjs` 里 `LOCAL_GATES` 的 19 个门禁，即必须在本机 macOS 与真实 Pi 环境下跑的部分（真实 Worker、真实 Pi CLI/SDK/MCP、真实页面）；61 个门禁里另外 42 个由 CI 的 Linux 分组覆盖，只有 `a-base` 与 `b-tooling` 两边都跑（同名的两份检查只在 macOS 侧含本机专属用例）。同一 HEAD 已有一轮 0 失败就复用那份结果并记下来源，不因为「顺手再跑一遍」重跑第二遍。

完整验证安排在明确的集成批次或交付节点，不在每个中间单元重复执行。独立验收的范围覆盖该节点的交付要求，不能因为单元定向验证通过而省略。在集成分支上，先把它与 `main` 同步、解决冲突，再在同步后的头部跑完整验证与独立验收，并把该 commit 记成受验对象；之后 `main` 只接收这个受验形态。

## 完整验证与去重

`pnpm verify` 调用 `scripts/verify.sh`，跑全部 61 个门禁并包含全量 `pnpm test`；它属于与 CI 对等的整段复核，在没有 CI 结果时才需要，日常交付用上面的 `pnpm verify:local`。本机 `scripts/verify.sh` 的并发上限（6 个进程、6 条 native 车道、3 个浏览器）按空闲机器估算，机器同时在跑索引或别的 agent 时，时间预算型的门禁会假红；判红前先看 `uptime`，再单独复跑该门禁。`scripts/verify/b-tooling.sh` 是完整验证中全量测试的唯一执行入口，其他验收脚本保留领域定向测试。

同一轮完整验证不再另外追加全量测试。领域验证同样去重。例如 `scripts/verify/g-identity-data.sh` 已包含 `pnpm check` 和 `tests/identity-data.test.ts` 的定向测试，未发生相关改动时，不在同一执行者的同一轮计划中另加相同检查。修复前后对照、快速定位失败或独立验收需要重复执行时，保留并说明目的。

只有后续改动、验证失败或尚未解决的具体风险要求时，才扩大或重复验证，并记录原因。

## 验证开销的账

每次运行都把一行记进 `.verify/spend.jsonl`（HEAD、目标、总时长、逐门禁状态与耗时）。报告目录会被裁剪，账本不会，`pnpm verify:spend` 读它给出总时长、按目标与按门禁的聚合，以及「同一 HEAD 跑了几遍全量」。

`pnpm verify` 在开始前查账本：同一 HEAD 已经有一轮 0 失败的全量就直接 `SKIP` 并退 0，只打印可复用的时长与来源。确实要重跑时设 `SPROUT_VERIFY_REPEAT=1`。`--only` 与 `pnpm verify:local` 不受这条限制。

判断范围之前先看这三个数字：要证明的行为、该门禁的自身耗时（账本可查）、以及这台机器的 `uptime`。满载机器上的时间预算型门禁会假红，那种红不是证据。

`aa-execution-log-contracts`、`af-execution-cancel-authority`、`ai-execution-accept-fixes`、`ak-execution-accept-fixes-2` 通过各自的 Vitest wrapper 执行一次隔离 fixture，移除脚本内相同 fixture 的直接重复调用。wrapper 保留独立子进程、私有数据库、test 环境、禁用 Pi、所需随机 auth secret、proxy 前提、PASS/退出与超时检查，并在 finally 清理临时目录。独立 live/browser 验收和 `b-tooling` 全量测试仍保留。`ac-execution-recovery-log` 与测试中的 recovery fixture 尚未证明环境等价，继续各自取证。

## 证据复用与失效

验证记录注明覆盖的 commit、实际命令、退出码、日志或其他产物。验证未提交改动时，同时保存基准 commit、完整 diff 和必要的内容哈希，不要求先 commit 才能验证。仅创建 commit，不自动触发重跑；门禁或产物绑定 commit 时，按其实际要求重跑。

耗时区分 runner 执行时间、工具等待与工作流总时间，不能把后台启动命令返回的时间当作任务执行时间。

已有完整验证通过后，仅补说明、修链接或记录 Human 判定，不会自动使代码验证失效。保留原代码 commit 的验证证据，另记本次文档检查；不得写成本次 HEAD 已重新全量验证通过。

证据复用前，确认原受验 commit 与当前版本的关系、此后的完整 diff，以及运行环境和外部依赖是否仍符合原验证前提。对改变了受验行为、依赖、构建、数据库、环境或门禁的后续改动，按其影响重新验证。对绑定当前内容哈希或 commit 的产物，按对应门禁重新检查，不能仅因祖先关系成立就沿用。

Human 体验确认与技术验收分别记录。仅在文档中记录 Human 判定不触发完整技术验证。
