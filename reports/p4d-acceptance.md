# I-P4d 独立验收

**判定：FAIL。** 在 `integration/p4d` / `0ad4e1d` 上，独立反例证明刷新失败后已打开的 force 对话框仍能写入、目录观测未按关系生命周期失效、removed 后执行读错误码偏离冻结约定，以及缺失投递帧证明的终态仍被 accepted 并污染执行事实；受影响的存量门禁也未全部恢复。

验收分支：`p4d/acceptance`。生产源码、迁移、已有测试和断言均未修改。新增四个可复跑脚本/夹具；本报告在 `reports/p4d-acceptance.md` 留存版本，另按要求复制到编排目录的 `reports/acceptance.md`。脱敏矩阵为 `reports/p4d-acceptance-evidence.json`。

## 阻断项

### A1 / P1：刷新失败后，已经打开的强制收回对话框仍能提交

- 位置：`src/components/machine/membership-sections.tsx:701`、`:771`。外层 trigger 接收 `disabled`，但提交函数只检查 mutationId/pendingSubmit；确认按钮只检查 confirmed/pendingSubmit。对比移出按钮在 `:546` 仍检查 disabledReason。
- 复现：`node scripts/verify/p4d-acceptance-pages.mjs`（内部总超时 300 秒）。它复用 aq 的真实 SQLite、生产包、登录和 Chromium 初始化，保留所有原断言，仅新增“先开 force 弹窗、再让五秒刷新失败”的路径。临时代码写在忽略的 `.verify/`，退出删除；未改 aq 或原夹具。
- 期望：事实读取失败并出现“当前状态未确认”后，依赖新鲜事实的写入口暂停，包括已打开对话框的最终确认。
- 实际：`expectedDisabled:true, actualDisabled:false`。继续点击确认，生产接口成功推进真实数据库：generation `1→2`、state `free`。并非只看到一个颜色不对的按钮。
- 证据：`.verify/p4d-acceptance-pages/acceptance-open-force-dialog-stale.png`、`failure.json`；运行日志 `/tmp/p4d-acceptance-pages.log`。截图已人工查看；运行两次，第二次实际提交并核对库中代次。
- 最小修法建议：最终确认按钮与 submit handler 都使用当前 disabled/事实失败状态；不能只禁用重新打开弹窗的入口。

### A2 / P1：目录观测跨 detaching/rejoin 被继续接受并冒充当前事实

- 位置：`src/server/worker-gateway.ts:258`、`:270`；`src/domain/machine.ts:179`。
- 复现：`node scripts/verify/p4d-acceptance.mjs authority`（内部单进程超时 60 秒）。用生产领域函数建关系、真实入网/会话/exchange 网关投递执行并报告目录观测，再 detach、force、rejoin。
- 期望：冻结决定 8 要求目录观察只认最新 active，且核对绑定 revision，禁止 rejoin 后旧 revision 冒充新事实。
- 实际一：关系已经 detaching，正常 authenticated Worker exchange 仍成功写入同 Project 的新观测，持久化 seq `3→4`。网关仅检查 project_machine 存在和 Machine rootRevision，未检查最新 membership。
- 实际二：rejoin 已产生 epoch 2，并将绑定 revision `1→2`；没有任何新 epoch 的目录观测，`getMachine(...).bindings[0].observation.current` 仍为 `true`。current 只比较连接代次与 Machine rootRevision，完全不比较绑定生命周期。这里 rootRevision 也恰为 2，数字巧合不等于它证明了 binding revision。
- 最小修法建议：接收目录观测时核对最新 active；读时与接收时都需保留可验证的绑定 revision/epoch 关联，使重新加入前的观测失效。不能把全局 rootRevision 当作 Project binding revision。

### A3 / P2：removed 后的执行读没有按固定顺序返回 lease_not_holder

