> 路径迁移说明。下文保留验收基线时的文件名与行号。当时的 `docs/development-plan.md` 现为 [功能开发专项计划](../development-plan-functional.md)，`docs/integration-plan.md` 现为 [开发总计划](../development-plan.md)，`docs/ui-development-plan.md` 现为 [UI 开发专项计划](../development-plan-ui.md)。当前编排必须从开发总计划进入。

当前状态。本文保留当时的交付与验收记录。P4a 已将 Machine 整体占位改为实际 `MachineDetail[]`，租约独立保持未实现。当前契约、接入与验证见 [P4a 正式接入](../ui/p4a-integration.md)。下文旧占位形状和文案是历史记录。

本验收由 `magpie/group/auto-glm-5-3-flash`（glm 家族）独立完成，该家族在 P3 没有任何代码、文档或验收产出；验收依据由 `docs/development-plan.md` 的 P3 段推导，不采信作者文档的自述。

# P3 阶段验收（p3-e-acceptance）

**验收者**：p3-e-acceptance，模型 `magpie/group/auto-glm-5-3-flash`（glm 家族）。**独立性相对谁**：相对 p3-a 与 p3-f（sol）和 p3-b、p3-c、p3-d（mimo）的家族都不同，且 glm 在 P3 的任何 unit 里没有产出过代码、文档或验收记录，符合 SO24 的「按阶段判定」。本验收的一切证据由本机独立复跑与直接 SQL 实验产生，不采信任何作者自述或 coordinator 转述。

**验收基线**：main `55da85fe67a7341b2ca5b657756d9a78faf38941`（PR #22 合并后）。工作树含既有非本阶段脏文件（`docs/development-plan.md` 的 P5a/P5b 拆分改动、未跟踪的 `docs/integration-plan.md`、`docs/ui-development-plan.md`、`docs/ui-ref/`），见到且未触碰。

**方法**：先把 `docs/development-plan.md` P3 段（73 行起）的七条 checkbox 与出口条件改写为可判定命题，再从代码、SQLite 实值、真实模型运行与直接 SQL 反证四类来源找证据。`docs/p3/*.md` 只作为待核对声明；每份文档抽样回验见「文档与代码一致性」。发现清单在 `/tmp/p3-e-acceptance/findings.md`。

## 门禁复跑（全部本机、全部附退出码）

