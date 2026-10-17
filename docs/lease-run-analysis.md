# Agent run 与 Machine 租约：现状查证与模型建议

状态：原实现查证与分期前的模型取舍记录。当前产品范围以 [core-scope.md](core-scope.md) 和 [Machines 决策记录](machines-decisions.md) 为准：一期保留跨 run 租约、软性收尾和直接交接，挂靠、领取及系统自动资源协调已后移二期。下文保留原实现事实与分期前方案比较，不作为一期验收要求。

## 原 Sprout 的现状

查证基于原仓库 `master` 的 commit `5b48a53b385ee8a4c0fff219954c6244506b0b9f`，本地源码与 GitHub 默认分支一致。

| 路径 | 已实现或规范中的行为 | 约束承担者 |
| --- | --- | --- |
| 非 Task 的普通单轮 run | 系统在收尾时释放 run-held 租约；执行或停止结果不确定时进入 recovery，继续阻止重新分配 | orchestrator 与远端操作生命周期，不依赖模型主动释放 |
| Task 内的 run | run 复用 Task-held 租约；run 完成或停止不释放，Task 正式结束时再清理 Task context 并释放 | Task 生命周期与系统权限检查 |
| #265 Lease escrow | 规范要求挂靠链在 successor run 结束后继续占用，使用者显式再挂靠或正常释放；普通 run 保持其独立收尾行为 | 尚未实现为原仓库的 escrow 生命周期，issue 仍为 OPEN |

依据：