- 位置：`src/server/lease.ts:143`、`:147`，`src/server/membership.ts:647`。continuity 单独把 detaching 改为 lease_not_holder，removed 却先进入普通操作总闸。
- 复现：同上 `node scripts/verify/p4d-acceptance.mjs authority`。
- 期望：冻结决定 10：合法 scope 的执行读因非当前 holder/非 active membership 拒 `lease_not_holder`；最新 removed 的**其他操作**才报 `membership_removed`。Human 历史不受这两个操作错误阻断。
- 实际：detaching 的 get/list/log 全部正确；force 完成 removed 后，三者都变为 `membership_removed`。生产 `remoteAgentResponse(Request)` 的 Request/Response 边界也原样返回该错误，status=200 的业务错误 envelope，没有变成 internal。该补充测试走生产 HTTP handler，未另开 TCP listener。Human 同一 executionId 历史读取通过。
- 门禁问题：`tests/fixtures/p4d-authority.ts:354` 起把三种执行读与其他操作混在一起统一期待 membership_removed，实际把冻结顺序回退写成了正确答案。authority 报告也明确主张该码，但实现方报告不能覆盖指定的冻结文本。
- 最小修法建议：执行读专用 continuity 对所有非 active membership 返回 lease_not_holder，保留其他操作总闸；同步补上三种读在 removed 下的独立边界断言。

### A4 / P1：缺失历史 command 投递证明的终态仍被 accepted，且封死后续真实结果

- 位置：`src/server/remote.ts:1545`、`:1566`、`:1580`；现有认可该行为的断言为 `tests/fixtures/p4d-authority.ts:412`。
- 复现：同上 `node scripts/verify/p4d-acceptance.mjs authority`。先经真实 Worker 网关下发 command，再在私有夹具库中只移去该历史 frame 的 command 项，保留 row/session/origin/fingerprint/dispatchSeq 和 frame 本身，以独立攻击“没有真实下发 frame 证明”的校验。没有声称外部攻击者具备修改服务端数据库的权限；这是冻结清单明确要求的证明完整性反证。
- 期望：冻结决定 6 及验收清单要求未下发 frame 的伪造报告被拒；无有效投递证明的报告不得生成执行终态和结果事实。running 分支确实会 not_found，terminal 应同样 fail closed。
- 实际：terminal 请求成功，`resultAcks[0].disposition="accepted"`；执行由 dispatched 被写成 `rejected/authorization_revoked`。补回原始 frame 的证明后，再投同一成功报告，执行仍停在 rejected。伪造终态已经封住后续真实事实。
- 门禁问题：p4d-authority 的“移去 frame proof”用例正断言 rejected/authorization_revoked，因此 an 通过只证明它实现了这个降级，未证明坏投递证明被边界拒绝。int-authority 的伪造矩阵检查 project/holder/origin/fingerprint/session/dispatchSeq，但没有把 missing-frame terminal 纳入其 not_found/无写矩阵。
- 最小修法建议：终态归约及 ignored_terminal/drainedAt 更新之前，对 proven=false 统一拒绝。保留有效历史投递在 draining/换 holder/free/detaching/removed 后按真实 outcome 归约的路径，不重新引入当前授权过滤。

### G1 / 交付门禁阻断：存量验收未按新契约完成集成

这部分与 A1–A4 分开：下列证据多指向过时测试/夹具，并不能据此宣称相应生产能力必然损坏；但冻结清单要求的门禁仍不能交付为绿。

