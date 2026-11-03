# P6b 追加：页面变更推送

页面不再靠固定节拍体检。服务端在事实变化时通过同源 SSE 推送一条「哪个主题变了」的提示，页面收到提示后仍走原来的 revision 读，判定和载荷都没变。轮询保留为降级通路。

契约与边界沿用 [P6b 契约](contracts.md)。本文只记录推送这一层，以及它改变了 [P6b 章节结论](summary.md) 里的哪句话。

## 为什么改

原来的节拍是 Info Hub 每 3 秒一次、Chat 有活动 run 时每 1.2 秒一次。轮询本身的成本不是问题：实测一次无变化的 section 读是 1.057 到 1.290 毫秒、215 到 239 字节，按 3 秒节拍算约每标签页每小时 1.3 到 1.55 秒服务端 CPU。问题在时延下界，状态变化要等到下一个节拍才被看见，最坏 3 秒，Chat 之外的人看不到。

推送把下界压到一次网络往返加一层 150 毫秒合并窗口，同时把空闲标签页的请求数降下来。

## 决策

- **同源 SSE 单向推送。** 浏览器只需服务端到客户端的通知，不需要反向上传。EventSource 自带断线重连与 `retry`，不需要自己写重连状态机，也不需要处理升级握手。
- **拒绝 WebSocket。** 没有客户端到服务端的流式需求，代价却要多付：升级握手处的授权、连接生命周期、断线重连全部自建。同一套推送逻辑用 SSE 少一半状态。
- **拒绝无发布者的有界 long poll。** [R1 设计](../r1/design.md)已经记录过这次教训，没有写入侧的唤醒源时，hold 只是变慢的轮询。`src/server/mcp-relay.ts:76-82` 的注释写的是同一件事。
- **拒绝同步引擎（ElectricSQL、Zero 一类）。** 数据在一个进程里一个 SQLite 文件上，引入复制通道等于把已冻结的 revision 契约重写一遍，换不到额外的东西。

## 契约

`src/contracts/change-stream.ts` 是唯一的事实来源：

| 项               | 值                                     | 说明                                                                     |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| 主题             | `project:<projectId>`、`chat:<chatId>` | id 复用 `appIdPattern(ID_PREFIXES.project/chat)`，形状不符的主题直接丢弃 |
| 每连接主题数上限 | 8                                      | 超出部分丢弃，页面订阅数远低于此                                         |
| 合并窗口         | 150 毫秒                               | 同一主题在窗口内只发一条，时间戳取首次发布时刻                           |
| 心跳             | 20 秒                                  | `event: ping`，同时让 Caddy 一类反代不掐空闲连接                         |
| 单连接积压上限   | 64 帧                                  | 慢消费者超过上限即断开，由重连后的一次重读补齐事实                       |
| 推送后安全轮询   | Project 视图 30 秒，Chat 15 秒         | 推送连着时用这个节拍兜底，漏消息能自愈                                   |
| 断流回退         | Project 3 秒，Chat 1.2 秒或 5 秒       | 推送不可用时回到原节拍                                                   |
| 重连退避         | 1 秒起，最长 15 秒，6 次后放弃         | 放弃后停在轮询，不无限重连                                               |

推送只携带主题，不带数据。页面收到提示后调用原有的 revision 读，返回 `unchanged` 就什么也不做。这条设计让误报的代价被实测的约 1.1 毫秒读吸收，也不需要为每个主题定义增量载荷。

`lastSeenAt` 一类心跳字段本来就不参与 revision（`src/domain/info-hub.ts:770`），因此机器心跳不会变成推送风暴。

## 授权模型

- 建立连接时按主题鉴权。Project 主题要求 `project.createdBy` 是当前用户；Chat 主题经 `chat.projectId` 落到 Project 再判。全部主题都不通过时返回 403，`requireSession` 不通过时返回 401。
- 每条推送不重复鉴权。每次提示触发的读仍然走 `assertProjectAccess`，越权的那次读会被拒，推送本身不构成信息泄露。
- 成员被移出的场景目前不存在移除人的入口，因此没有实现「发布前过滤 + 撤权时关流」。这是有意的取舍，不是遗漏。
- 客户端有熔断。EventSource 看不到 403 的响应体，4xx 只会表现为反复失败，因此在 6 次退避失败后停止重连并回退轮询。
- 断连判定不只看 `CLOSED`。浏览器的自动重连阶段同样算断开，页面收到状态变化后立刻从安全间隔退回原节拍。

## 服务端落点

- `src/domain/change-feed.ts` 是进程内总线。`publishChange` 按主题排队，`subscribeChanges` 按主题过滤，没有订阅者的主题不排定时器；最后一个订阅者退订时，还没发出的一条连同定时器一起取消。
- `src/server/change-endpoint.ts` 生成响应流，负责鉴权、`ready` 帧、`change` 帧、心跳与关闭。断开、写帧失败与会话校验期间就取消的请求走同一段幂等清理，订阅与心跳一起释放。
- `src/routes/api/events.ts` 把 `GET /api/events?topics=...` 接到上面的处理函数，服务端模块用动态 import 引入。
- 排空不需要改动。实测 SIGTERM 时 srvx 关闭流式 socket，`HttpDrain.wait(8000)` 仍在约 0.5 秒内完成。代价是每次重启都会断流，因此重连后客户端整体重读一次。