| 命令                                                 | 结果                                                                                                                                                                                    | 证据                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm test`                                          | 0，17 文件 124 测试通过                                                                                                                                                                 | `/tmp/p3-e-test.log`                                             |
| `pnpm check`                                         | 0，150 文件格式、121 文件 lint/type                                                                                                                                                     | `/tmp/p3-e-check.log`                                            |
| `bash scripts/verify.sh`                             | 0，`Verification scripts=20 failed=0`（302 PASS 行）                                                                                                                                    | `/tmp/p3-e-verify.log`                                           |
| `bash scripts/verify-live/pi-dm-turn.sh`             | 0，真实 deepseek/deepseek-flash：三轮口令复述、真实 SIGTERM 重启同 session 文件续史、steer 进当前轮（STEER_OK）、用户停止 aborted 无回复、profile 下一轮 PROFILE_V2、真实 Chromium 截图 | `/tmp/p3-e-live-dm.log`、`.verify/live-pi-dm-turn/evidence.json` |
| `bash scripts/verify-live/pi-repo-analysis.sh`       | 0，真实模型读推送仓库并复述文件内标记，快照 commit = provenance commit = 远端 HEAD `5564568e`                                                                                           | `/tmp/p3-e-live-repo.log`                                        |
| `bash scripts/verify/q-info-hub-runs.sh`（单跑复验） | 0，12 条 PASS 含三条跨 Project 零泄漏                                                                                                                                                   | `/tmp/p3-e-q.log`                                                |

复跑重写的证据 PNG 已用 `git checkout -- docs/p1/evidence/ docs/p3/evidence/` 复原。结束时 `git status --short` 只剩上述四个既有脏文件。

## 出口条件判定

plan 原文：**Human 不创建 Task、不申请 Machine 租约，也能在 DM 分析已推送的仓库内容。后续轮次保持身份和会话历史，当前轮可接收新消息。**

| plan 原文命题                                       | 判定     | 证据                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human 在 DM 分析已推送的仓库内容（无 Task、无租约） | **成立** | live `pi-repo-analysis.sh` 退出 0：Project 只配 `gitRemote` + `defaultBranch`，DM 发消息后分身真实读到文件并复述标记 `MARKER_LIVE_P3C_baf1d88238b2`，全程无 Task/Machine/租约对象参与；run 的 `config_snapshot.repo.commit` = `repo_provenance.commit` = 远端 HEAD `5564568ebb2e2c2f8ca43afec95b3d38dbf16077`，`recordedAt` 落在本轮窗口 |
| 后续轮次保持身份和会话历史                          | **成立** | live `pi-dm-turn.sh`：第 2、3 轮复述第 1 轮口令 `MIO_1a433c6ed6e886d047b33f75`；真实 SIGTERM 重启（boot `158b2f31` → `35a2bfc0`）后第 3 轮在同一 session JSONL 上复述口令；真实 Chromium 显示全部三条持久回复                                                                                                                            |
| 当前轮可接收新消息                                  | **成立** | live：运行中投递的第二条消息同 run、同 session、`delivered`，回复 `STEER_OK` 只含 steer 指令内容                                                                                                                                                                                                                                         |

## 七条 checkbox 逐条判定

### 1. 将持久分身映射到 Pi session，记录每轮配置快照和 run 状态 — **成立**

- session 映射：`agent_run.session_id = instance_id`，runner 用 `SessionManager.open(该文件)` 复用（`scripts/pi-host-runner.mjs:225-232`），文件缺失显式失败不造替代会话。live 证实跨重启同一 JSONL。
- 快照：每轮 `ready` 事件落 `config_snapshot`（model、provider、thinking、tools、extensions、sessionId、sessionFile、cwd、sdkVersion、profile 含 updatedAt）。live 库实读：6 条 run 的快照 provider/model 均为 `deepseek/deepseek-flash`，与真实 transcript 的 assistant 一致（live 脚本逐轮断言 PASS）。
- run 状态：六态状态机集中在 `src/domain/agent-run.ts` 的 `NEXT` 表，非法迁移抛 `conflict`；`queuedRunWork()` 只调度 queued，`transitionAgentRun` 要求 running 必带快照且 sessionId 匹配（`agent-run.ts:197-201`），queued 无快照不补造。
- 直接 SQL 反证：completed + `stop_reason='error'` 被拒（CHECK）；completed + `stop_reason=NULL` 被拒（SO28 守卫在位）；failed 无 errorCode / 空 errorMessage 均被 `agent_run_failed_check` 拒绝。

### 2. 保留宿主 Pi 工具、配置与认证，加载 Sprout extension — **未完整交付（部分交付）**

这是本验收最重要的差异项。三个子句逐一判定：

- **认证：交付。** runner 从 `~/.pi/agent` 只读 `auth.json` 与 `models.json`（`ReadOnlyAuthStorage`），模型目录只读；`runtime.hasConfiguredAuth(provider)` 缺凭据显式失败。
- **配置：交付。** settings 默认值、thinking 级别、defaultProvider/defaultModel 回退全部消费 Pi settings；SDK 解析自托管安装的真实 release（本机 1.3.0，快照 `sdkVersion: "1.3.0"`）。
- **宿主 Pi 工具：未保留。** live 库 6 条 run 的快照 `tools` 恰为 `["bash","edit","read","write"]`，extensions 恰为 `["sprout-extension"]`。SDK 的默认工具全集 `DEFAULT_TOOL_NAMES`（实测 Pi 1.3.0 `dist/core/settings-manager.js:35`）就是这四个，所以四个编码工具在；但宿主的其余能力（codemode、tool_search、MCP 内置 extension，以及用户 extension/skills）被 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 显式关闭，且未进 `tools` 白名单。这不是猜测：P0 文档自己列了这三个内置 extension，作者也在 `docs/p3/pi-session.md:102` 承认「codemode、tool_search、MCP 三个内置 extension 本次均未加载，仍未验证」。**plan 第 2 条的「保留宿主 Pi 工具」按字面成立要求这些宿主工具分身可用，实测它们不可用。** Sprout extension 本身已加载且生命周期绑定（live transcript 断言 `sprout-session-binding` 标记，PASS）。
- 结论：**第 2 条部分交付。** 分身拥有的是「受控的最小 Pi」而非「宿主 Pi」。若 P4+ 的分身工作需要 codemode/MCP，这是后续阶段的功能缺口，不是验收失败；但 plan 的字面承诺与交付物的差距必须记入阶段结论，不应在 f 收尾时无声抹平。

### 3. 实现同分身串行、新消息进入当前轮、停止及明确的错误结果 — **成立**

- 串行：partial unique index `agent_run_one_active_instance`（`WHERE status IN ('queued','running')`）。**用两个真实并发进程实测**（持锁进程插 running run 按住 8 秒，另一进程绕开应用层直接 SQL INSERT 第二个活跃 run）：`UNIQUE constraint failed: agent_run.instance_id`，直接 SQL 也被数据库挡住。
- 新消息进当前轮：运行期间新 human 消息追加 `pending` 输入不建第二个 run（`appendHumanRunInput` + 上述索引），宿主 100ms 轮询 steer 进当前轮；live 证实 `STEER_OK`。
- 停止：`abortAgentRun` 走状态机置 `aborted` + `stop_reason='aborted'`，`signalRunAbort` 只传导给活子进程；live 断言 `assistantMessageId=null`、无 agent 回复消息。停止后 pending 输入去向明确：hermetic o 脚本断言「停止后 pending 输入保持 pending 且 UI 显示未投递」，迟到投递确认被 `markRunInputDelivered` 的 conflict 捕获保持 pending（`pi-host/index.ts:81-87`）。
- 错误结果：`failed` 必带 errorCode 与非空 errorMessage（领域层 + DB CHECK 双重强制，直接 SQL 反证通过）；`stopReason:"error"` 在 runner（`prompt()` 检查全部新增 assistant message）、父进程（`process.prompt()` 要求 `settled` 且 `stopReason==='stop'`）、completeAgentRun（要求 `stop==='stop'`）三层都不被当成功；hermetic 反证「THIS MUST NOT BE SAVED」零落库。

### 4. 实现宿主仓库入口，支持复用已有副本与按需获取数据，不仅支持手动绑定目录 — **成立**

- 两条路径都在：`bound_copy`（复用 `workDirectory`）与 `managed_clone`（按 `gitRemote` 按需 clone/fetch，`src/domain/repository.ts:130-196`）。
- **`fresh` 实测（构造复用场景，不读代码下结论）**：自建远端推进一次提交、绑定副本落后，走领域层 `prepareRunRepo` → `recordRunRepoBasis`，实值 `{preparedFresh:false, provenanceFresh:0, snapshotRepoFresh:false, provenanceCommit==副本旧HEAD==1d0a7052, 远端HEAD==dae3d2d4, 工作树未动, fetchedAt已记录}`。复用旧副本时 `fresh` 如实为 false，不冒充取到新提交。
- 失败不回退：`repo_workdir_missing` 等显式失败（hermetic p 脚本 + 本验收 disk 探针旁证路径）。

### 5. 记录分析依据的来源、commit 或 ref 与获取时点。处理并发更新、Git 认证失败和磁盘占用策略 — **成立**

- 来源/commit/时点：`repo_provenance` 每 run 一行（UNIQUE），`commit` 为 `git rev-parse` 实值非拼接；live 三方一致断言 PASS。
- 并发更新：进程内 per-Project promise 锁 + `preparing` 状态行；vitest 实测同 Project git 操作逐段串行、不同 Project 互不阻塞。范围明确限单进程宿主（`docs/p3/repo-entry.md` 已声明，未冒充跨进程保证）。
- Git 认证失败：`GIT_TERMINAL_PROMPT=0`、askpass 置空、BatchMode、120 秒强杀（`src/server/git/git.ts`），四类错误码 hermetic 复现（401 HTTP 远端、不存在路径、坏分支等）。
- 磁盘策略：**实测** `SPROUT_REPO_MAX_BYTES=1` → `repo_disk_limit`，`repo_provenance` 零行，绑定副本未修改。淘汰未实现且文档如实声明。

### 6. 将 Agent status、活动 runs 和错误接入 Info Hub，提供轮初必要上下文 — **成立**

- 两视角 `runs.available=true`，事实全部来自领域查询（`listAgentRuns`/`listAgentRunInputs`/`getRunRepoBasis`），页面层不重拼（`src/components/info-hub/run-facts.tsx` 只消费视图对象）。
- 未实现项保持显式：`machines: {available:false, reason→P4}`；Task/Group 不在契约中；UI 的 `UnavailableNotice` 保留。
- `pending` 不显示为已投递：视图按 `disposition==='pending'` 计数，文案一律「N 条输入未投递」，hermetic 断言整页不出现「已完成」冒充。
- 越权：**独立构造反证**（自建第二个用户 intruder，不经 q 脚本的 token 列表）：9 个查询入口全部 `ProjectAccessError(not_found)`，零泄漏；对真实 provenance 行的跨用户 `getRunRepoBasis` 同样 not_found。
- `injectedIntoPrompt` 为 `z.literal(false)`（`src/contracts/info-hub.ts:156`），UI 明示「注入模型 prompt：否」，文档没有声称模型可见；四条不注入理由成立且已编码进类型。

### 7. 验证 profile 更新仅影响下一轮，宿主重启后不虚构旧 run 已成功完成 — **成立**

- 下一轮生效：live 运行中编辑 persona，该轮快照不变、回复不带新 persona；下一轮快照换新、真实 transcript 的 system prompt 含新 persona、模型回复 `PROFILE_V2`。
- 不虚构完成：**直接 SQL 实验**——插 running run 后跑 `recoverAgentRuns()`，实值 `{status:'interrupted', errorCode:'host_interrupted', errorMessage:'宿主上次未正常关闭', assistantMessageId:null, settled:true, 诊断1条}`；重复恢复不重复写诊断。live 侧真实 SIGTERM 后 running → interrupted 亦由 hermetic n 脚本真实进程验证。

## 冻结契约核对

| 契约                                        | 判定           | 证据                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK 子进程 + 显式 ModelRuntime + 显式 model | 成立           | runner 独立进程 `scripts/pi-host-runner.mjs`，`ModelRuntime.create` 显式构造，`session.model` 与显式配置核对不符即失败；裸 `createAgentSession()` 无                                                                           |
| config 全经 `src/lib/config.ts`             | 成立           | `grep process.env src/**` 仅 4 处：config.ts 边界本身、server-entry 的 TSS/SERVER_SHUTDOWN_TIMEOUT（srvx 关闭参数，非业务配置）、pi-host/index.ts:55 与 git.ts:28 是向子进程透传 env（child runner 接口），均属 brief 预留例外 |
| 新领域错误进共享表                          | 成立           | 全仓 8 个 Error 类，`PiHostFailure`/`GitOpError` 是内部层错误（由 RepositoryError/PiHostFailure 映射后经共享表透出），`domain-errors.ts` 覆盖全部 6 个领域类                                                                   |
| CHECK NULL-safe                             | 成立           | 直接 SQL：`completed + stop_reason=NULL` 被拒                                                                                                                                                                                  |
| 迁移未被原地编辑                            | 成立           | 0002/0003/0004 各只出现在一个 commit（049bd03/32eac6c/66de445），全部 `A`（新增），journal `when` 与提交一致；无 edit 历史                                                                                                     |
| `updatedAt` 不是变更信号                    | 已核对，未发现 | 全仓唯一按 `updatedAt` 的排序是 chat 列表展示序（`chat.ts:145`），是展示不是变更判定；run 依赖 sessionFile 找历史（`previousSessionFile`），profile 快照按内容随 run 冻结                                                      |

## run 归属（SO25/P2 遗留）实测

直接 SQL 插入 `project_id` 指向同 owner 另一 Project 的 run（chat 属 Project A）：SQL 层**接受**（无复合外键，预期内）；随后 `listAgentRuns` 不可见、`getAgentRun` 抛 `not_found`、下一次 `sendMessage` 抛 `AgentRunError("Run 归属不一致")`。**结论：不一致 run 可以存在于数据库，但领域层三处（读、投递、完成）全部拒绝，不可达、不可消费。** 与 P2-j 结论一致，P3 查询全部 join chat 推导归属，未信任 `instance.projectId`。

## 独立推导的 RPC 授权入口清单与实际清单比对

我从「所有 `createServerFn` 导出」独立推导 26 个入口（见下），逐一归类授权路径：

- Project 域（`assertProjectAccess` 在领域函数内）：getProject、listProjects（按 owner 过滤）、createProject、getProjectProfile、updateProjectProfile、getProjectRepoState、prepareProjectRepo、addProjectMember、removeProjectMember、listProjectMembers、createDirectChat、listChats、getProjectInfoHub — 13 个。
- Chat 域（经 `getChat` 授权）：getChat、listMessages、sendMessage、listChatMembers、listInstancesForChat、getChatInfo、getTurnStartContext、getChatRunState、abortAgentRun、getAgentProfile、updateAgentProfile、listAgentProfiles、createAgentProfile — 13 个。

**与代码实际清单比对：差异为零。** 26/26 全部经 `requireSession` + 领域层 Project/owner 归属校验，越权等价 not_found（独立反证 9 入口零泄漏，加上 q 脚本 3 条 cross-project 断言）。`runRow` 与 repository 的 `runRow` 均先 join `chat.projectId = agent_run.projectId` 再授权。

## ledger 与证据一致性（#19–#22 逐行）

| 行       | verdict 声称                                                                                                                                                                                                                                                                                                                                                           | 证据判定                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #19 p3-a | live-ui-verified                                                                                                                                                                                                                                                                                                                                                       | 一致。live 命令、真实模型、重启 bootId、Chromium 截图均在我本次复跑中重现（ID 随机不同，evidence 结构一致）。verifier=coordinator-rerun，无独立性声明问题                   |
| #20 p3-b | live-ui-verified                                                                                                                                                                                                                                                                                                                                                       | 一致。steer/停止/profile 三断言本次 live 复现。verifier=coordinator-rerun                                                                                                   |
| #21 p3-c | live-ui-verified                                                                                                                                                                                                                                                                                                                                                       | 一致。本次复跑 `pi-repo-analysis.sh` 真实模型三方 commit 一致。verifier=coordinator-rerun                                                                                   |
| #22 p3-d | live-ui-verified                                                                                                                                                                                                                                                                                                                                                       | 一致。verifier 字段**如实写明**「not independent of p3-b or p3-c, which the same family authored」，符合 SO21/SO24 的披露要求；evidence 的命令与 PASS 数（302）与我复跑一致 |
| 更正 F2  | coordinator 判定原「ledger #21 的 sha 字段含损坏字符串」为误报。该串是工具显示层对长十六进制串的脱敏；实测 `awk` 取出的字段与 `git rev-parse 0d51b1f^2` 字节级相等，各 40 字节，`units.tsv` 与 `status.md` 同样无损，store 未损坏。文件内容必须用比较（退出码或校验和）判定，不能靠读工具输出。本文末尾保留的「ledger sha 字段损坏」引用是原验收误报，以本行更正为准。 |

## 文档与代码一致性抽样（每份 ≥5 条）

| 文档声明                                                                                                                 | 回验结果                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| pi-session：`NEXT` 状态机表                                                                                              | 一致（`agent-run.ts:31-40`）                                                                                                          |
| pi-session：completed 必须有回复/快照/started/stop='stop'                                                                | 一致（schema CHECK + 领域层双处）                                                                                                     |
| pi-session：恢复遗留 queued+running → interrupted + 诊断，重复恢复不重复诊断                                             | 一致（实测 recover-probe）                                                                                                            |
| pi-session：协议消息清单（open/prompt/steer/abort/close；ready/progress/input_delivered/input_rejected/settled/failure） | 一致（protocol.ts + runner）                                                                                                          |
| pi-session：「不加载整个用户 extension 集合」与 magpie provider 发现                                                     | 一致（runner noExtensions + magpie 分支）                                                                                             |
| pi-session：SPROUT_PI_ENABLED=false 时不启动子进程                                                                       | 一致（startPiHost 早退；verify.sh 全程 false 下无 runner）                                                                            |
| turn-semantics：steer 先查 `isStreaming` 再 `session.steer`                                                              | 一致（runner deliverSteer）                                                                                                           |
| turn-semantics：停止后迟到投递确认保持 pending 不升级故障                                                                | 一致（pi-host/index.ts:81-87）                                                                                                        |
| turn-semantics：UI 轮询 1.2 秒仅在 queued/running                                                                        | 一致（chat 路由 `watching` 条件）                                                                                                     |
| turn-semantics：`agent_run_failed_check` 含 IS NOT NULL 守卫语义                                                         | 一致（CHECK 为 `!= 'failed' OR (errorCode NOT NULL AND errorMessage NOT NULL AND != '')`，NULL status 形态不适用；直接 SQL 反证通过） |
| repo-entry：绑定副本 fetch 不改工作树、fresh=false、获取时点为空显示宿主未取过                                           | 一致（实测 fresh-probe；UI 文案 `fetchedAt ? 获取于 : 宿主未取过`）                                                                   |
| repo-entry：托管克隆超限整删、绑定副本不删                                                                               | 一致（repository.ts 磁盘分支 + disk-probe 的「未修改用户副本」文案）                                                                  |
| repo-entry：十类 `repo_*` 错误码                                                                                         | 一致（git.ts 分类表 + p 脚本四类复现）                                                                                                |
| repo-entry：provenance 在 open 成功后、running 之前写                                                                    | 一致（execute() 顺序：open → recordRunRepoBasis → transitionAgentRun）                                                                |
| info-hub-runs：`injectedIntoPrompt` 恒 false、`RUNS_UNAVAILABLE_REASON` 已删除                                           | 一致（literal(false)；全仓 grep 无该常量）                                                                                            |
| info-hub-runs：recent 取终态 5 条新的在前                                                                                | 一致（runsView slice(-5).reverse()）                                                                                                  |
| info-hub-runs：pendingInputs 含终态 run 的未投递输入                                                                     | 一致（listAgentRunInputs 不过滤 run 状态）                                                                                            |

**不一致清单：无。** 未发现一条可判定声明与代码或实值相悖。

收尾复核在 `docs/p3/info-hub-runs.md:83` 发现一处措辞使断言不成立，原句暗示无 run 时 pendingInputs 可为 2，实际断言先发送两条消息建立 queued run，再检查 pendingInputs=2；已在本 PR 更正。因此「不一致清单为空」应读作「e 抽样的 17 条内无矛盾，收尾复核另发现 1 处」。本补记不改变任何 checkbox 判定或阶段验收结论。

## 试图推翻但未推翻的声明清单

1. **「第二个活跃 run 被挡」**：用两个并发进程 + 绕开应用层的直接 SQL 攻击，被 UNIQUE 索引拒绝。未推翻。
2. **「复用副本时 fresh=false」**：构造落后副本场景实测，`fresh` 如实为 false 且 commit 是旧 HEAD。未推翻。
3. **「run 归属不一致不可能被消费」**：直接 SQL 造出不一致行，三处领域路径全部拒绝。SQL 层可写入这一点是已知无复合外键的预期，不是作者声明的内容。未推翻。
4. **「stopReason=error 不当成功」**：三层检查 + DB CHECK + hermetic 反证。未推翻。
5. **「停止不产生假回复」**：live `assistantMessageId=null`、消息计数不变、pending 去向明确。未推翻。
6. **「Info Hub 越权零泄漏」**：独立构造第二用户打 9 个入口。未推翻。
7. **「重启不虚构完成」**：直接 SQL + recoverAgentRuns 实测 interrupted + 诊断。未推翻。
8. **「文档可判定声明与代码一致」**：17 条抽样全部一致。未推翻。

被推翻的声明只有一条：**plan 第 2 条的「保留宿主 Pi 工具」按完整字面未交付**（codemode、tool_search、MCP 内置 extension 与宿主用户 skills 未进分身）。这不是作者的虚假声明——作者在 `docs/p3/pi-session.md` 如实披露了该未验证面——而是 plan 承诺与交付物的差距，按 brief 要求写成阶段结论。

## 本验收没有覆盖的面

- 多分身并发真实模型 run、stdout 背压、超大工具输出、强杀后的全部后代进程清理。
- 真实公网远端（GitHub https/ssh）的认证与代理行为；hermetic 只覆盖本地 401 与 `file://`。
- 大仓库（GB 级）克隆时长与磁盘统计耗时；绑定副本 detached HEAD、稀疏检出等边界状态。
- codemode/tool_search/MCP 的加载（与第 2 条部分交付同源）。
- magpie native provider 的真实推理与缺省模型回退（live 全程用显式 deepseek）。
- 多进程宿主同时扫同一数据库（P3 明确不保证）。
- Info Hub 聚合的 N+1 在规模下的表现（followups 已路由 P6/P5 评估）。
- 浏览器 lane 仅复跑仓库自带脚本（q、live 内嵌 Chromium 流程）；本机无 `/deslop` 与 `control-ui`，未冒称执行，`/unslop` 与 `comment-sicko` 本机存在。

## 可复跑的最小实验清单

```sh
# 门禁（串行,verify.sh 会重建依赖）
pnpm test && pnpm check && bash scripts/verify.sh
bash scripts/verify-live/pi-dm-turn.sh          # 需 Pi 凭据,真实 deepseek
bash scripts/verify-live/pi-repo-analysis.sh

# 实验一:并发两进程 + 直接 SQL 打活跃 run 唯一索引(期望 ATTACK-REJECTED)
node --import tsx /tmp/p3-e-acceptance/concurrent-writer.mjs /tmp/p3-e-acceptance/db3
node --import tsx /tmp/p3-e-acceptance/active-run-writer.mjs /tmp/p3-e-acceptance/db3 8 &
sleep 2; node --import tsx /tmp/p3-e-acceptance/second-run-attacker.mjs /tmp/p3-e-acceptance/db3; wait

# 实验二:run 归属不一致可写入但不可消费(期望 INSERT-CROSS-PROJECT accepted + 两处 ProjectAccessError + AgentRunError)
node --import tsx /tmp/p3-e-acceptance/ownership-probe.mjs

# 实验三:bound_copy 复用旧副本 fresh=false(期望 provenanceFresh:false 且 commit=旧 HEAD)
node --import tsx /tmp/p3-e-acceptance/fresh-probe.mjs && node --import tsx /tmp/p3-e-acceptance/fresh-run-probe.mjs

# 实验四:磁盘上限(期望 repo_disk_limit + provenanceForRun:0)
node --import tsx /tmp/p3-e-acceptance/disk-probe.mjs

# 实验五:重启恢复(期望 interrupted + host_interrupted + 诊断1条,二次恢复不重复)
node --import tsx /tmp/p3-e-acceptance/recover-probe.mjs

# 实验六:CHECK 反证(期望全部 REJECTED)
node --import tsx /tmp/p3-e-acceptance/tamper-probe.mjs

# 实验七:跨用户越权(期望全部 ProjectAccessError not_found)
node --import tsx /tmp/p3-e-acceptance/cross-probe.mjs
```

## 阶段结论

P3 七条 checkbox 六条成立、一条（第 2 条）部分交付：分身拥有受控的最小 Pi（四个编码工具 + Sprout extension + 只读宿主认证与配置），codemode/tool_search/MCP 与宿主用户 extension/skills 未进分身，作者已如实披露但 plan 字面承诺未完整兑现。出口条件在真实模型、真实 SQLite、真实 Chromium、真实 git 远端上全部成立。作者四份文档抽样 17 条声明无一与代码相悖；ledger 四行 verdict 与证据相符。发现清单（含 ledger sha 字段损坏、followups 中已路由的既有项）见 `/tmp/p3-e-acceptance/findings.md`。
