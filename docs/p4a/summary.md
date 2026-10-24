# P4a Worker 连接与 Project 绑定

P4a 已收尾：四轮独立技术验收均判定通过，Human 体验确认已记录（见本章末）。P4a 是 I-P4a 集成单元的功能与 UI 章节记录；本文件不是设计定稿，也不替代编排 store 里的证据。

Human 可从 Machines 创建 Machine 身份，按详情给出的实际命令构建、复制并初始化 macOS Worker，再运行独立进程主动认证连接。详情展示配对、连接代次、实际 shell 能力与目录观察。Project settings 提供本人 Machine 的加入入口、说明和工作目录。

## Round-4 呈现反馈

Shell 区仅展示当前可用能力；断联且能力不可用时只显示「Worker 已断连」，连接中或在线尚未上报能力时分别说明实际状态。遵照 Human「看上次的快照没有意义」的判断，不保留灰色勾叉或旧能力详情入口。左栏连接历史事实仍保留，current 判定不变。

详情 loader 每次刷新完成后间隔 5 秒自动刷新，后台标签页暂停、卸载清理；手动刷新仍可用。root 与绑定说明在编辑或聚焦期间保留原输入和草稿 revision，待提交请求也不因刷新消失；会话内票据不随 loader 更新清除。

目录的 missing、not_directory、denied、io_error 统一显示中文原因和下一步操作。missing 说明期望目录不存在、一期不会自动创建、需在 Worker 机器自行创建或修改 root；保留代次、revision、检查时间。四种最终文案和技术证据见 `docs/ui/p4a.md` 与 `orchestrate/sprout-mio-p4a/reports/worker-reports/sprout-p4a-review-round4-report.md`。本轮没有修改领域、契约、DB 或 Worker。Human 已在 `5d49e80` 上确认体验通过，见 [Human 体验确认](#human-体验确认)。

## 交付范围

Machine 身份、配对、连接、Project 绑定意图和 Worker 观察分别建模。目录保存不代表目录已可达。连接离线不推断空闲、释放或租约。能力和目录的 `current` 由 boot、generation、binding revision 决定，同代合法观察不因离线自动作废。

工作目录模型已在下面「体验后变更」中改为 Machine 级 root，第一段里按 Project 填写目录的描述作废。页面通过五秒自动刷新与显式刷新读取最新事实。安装票据默认隐藏，只在当前 React 会话暂存，不进入 loader、URL、history 或浏览器持久存储。刷新页面或离开 Machines 后，pending 身份可重新续签。

票据在父级 Context 中的归属由三条规则决定，三轮修复逐条闭合。

- 续签成功后，迟到的结果只在发起它的详情身份仍在使用时写回父级。
- 放弃在途续签（组件卸载，或 `machineId` 变更）时，撤销该 target 的父级槽位。服务端结果未知，按已失效处理。
- 已结算并成功写入的结果跨列表导航保留，不被后续离开误撤销。

Info Hub 的 machines 使用真实集合，leases 独立标记未实现。P4b 的租约与远端操作、Machine 移除、LaunchAgent 不在本章范围。行为与边界见 [功能实现](functional.md)、[契约](contracts.md) 与 [Worker 安装](worker.md)，呈现与演示见 [UI 交付](../ui/p4a.md) 与 [真实接入](../ui/p4a-integration.md)。

## 功能交付证据

功能提交 `43d5f9b` 在 `3da9fdd` 合入，共享契约提交 `0a33103`。编排者复跑检查、类型、单测、Worker 与 Web 构建以及 `bash scripts/verify/t-machine-worker.sh`，覆盖隐藏票据输入、私有身份文件、同 attempt 幂等、旧 boot/generation/seq 与旧目录 revision 拒绝、服务中断后重连、宿主重启与 SIGTERM。独立安全复核无阻塞项。

该脚本使用真实 macOS Worker 与真实服务、SQLite，跨机 TLS 与反代未验证。

## UI 交付证据

共用组件提交 `5f5e49b` 在 `2a56c81` 合入，演示与正式页面复用同一套呈现组件。演示覆盖失败保留、空说明、续签异常、Machine 切换、A 到 B 再回 A、卸载、同身份刷新和每次 DOM 提交的票据归属。

安装命令更新后，演示脚本的旧占位目录期望在 `97cca61` 修正，行为断言未弱化。编排者查看过真实接入的浅暗主题、390px 绑定与安装区、列表、Project settings，以及 900px、901px、1199px、1200px、1440px 代表截图。代码块单独水平滚动，长 ID 与目录换行。接入后的真实页面检查用 `bash scripts/verify/u-machine-ui.sh` 复跑。

已披露一个非阻塞可读性问题：较长的绝对工作路径会把绑定区的「当前可达」标签挤成逐字竖排。修复方向是让状态文字保留不收缩宽度、路径负责截断，属于后续视觉调整，不影响本章技术结论。

## 技术验收证据

第二轮被验版本 `74fccd4`，独立结论为技术验收通过，并记录两处遗漏（三份文档仍写旧的 allow-http 结论、TLS 守卫错误被通用提示吞掉），两者在 `97a530b` 修复；第三轮被验 head `6702ccc` 的独立验收同样通过。重跑入口为 `bash scripts/verify/u-machine-ui.sh`、`bash scripts/verify/t-machine-worker.sh` 与 `bash scripts/verify/k-acceptance.sh`，完整报告见 `orchestrate/sprout-mio-p4a/reports/acceptance-round2.md` 与 `acceptance-final.md`。

第三轮（`8d79327`）与第四轮（`5d49e80`）的独立技术验收结论：通过，无阻塞项。被验 SHA `5d49e80`，由未参与实现的另一模型家族在 `git archive 5d49e80` 的独立 checkout 上执行，自建 production 构建、独立 SQLite、Worker state、Chromium 与新注册账号，真实 macOS Worker 驱动目录观察；自建探针 100 条布尔全为 true，五个实现方脚本串行复跑退出码全 0（`bash scripts/verify/t-machine-worker.sh`、`bash scripts/verify/u-machine-ui.sh`、`bash scripts/verify/k-acceptance.sh`、`bash scripts/verify/s-machine-contracts.sh`、`node scripts/browser/p4a-machine-scenes.mjs`）。

本轮最重要的反证是自动刷新放大了上一轮修过的静默覆盖风险：实测 root 与绑定说明在外部先改并经历自动刷新后，提交请求仍携带编辑起点的 revision（2 / 1），服务端判 conflict，对方事实未被覆盖，草稿留存；自动刷新真实间隔实测约 5030ms；后台十二秒零请求，卸载瞬间有刷新在途时其后十六秒仍零请求；会话内续签票据与 pending 状态不被刷掉。其余核对：能力非 current 的三种状态下 shell 摘要触发元素 `count() === 0`（不存在而非隐藏），文案按实际状态区分；勾色读计算后的颜色值，宽弹窗计算宽 896px；active 详情全文「已配对」仅一次且 `run` 命令仍可达；目录四种 unavailable reason 全为中文且不宣称代用户创建，missing → accessible 由真实 Worker 探测驱动并与 SQLite、HTTP 一致。报告见 `orchestrate/sprout-mio-p4a/reports/acceptance-r34.md`，结果副本见 `acceptance-r34-evidence/`。

一处归属误判已由编排者纠正：该报告把 19:55–20:11 的四个 docs 改动归给同一工作树的其他 session，实际是编排者本人的 `1b95d3b`，只改文档、未动代码、测试或迁移，不影响它对 `5d49e80` 代码的技术结论。

第一轮被验版本 `90a6af7`，合入为 `e10a5b4`。独立验收由未参与实现的另一模型家族执行，使用自有 checkout、自建 production 构建、独立 SQLite、独立 Worker state、独立 Chromium 与新账号。独立探针 41 条布尔全为 true，退出码 0。

三条互斥的票据路径都在同一被验 head 上闭合。

- 正常：创建、续签、停留至完成、返回列表重开，看到续签票据，创建票据不复活，sha256 与 SQLite `ticket_hash` 一致，并用该票据真实初始化并连接独立 Worker。
- 跨 Machine：A 续签在途时切到 B，A 的迟到结果落地后 B 的票据与哈希不变、仍 pending、可自行续签。
- 同 Machine 在途放弃：服务端已替换哈希后返回列表，交付被放弃的响应再重开，展示要么没有票据且可再次续签，要么与 SQLite 哈希一致，绝不等于创建票据。

同时核对撤销不会误杀合法票据（已结算后离开、槽位属于另一台 Machine、连续两次进入后正常续签），真实 Fn 授权边界（匿名 `unauthorized` 且不泄露、跨 owner `not_found`、跨 Project 绑定被拒），失败续签保留仍合法旧状态且错误安全，以及真实 SIGTERM 后同 boot/generation/binding revision 的观察 `current` 不被降级。

编排者在合入后于 main 复跑 `bash scripts/verify/u-machine-ui.sh`，13 组全过，其中包含 `late renewal from a previous Machine does not replace the current parent enrollment` 与 `abandoned in-flight renewal revokes the same Machine parent ticket`。演示脚本 27 项通过。完整结论见编排 store 的验收报告与 `reports/main-merge-verify.log`。

未验证项：跨机 HTTPS 与反代、其他 CPU 架构与 Node 版本、真机软键盘、物理断电、强杀 Worker 后的心跳超时离线路径、服务端已成功而响应丢失的网络故障。技术验收不扩展 P3 已记录的部分交付边界。

## 体验后变更

Human 于 2026-10-24 亲自体验 `3df7f2c`，给出六条反馈。其中前两条改变领域模型，推翻本章原设计里的两个决定：目录不再是 `Project × Machine` 的意图字段，也不再由人自己在每个 Project 里填写。

新模型。

- Machine 有一个 root 工作目录，创建后设置；修改 root 需要警告，一期不做工作目录迁移。
- Project 绑定不再填目录。该 Project 在此 Machine 上的 git 路径与工作路径是服务端派生的 `<root>/<project_id>`，不另存一份可能不一致的事实。
- 详情中的「Project 绑定」区改为设置 root 工作目录的区域，并显示每个已绑定 Project 的派生路径与观察事实。
- 目录观察的 `revision` 改为跟随 root 版本：派生路径只随 root 变化，编辑说明不应把合法观察翻成旧事实。

一期不自动创建该目录，这是我的默认决定，不是 Human 的要求，可以被一句话改回。理由：P4a 的交付范围是连接与观察，远端写文件系统属于 P4b；`missing` 已是诚实状态，页面显示期望路径与「当前不可用 · missing」。Human 描述的「直接创建」读起来是在说明路径归属，而不是授权 Worker 写文件系统。若改为自动创建，加一处 Worker mkdir 即可；反过来先给写权限再收回，会留下已建目录和既成预期。

其余四条是实现与呈现修正，不改变领域：Project settings 点绑定却跳回 Machine 详情页是缺陷，改为在本页就地完成绑定；未配对时配对与安装说明前置到最显眼位置；安装文案精简、协议尾注默认收起、allow-http 用问号弹窗说明；Shell 能力折叠为 zsh / bash / sh 的勾与叉，详情走 tooltip。

本章四步 checklist 因此全部取消勾选，等待第二轮复验。票据生命周期的三轮修复结论仍然有效。第二轮由 `bash scripts/verify/u-machine-ui.sh` 与 `bash scripts/verify/s-machine-contracts.sh` 复验，独立结论见 `orchestrate/sprout-mio-p4a/reports/acceptance-round2.md`。

### 第二轮复验与三条呈现修正

上面六条在第二轮全部落地，main `97a530b` 为当前被验 head。领域两条以 `43aa6c3` 合入（`f9c6598`），呈现修正在 `455e46c`、`980e68d`、`3fec3a3` 与 `f0a6102` 四轮分别合入 `74fccd4`、`3d09703`、`fa12a6c`、`6702ccc`。

root 冲突保护在第二轮复验中被证实原本失效并已修复：loader 刷新会把仍在编辑的草稿 `expectedRevision` 重基到最新值，于是外部先改 root 后页面提交不再冲突，静默覆盖对方。修法是草稿持有开始编辑时的 revision，只有明确的重试才用刷新后的 revision。复跑证据 `.verify/` 下 `root-draft-refresh.json` 记录 baseline 2 / concurrent 3 / submitted 2 且首次提交被 conflicted 拒绝。

Human 在第二轮选择了两个原先开放的问题：Shell 能力采用一行摘要（`✓ zsh · ✓ bash · ✓ sh`），详情由悬停、点击与键盘聚焦三者共同触发；allow-http 采用显式开关，而不是把「非 loopback 必须 HTTPS」写进文案。allow-http 按逐 origin 精确授权实现（含端口，不放行同网段其他地址），授权写入身份文件并在 `run` 时重新校验，不提供关闭 TLS 验证的选项。

独立技术验收（未参与实现的另一模型家族，自有 `git archive 6702ccc` checkout、自建 production 构建与独立 SQLite / Worker state / Chromium / 账号）判定技术验收通过，并抓到两处遗漏：三份文档仍写旧的 allow-http 结论，以及 TLS 守卫的错误被通用提示吞掉导致用户看不到原因。两者已在 `97a530b` 修复，`l-docs.sh` 与 `l-docs-probes.sh` 在 main 上退出 0（7 个探针通过）。

## 第三轮呈现反馈

基于 main `edb316b`，本轮只调整共用呈现组件：active 详情删除配对与票据区及页头重复状态，仅在连接事实中保留一次「已配对」；主内容使用整宽，安装与启动命令移至详情底部，`run` 保持可读取和选择复制。pending 的配对与安装区继续置顶。

Shell 延续方案 B 的单行摘要与平台信息，按本轮 Human 决定改为有边框的按钮打开共享 `Dialog`，覆盖上一轮的悬停与聚焦展开方式。Enter / Space 可打开，Escape 可关闭；宽弹窗呈现路径、完整版本、自检与检查时间，unknown 和旧代次限制保持。验证命令、DOM 与截图证据见 [UI 交付](../ui/p4a.md) 及 `orchestrate/sprout-mio-p4a/reports/worker-reports/sprout-p4a-review-round3-report.md`。第三轮与第四轮实现均纳入 Human 在 `5d49e80` 的确认范围。

## Human 体验确认

- 确认记录：Human 亲自体验确认通过，版本 `5d49e80`

体验过程跨四轮：Human 先体验 `3df7f2c` 并给出六条反馈（其中两条改变领域模型），随后在 round-2、round-3、round-4 的真实页面预览中继续给出反馈与两个方向选择，最后在 `5d49e80` 上表示「无更多反馈」，经编排者确认后回复「是」，即确认本章通过。该确认针对 round 3 与 round 4 的呈现改动；第三、四轮的独立技术验收在确认之后仍在进行，若其结论出现阻塞项，本格需重新打开。

期间 Human 也明确否决了一个已实现方向：断联时不保留 shell 摘要与「上次快照」入口，直接说明 Worker 已断连（见 [Round-4 呈现反馈](#round-4-呈现反馈)）。

推荐体验顺序。

1. 创建 Machine，续签票据，再返回列表并重开，确认详情保留当前续签结果。
2. 在独立终端按详情命令初始化并运行真实 macOS Worker。刷新详情，查看已配对、在线、代次与 shell 事实。
3. 在 Machine 详情设置 root 工作目录，再从 Project settings 的 Machines 区选择该 Machine 并保存说明。选择后应停留在 settings 页，绑定表单就地出现并用分派的 revision 提交，不跳回 Machine 详情。
4. 在另一个本人 Project 绑定同一 Machine，核对两者派生的 `<root>/<project_id>` 路径不同且各自被 Worker 观察到。
5. 在另一个窗口用 RPC 改 root 后再在页面提交草稿，核对报冲突、页面显示对方 root、草稿保留，显式重试才成功。
6. 停止 Worker 后刷新，再启动并刷新，核对离线与重连，页面不推断空闲或释放。
7. 核对未配对时配对与安装是否在最前，Shell 能力是否折叠为一行并可展开，问号弹窗对 allow-http 的说法是否与实际一致。