| 位置                                                                                                     | 复现                                                                                                                       | 期望与实际                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/execution-accept-fixes.ts:219`                                                           | `bash scripts/verify/ai-execution-accept-fixes.sh`；也由 `bash scripts/verify/b-tooling.sh` 复现                           | 测试应覆盖 fencing 的旧 holder 可读窗口；仍期待换 run 的同 holder 读抛异常，实际读取成功，Missing expected exception。不能为了绿恢复旧授权规则。                                                                                                     |
| `tests/fixtures/mcp-extension-server.ts:131`、`tests/fixtures/mcp-extension-live.ts:76`、`:343`          | `bash scripts/verify/b-tooling.sh`、`bash scripts/verify/x2-mcp-extension.sh`、`bash scripts/verify/z2-mcp-integration.sh` | 夹具应建立完整 active membership；仍只 INSERT project_machine，生产 fail-closed 为 membership_removed。b 的单测为 60 文件通过、2 文件失败；449 用例通过、2 失败。                                                                                    |
| `scripts/verify/z3-mcp-acceptance.sh` 的 R1-1/R1-2                                                       | `bash scripts/verify/z3-mcp-acceptance.sh`                                                                                 | x2 失败使证据 x2.toolCount 缺失；两个条款 FAIL，其余五条 PASS。两次独立 runner 均复现。                                                                                                                                                              |
| `scripts/verify/z-lease-integration.sh:429`；新结构 `src/components/machine/membership-sections.tsx:333` | `bash scripts/verify/z-lease-integration.sh`                                                                               | 原门禁把 machine-item 整行当导航入口；现在它是 li，真实入口是内部“管理租约与执行”链接。脚本等 URL 超时两次。前面的真实 Pi、取消/拒绝、handoff/force、进程/文件保留均已通过，失败集中在末尾返回后的导航。应更新操作定位并保留 URL/back-forward 断言。 |

## q1 判定

**按本次指定的唯一冻结契约，q1 不构成实现违规，也不能要求把所有 unknown 自动重开。** `reports/design-selection.md:114-118` 明确规定：Worker 自己报告 unknown/authorization_revoked 保留 unknown；仅 fence ack、没有 terminal report 时也必须是 unknown/authorization_revoked；已封闭终态不承诺重开。第 5 条（`:105-112`）又明确规定 terminal/unknown 有 terminalAt 时取消返回 cancellation_already_terminal；验收清单 `:177`、`:181` 重申了这两个例外。

我独立运行 ap 的真实 macOS Worker/生产服务路径得到：handoff 后 B 读到相同 executionId，origin g=1/current g=2、authority=inherited；状态 unknown/authorization_revoked；B 读到的帧从已有 8 帧到 24 帧；进程仍活、周期文件写入数 `23→70`，观测最大写入间隙 707ms；B 取消旧 executionId 返回 cancellation_already_terminal，A 返回 lease_not_holder，B 带旧代次返回 lease_stale_generation。证据 `.verify/p4d-handoff-worker-5VFLen/evidence.json`，非 LLM 模拟、非手工把服务端行改回 running。

这里“终态”封闭的是旧投递/旧授权下这次执行的可归约记录，unknown 说的是观察结果未知，并没有声明 OS 进程已经退出。撤销投递通道不是 runner 退出证据。这个语义不方便，但冻结文本已明确选择它，也禁止冒充已停止、成功或编造 exit code。ap 另在 B 当前代次的新执行上走真实取消，得到 requested→exited_observed、term_delivered、进程退出；这只能证明仍在途路径可达，不能冒充“跨 fence 的旧 unknown 也能按 executionId 取消”。

此时 execution_cancel 对该记录已不可用。B 若仍持有 active 当前租约，可先显式查询进程，核验 PID/命令身份，再用当前代次的 `sprout_remote_process_signal` 发送信号；或由 Machine 操作者在宿主机核实并终止对应进程/进程组。需要继续验证实际退出及副作用停止；不能把信号送达当已停止，也不会因此把原 unknown 行回写为 cancelled。本轮未额外执行这条 process_signal 补救路径；它的入口和授权由 `src/contracts/remote.ts:602`、当前提交路径源码确认。Project 已 removed 时 Agent 无此权限，需要 Human 的宿主操作或显式 rejoin/重新获得授权。

决策记录存在一处输入缺口：本次给出的 decisions.tsv 全文含 11 条带 timestamp 的决定和 d7/q1/d8，没有 d1–d6 或编号 d4 的原文；q1 和 brief 却引用 d4。“终态只来自 runner 事实”若被视作无例外绝对原则，确实与冻结第 6 条的 ack-only unknown 冲突。我以用户明确指定的冻结契约为验收依据，不能把它的明示例外另判违规。建议 coordinator 补齐原始决策及例外关系，避免下轮再次争议；本验收未修改决策文件。

## 冻结清单逐项结论

下表的 PASS 指运行过相应门禁并核对产物；部分底层状态由原夹具构造，不冒充真实 Worker 自然达到全部竞态。

| 冻结验收点（design-selection.md 行号）                      | 结论与证据                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 172：0020 空白/旧库、旧行不变、唯一 epoch、FK/延迟约束      | PASS。an 已复跑原完整旧库/结果/日志/MCP 历史矩阵；新增 migration 另用生产 migrator 建 0019 文件库、三 Project 共机旧绑定，升级两次、全旧表逐列快照不变；事务内先写执行再补 frame 提交成功，不补 frame 在 COMMIT 失败，foreign_key_check 始终最终为空；旧 remote_execution sqlite_schema SQL 逐字相同。 |
| 173：直接 SQL 非法值/NULL/唯一约束                          | PASS，an 的 p4d-contracts 全部通过；不只以 Zod 断言数据库能力。                                                                                                                                                                                                                                        |
| 174：唯一当前授权、一致、单调、缺失 fail closed             | PASS（原 authority/removal 域层矩阵）；本轮额外证明缺 membership 的旧 MCP 夹具被拒，未隐式补建授权。                                                                                                                                                                                                   |
| 175：B 接续旧 executionId/get/log/list，A 拒绝，origin 不变 | PASS，an 加 ap 真实 Worker 的继承视图/旧 holder/日志证据。                                                                                                                                                                                                                                             |
| 176：fencing A 可读/B 不可读、均不可写、时间不变权限        | PASS，an/pending 矩阵与 ap 的 aReadDuringFence/bReadDuringFence；ai 旧断言冲突另列 G1。                                                                                                                                                                                                                |
| 177：B 当前代次取消旧在途执行、取消归属不改 origin          | PASS（合约夹具）；真实跨 fence 旧记录为 terminal unknown，取消拒绝符合例外；真实 B 新执行取消通过。不能合并成“真实旧执行取消通过”。                                                                                                                                                                    |
| 178：跨多代 fence 覆盖、scope/上界证明、仅 ack 得 unknown   | PASS，an forged/intent、ap。                                                                                                                                                                                                                                                                           |
| 179：精确代次派发，旧 queued 拒绝，无隐式重跑               | PASS，an、w；源代码仍要求派发代次精确匹配。                                                                                                                                                                                                                                                            |
| 180：合法迟到结果保持真实 outcome、伪造 proof 全拒          | **FAIL A4**。有效历史结果矩阵通过；missing-frame terminal 校验不成立。                                                                                                                                                                                                                                 |
| 181：真实长命令交接、进程/文件保留、未知诚实披露            | PASS，ap 独立实跑；如实记录 q1。未重复需要真实模型的独立 verify-live 脚本；原 int-live 报告只作对比。                                                                                                                                                                                                  |
| 182：detach confirm/CAS/fencing/无在途离线边界              | PASS，an、aq；aq 有取消对话框不写库的生产路径。                                                                                                                                                                                                                                                        |
| 183：detach 重试收据、ack/force 仅关联 epoch                | PASS，an、aq；新测试亦实际走 force→removed。                                                                                                                                                                                                                                                           |
| 184：rejoin epoch/revision/旧请求、旧目录观测               | **FAIL A2**。epoch/revision/幂等与旧请求矩阵通过，但旧目录观测未失效。                                                                                                                                                                                                                                 |
| 185：同机 P/Q 隔离，Human 历史，选择器/可见性               | PASS，an 同机双 Project 真 TCP 执行、aq 正式页面；新增反例 Human 历史通过。目录操作隔离漏洞见 A2。                                                                                                                                                                                                     |
| 186：通知收件、无执行 holder、去重/根因                     | PASS，an notices 场景。                                                                                                                                                                                                                                                                                |
| 187：通知回滚/重启/异常重试/run 结束                        | PASS，an notices-restart/steer，真实 executeRun 配置假 process；证明生产轮询函数，不声称真实模型已读。                                                                                                                                                                                                 |
| 188：14999/15000、在线/离线、重启/刷新，不自动完成          | PASS 于原边界投影/aq；**页面 stale 写保护 FAIL A1**。                                                                                                                                                                                                                                                  |
| 189：错误码及边界、历史/force 可达                          | **FAIL A3**。跨用户/Project、非 holder、旧代次、unauthorized 原矩阵均通过；removed 的三种执行读偏离固定码。                                                                                                                                                                                            |
| 190：必跑受影响与新增门禁                                   | **FAIL G1**。53 条全跑；隔离复跑后 47 条通过、6 条失败，详见矩阵。没有 Human 页面确认，本报告不代替该确认。                                                                                                                                                                                            |

## 三条新门禁是否可信

- **an：有实质生产覆盖，但存在错误 oracle。** 迁移是真 SQLite，伪造身份走真实 Worker 网关，通知投递调用生产 executeRun；不是全文文案匹配。但 missing-frame terminal 被断言成 rejected，并把 removed 的所有操作期待为同一码，因此 an 的 PASS 不能推出冻结决定 6/10 全满足。还未验证目录观测 active/revision 闸门（A2）。
- **ap：证据诚实，但 PASS 名称需要精确解读。** 真实 Worker、独立 SQLite、真实 runner、生产服务/工具桥，保存进程写入连续性和日志帧。它没有断言“旧 unknown 取消成功”，把其拒绝结果明确保存，再用 B 当前新执行证明真实取消；这个区别与冻结契约一致。禁止将其摘要改写为“接续后按 executionId 取消旧进程成功”。
- **aq：结构性断言主体可信，存在已打开弹窗的时序漏测。** 它检查各区域/data 属性、原生 details open 状态、收起可见文本不含执行数与证据、服务端关系/receipt/epoch、真实函数请求与状态回写；detaching 未被宣称已移出，force 后的“无法确认远端执行已停止”被正确当负向语义。文案检查主要用于防止作出错误肯定陈述，未拿全文字符串代替关系结构。但 stale 测试只看移出 trigger，遗漏 A1 的 final commit 控件。

## 与实现方自述的差异、非阻断建议

1. 选择 int-pages 最肯定的“刷新失败写入口暂停”结论做独立反证：关闭弹窗的普通移出入口确实暂停；已开 force 对话框仍真正写入，故该结论不能普遍成立。原 aq PASS 与新增脚本 FAIL 同时保留。
2. contracts 的“迁移不破坏旧行/FK”结论获独立支持，且新增测试以生产 migrator 和实际 COMMIT 验证延迟约束，强于只匹配 sqlite_schema 文本。未访问用户真实业务数据库；“旧库”指由真实 0019 迁移生成、填有旧行的文件数据库。
3. authority 的“移出后 membership_removed”与“未下发 frame 得 rejected”虽被自己的门禁证实，仍与指定冻结条款不符；不能因实现方报告用了 PASS 就豁免 A3/A4。
4. int-live 的 q1 现象被独立复现，未发现报告隐藏“进程未退出”。它是明确语义/可用性限制，见 q1，不归为本次实现阻断。
5. pending 区主文案直接展示 `membership_detaching > lease_fencing > notice_undelivered`（`src/components/machine/membership-sections.tsx:198`）。建议换成面向用户的名称，原始枚举留给调试详情；不影响本次四项功能反例。
6. 历史列表 100 条上限/分页、极窄屏全组合未新增独立压力样本；aq 也公开注明这些未覆盖。本次已有 r/u/y/ad 等布局与场景门禁通过，不将其扩写成全部历史/窄屏组合都验证过。
7. `pnpm check` 最终通过，保留两条既有 warning（worker inflight 的无用 spread、MCP 类型冗余），不作为本次阻断。未修改生产代码消除警告。

## 实跑完整门禁矩阵

第一轮命令：`pnpm verify`；runner `.verify/runs/2026-10-29T14-32-48-594Z-29283-0/report.json`。53 条实际执行，44 PASS、9 FAIL，runner 总时长见 JSON。没有把安装启动耗时或后台返回耗时当验证耗时。

第一轮执行期间，我正在写新增验收夹具：b/g/v 的格式与类型检查被未完成的新文件干扰。已完成夹具并复跑以下 8 条：`bash scripts/verify.sh --only b-tooling,g-identity-data,v-mcp-contracts,t-machine-worker,z-lease-integration,x2-mcp-extension,z2-mcp-integration,z3-mcp-acceptance`；runner `.verify/runs/2026-10-29T14-59-17-677Z-77954-0/report.json`，总时长 357196ms。g/v 恢复，t 首次截图超时在隔离重跑通过；b 此次通过 format/type gate 后在两条存量单测失败。新文件引入的初轮问题不计为产品缺陷。

最终取每条最后一次实跑结果：**47 PASS / 6 FAIL / 0 SKIP**。下表耗时为 runner 记录的该脚本进程耗时（秒），不是 workflow 总耗时。

| 门禁                          | 首轮 |  首轮秒 | 隔离复跑 |  复跑秒 | 最终 |
| ----------------------------- | ---- | ------: | -------- | ------: | ---- |
| a-base                        | PASS |  39.794 | —        |       — | PASS |
| aa-execution-log-contracts    | PASS |   1.729 | —        |       — | PASS |
| ab-worker-long-command        | PASS |  33.551 | —        |       — | PASS |
| ac-execution-recovery-log     | PASS |   0.790 | —        |       — | PASS |
| ad-execution-log-ui           | PASS |  33.589 | —        |       — | PASS |
| ae-remote-tools-cancel-log    | PASS |   1.354 | —        |       — | PASS |
| af-execution-cancel-authority | PASS |   2.028 | —        |       — | PASS |
| ag-execution-wiring-ui        | PASS |   7.505 | —        |       — | PASS |
| ah-execution-live-e2e         | PASS | 257.488 | —        |       — | PASS |
| ai-execution-accept-fixes     | FAIL |   1.876 | —        |       — | FAIL |
| aj-recovery-matrix            | PASS | 189.999 | —        |       — | PASS |
| ak-execution-accept-fixes-2   | PASS |  13.020 | —        |       — | PASS |
| al-execution-exit-custody     | PASS |  12.897 | —        |       — | PASS |
| am-execution-log-honesty      | PASS |   6.241 | —        |       — | PASS |
| an-p4d-authority              | PASS |  25.390 | —        |       — | PASS |
| ap-p4d-handoff-worker         | PASS |  55.637 | —        |       — | PASS |
| aq-p4d-pages                  | PASS |  22.159 | —        |       — | PASS |
| b-tooling                     | FAIL |   1.807 | FAIL     |  33.872 | FAIL |
| c-auth-rate-limit             | PASS |   1.431 | —        |       — | PASS |
| c-data-auth                   | PASS |   6.344 | —        |       — | PASS |
| d-runtime                     | PASS |  20.291 | —        |       — | PASS |
| drain-http                    | PASS |  21.941 | —        |       — | PASS |
| e-project                     | PASS |   3.912 | —        |       — | PASS |
| f-docs                        | PASS |   0.127 | —        |       — | PASS |
| g-identity-data               | FAIL |  10.982 | PASS     |  12.357 | PASS |
| h-project-agents              | PASS |   4.800 | —        |       — | PASS |
| i-chat                        | PASS |   9.381 | —        |       — | PASS |
| j-info-hub                    | PASS |   4.347 | —        |       — | PASS |
| k-acceptance                  | PASS |  38.024 | —        |       — | PASS |
| k2-cross-family-isolation     | PASS |   4.366 | —        |       — | PASS |
| l-docs                        | PASS |   1.323 | —        |       — | PASS |
| l-docs-probes                 | PASS |  35.285 | —        |       — | PASS |
| m-error-mapping               | PASS |   0.962 | —        |       — | PASS |
| n-pi-session                  | PASS |  11.339 | —        |       — | PASS |
| o-turn-semantics              | PASS |   6.712 | —        |       — | PASS |
| p-repo-entry                  | PASS |  16.882 | —        |       — | PASS |
| q-info-hub-runs               | PASS |   4.126 | —        |       — | PASS |
| r-ui-layout                   | PASS |  18.378 | —        |       — | PASS |
| s-machine-contracts           | PASS |   2.929 | —        |       — | PASS |
| t-machine-worker              | FAIL |  54.133 | PASS     |  50.227 | PASS |
| u-machine-ui                  | PASS |  73.877 | —        |       — | PASS |
| v-lease-contracts             | PASS |   2.867 | —        |       — | PASS |
| v-mcp-contracts               | FAIL |   7.052 | PASS     |   8.817 | PASS |
| w-worker-remote               | PASS |  62.660 | —        |       — | PASS |
| x-remote-tools                | PASS |   2.310 | —        |       — | PASS |
| x2-mcp-extension              | FAIL |   1.388 | FAIL     |   1.349 | FAIL |
| x3-mcp-extension-surface      | PASS |   2.620 | —        |       — | PASS |
| y-lease-ui                    | PASS |  33.736 | —        |       — | PASS |
| y-mcp-worker                  | PASS |   5.296 | —        |       — | PASS |
| y2-mcp-http-worker            | PASS |   1.923 | —        |       — | PASS |
| z-lease-integration           | FAIL | 226.980 | FAIL     | 237.525 | FAIL |
| z2-mcp-integration            | FAIL |   1.126 | FAIL     |   1.291 | FAIL |
| z3-mcp-acceptance             | FAIL |  11.659 | FAIL     |  11.753 | FAIL |

额外验收（不混入上述 53 条统计）：

| 命令                                               | 实际结果                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                   | PASS，实际执行，安装退出 0。                                                                                                                                   |
| `node scripts/verify/p4d-acceptance.mjs migration` | PASS，生产迁移、旧库重放、每 binding 一 epoch、全表快照、FK 延迟提交正反证。                                                                                   |
| `node scripts/verify/p4d-acceptance.mjs authority` | FAIL，退出 1 为验收发现：removed 三读（域层及 HTTP handler）、非 active 目录观测/rejoin current、missing-frame terminal。detaching 三读与 Human 历史正例通过。 |
| `node scripts/verify/p4d-acceptance-pages.mjs`     | FAIL，真实页面确认 stale 时仍可从已开对话框 force 并推进 generation；原 aq 原断言未改。                                                                        |
| `pnpm typecheck`（夹具最终版本）                   | PASS，三个 tsconfig 的实际 tsc 检查退出 0；日志 `/tmp/p4d-acceptance-typecheck.log`。                                                                          |
| `pnpm check`（夹具最终版本）                       | PASS，0 error / 2 个既有 warning；运行日志 `/tmp/p4d-acceptance-check.log`。                                                                                   |

验收手法遵循 **Prove It Works**：将结论落成可重跑的生产边界和文件库夹具；**Test Behavior, Not Implementation**：断言代次、关系、错误码、可见性和实际写入，未修改旧 oracle 使其变绿；**Build the Lever**：提供单命令补充复现，避免依赖验收者手工操作。夹具组织以运行状态/观察事实为数据，依据 unit-testing-best-practice 为每个风险保留独立反例。所有后台运行都落日志和退出标志；两个 runner 均已实际退出，无仍在运行的验证等待。