- 读端有一条终止规则：鉴权失败后进入终止状态，在途的推送提示不再触发补读，只有窗口恢复这类显式恢复路径才解除终止并重读。否则一次 forbidden 之后还会多读一次。

新增发布点的做法：在写入所在的那个单元里，事务返回之后调用 `publishProjectChange(projectId, chatId?)`。合窗定时器在事务提交之后才发出，回滚最多产生一次被 revision 吸收的误报。

## 发布覆盖

| 写入                                                                             | 位置                                                                                       | 主题                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| Chat 与 Agent 的身份类写入（发消息、改标题、建群、加成员、建 Agent、加成员关系） | `src/domain/identity-write.ts` 统一出口                                                    | Project 加 Chat                 |
| run 状态迁移                                                                     | `src/domain/agent-run.ts` 的 `transitionAgentRun` 与两个批量收敛函数                       | Project 加 Chat                 |
| Task 命令                                                                        | `src/domain/task.ts` 的 `mutateTask`                                                       | Project 加 Chat                 |
| Project 创建、改名、唤醒策略                                                     | `src/domain/project.ts`                                                                    | Project                         |
| Machine 绑定                                                                     | `src/domain/machine.ts`                                                                    | Project                         |
| 成员离开与重新加入                                                               | `src/server/membership.ts`                                                                 | Project                         |
| Worker 上下线与首次上线                                                          | `src/server/worker-gateway.ts`                                                             | 绑定到该 Machine 的每个 Project |
| Agent profile 全局更新                                                           | `src/domain/agent.ts` 的 `updateAgentProfile`，按 `project_member` 反查                    | 每个已加入该 profile 的 Project |
| 自动接续的调度、判定与投递状态                                                   | `src/domain/chat-schedule.ts` 的 `signalScheduleChange(chatId)`，按 `chat.project_id` 反查 | Project 加 Chat                 |

自动接续有两类写入不改变消息也不改变 run，只改判定：

- **claim**：`src/domain/chat-schedule.ts` 的 `claimDueEvaluation` 与 `src/domain/message-wake.ts` 的 `claimDueMessageWake` 在事务提交后立刻推送。判定从这里开始占用 provider，页面必须马上从「等待检查」变成「正在检查」，否则一次几秒的判定在页面上就是没有回应。
- **结算**：`commitEvaluationResult`、`failEvaluation`、`skipMessageEvaluation`、`reconcileChatSchedule`、`reconcileMessageWake` 与投递状态迁移各推一次，页面用最新的尝试与用量换掉「正在检查」。

已知缺口，靠安全轮询兜底，不影响正确性，只影响时延：

- Lease 续租不发推送，这是设计，续租是高频写且不改页面事实。
- 自动接续的推送依赖进程内信号 `signalScheduleChange`：拿不到 chatId 的清理路径（例如整个 Project 被删除后的级联）不发推送，由安全轮询收敛。
- `saveMachineRootDirectory`、`createMachine`、`renewMachineEnrollment` 未接发布。
- Machine 详情页未单独订阅主题。

## 验证证据

| 项                 | 命令                                                                                      | 结果                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型检查           | `pnpm exec tsc --noEmit`、`tsc -p tsconfig.worker.json`、`tsc -p tsconfig.extension.json` | 通过                                                                                                                                                                                         |
| 全量测试           | `pnpm exec vp test run`                                                                   | 110 个文件、1005 个测试通过                                                                                                                                                                  |
| 总控格式与 lint    | `pnpm exec vp lint`、`pnpm exec vp fmt <改动文件>`                                        | 改动文件无告警                                                                                                                                                                               |
| 合并语义           | `tests/change-feed.test.ts`                                                               | 3 次发布合并为 1 条，主题过滤、退订、异常订阅者隔离均通过                                                                                                                                    |
| 客户端连接生命周期 | `tests/change-stream.test.ts`                                                             | 重复回调与幂等退订、主题增减重建连接、自动重连期判定断开、后台首挂不开连接、6 次退避后停手                                                                                                   |
| 端到端推送         | `tests/change-endpoint.test.ts`                                                           | 无 cookie 401，他人 Project 403 且载荷带顶层 requestId，`ready` 后改标题在 Project 与 Chat 两个主题上都收到 `change`，读端取消与提前取消后订阅者归零，积压超 64 帧主动断流，非法主题形状丢弃 |
| 读端推送唤醒       | `tests/info-hub-polling.test.ts`                                                          | 在途推送遇 forbidden 不再补读（去掉终止判断时该用例报 2 次读，属先红后绿）、窗口恢复重新读取、推送连着时用安全间隔而断开后退回 3 秒                                                          |
| 真实进程           | `vp dev --host 127.0.0.1 --port 3121` 后 `curl -sN /api/events?topics=project:...`        | 200、`text/event-stream`、`x-accel-buffering: no`，随即收到 `retry: 3000` 与 `ready` 帧                                                                                                      |

未验证：

- 浏览器里真实标签页收到推送后重读的时延。本次只用 curl 证明了路由与帧，页面侧靠类型检查与单元测试覆盖，未做页面评审。
- Caddy 与 `tailscale serve` 前面的缓冲行为。直连开发服务器的分块传输已确认无缓冲，反代一层未测。

## 对既有文档的影响

[P6b 章节结论](summary.md) 开头「按 3 秒节拍自动刷新」这句描述的是本追加之前的形态。新的形态是本推送给提示、页面按 revision 读、推送不可用时回退 3 秒节拍。章节结论保留当时的交付事实，本追加只在此声明它已被取代。