- [普通 run 收尾与不确定结果保护](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/src/run/orchestrator.ts#L1619)；[Host-run 的同类处理](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/src/run/orchestrator.ts#L1032)。
- [Task 正式结束时释放](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/src/task/environment-lifecycle.ts#L1121)。
- [普通 run 完成释放的现有测试](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/src/run/orchestrator.test.ts#L119)；[Task run 完成后仍持有的现有测试](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/src/runtime-host-run-task.test.ts#L201)。本次只检查代码和测试断言，未运行测试。
- [ADR-0005：区分 Task 与 run 租约](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/docs/adr/0005-task-held-environment-lease.md)；[ADR-0018：Host-run Task 仍保留 Task-held 租约](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/docs/adr/0018-host-run-tasks-retain-task-environment-lease.md)。
- [#265 Lease escrow](https://github.com/tinysnake/sprout/issues/265)；[规范中的 Successor settlement](https://github.com/tinysnake/sprout/blob/5b48a53b385ee8a4c0fff219954c6244506b0b9f/docs/specs/environment-lease-escrow.md#L82)。原仓库 `src/` 未发现 escrow/takeover 的实现。

因此，原 Sprout 没有统一的“模型在回答结束前必须调用释放工具”的约束。普通 run 有系统控制的释放规则，Task run 则明确保留租约。不能由其中一条路径推断所有 run 开始时一定无租约。

## 分期前 scope 的基本需要

- run 的结束表示本轮执行结束，不足以判断工作、验证、等待或交接是否结束。
- Machine 租约表达 Project × Machine 内的独占操作权和占用；分身身份由 profile × Conversation 稳定确定。Machine 需加入当前 Project，同一物理 Machine 可以加入多个 Projects，各项目租约独立。
- 其他 Project 的租约不阻止本项目申请，也不参与本项目协调或通过 Sprout 向 Agents 暴露。Project 硬隔离限定在 Sprout 层，共享 Machine 内部的文件、进程可见性及资源冲突由 Project organization 负责。
- Task 不再持有租约。租约策略需要保证多轮工作能保留同一 Machine，同时允许主动归还和交接。
- 后台进程、文件和租约的生命周期独立。挂靠或释放不自动清理进程，也不删除工作成果。
- 权限事实应来自 Sprout 的持久记录，每轮通过上下文或查询重新提供，不依赖模型记忆。

## 分期前已选模型：租约随分身保留，软性要求收尾判断

以下模型已确认，并由下一节的按需协调处理遗忘占用：

1. run 开始时查询实际租约状态；已有本分身租约可继续使用，需要额外 Machine 时认领符合条件的挂靠租约或申请空闲 Machine。
2. 工作不再需要该 Machine 时，分身主动清理必要内容并释放；需要交给其他分身时，主动挂靠，交出操作权但保留占用。
3. 正常结束一轮前，用指令软性要求判断仍持有租约是否需要保留、挂靠或释放。同一分身后续还需继续工作时允许保留；不为了结束一轮而强制调用租约工具，也不增加独立模型收尾轮次。
4. run 正常结束且未操作租约时，系统保留现有持有关系。Info Hub 显示分身空闲但持有 Machine；申请遇阻时先自动请求持有者协调，无法响应或状态不确定时再交给 Human。
5. 错误、断连或停止结果不确定时，不把 Machine 静默释放给他人。旧请求必须失效或确认不会继续执行，才能交给新的操作者；有意保留的后台进程不因此全部终止。

系统硬性保证同一 Project × Machine 内的租约互斥、操作授权、挂靠后的旧权限撤销和并发认领一致性。软性要求负责项目内资源利用判断；忘记收尾可能造成闲置，但不能造成同一项目的两个分身同时获得独占权。不同 Projects 可以在同一物理 Machine 上持有各自租约。

优点是复用已经选择的持续分身身份，不在每轮边界额外增加挂靠、认领、失败和恢复的转换。主要代价是空闲分身可能持续占用 Machine，需要明确可见，并可通过协调请求和人类收回处理。

## 分期前补充：申请遇阻时自动协调一轮（现列二期）

- 所有占用判断、申请与协调仅针对当前 Project 已加入的 Machines 及该项目租约，不跨 Project 唤醒持有者或交换信息。
- 申请者需要指定 Machine 的交接，或无空闲 Machine 可申请时，系统向当前持有分身明确请求归还或交接；无指定目标时优先选择空闲持有者，逐个且有限尝试。
- 请求直接通知或唤醒持有分身，忙碌时送入当前轮，不依赖小脑/JEV 判断；协调本身无需空闲 Machine。
- 持有者释放、按既有授权规则挂靠交接，或说明保留原因；不以空闲为由自动撤销租约。
- 同一租约的协调请求合并，每次申请只协调一轮，防止广播和持续催促；重新校验当前租约，避免旧请求改变新持有关系。
- 无法响应或状态不确定时交给 Human；正常保留导致容量不足时返回等待或换目标的明确结果。
- 分期前曾将按需协调纳入 MVP；当前已将它与挂靠超时提醒、owner 协调一起明确后移二期。

## 可选模型及取舍

| 模型 | 优点 | 代价 |
| --- | --- | --- |
| 分身跨 run 保留，软性收尾（已选） | 转换少；等待反馈和同一分身续做直接延续；挂靠用于明确交接 | 闲置占用通过申请遇阻时协调一轮，异常时由 Human 处理 |
| 每轮结束系统自动挂靠 | 下一轮无持有租约、必须显式认领；占用可持续 | 每轮都有挂靠/认领转换；需支持 DM 挂靠，并确定默认认领范围及异常收尾 |
| 每轮结束系统自动释放 | 简单归还资源 | 多轮间可能被其他工作占用，无法保证同一 Machine 的连续使用；需要另加显式保留机制 |

不建议把“模型必须调用释放工具才能正常结束”作为唯一保障：异常退出可以绕过模型的最后一步；确定的资源授权和兜底必须由系统落实。

## 分期前对 Info Hub 的影响

- 已确认启动上下文包含本分身已持有租约；Group 和 Public Channel 另提供当前对话的挂靠租约。第一版不支持 DM 挂靠，DM 的唯一分身通过跨 run 保留租约续做。
- Human 界面自动刷新；Agent 运行中接收简短信息变更提示，自行决定是否查询。普通变化不单独唤醒空闲分身，行动事件按明确规则通知或唤醒。
- 运行中始终可以按需查询实际持有关系；Info Hub 同时聚合租约协调请求、结果及保留原因。
- 自动上下文的机器字段应服务于已选租约模型，不能反过来由字段选择推断生命周期。
