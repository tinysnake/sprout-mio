# P2 独立验收

本验收的执行模型 `magpie/codex/gpt-6.1-sol` 与 P2 授权入口实现者 p2-a 的模型相同，因此首轮验收独立于 b/c/d 的页面与功能实现者，但对授权入口不具备跨家族独立性；该边界的跨家族补充复核见 [跨家族补充复核 k2](#跨家族补充复核-k2)。验收从真实生产构建、全新 SQLite 和两个 Chromium context 开始，通过页面与生产 HTTP 边界建立数据。实现者文档只用于定位入口，不作为通过证据。

本次只新增验收脚本、浏览器流程、本文档和 `p2-k-` 截图。应用实现未修改。

## 复跑与产物

```sh
bash scripts/verify/k-acceptance.sh
bash scripts/verify.sh
```

k 默认使用端口 3145，可通过 `SPROUT_VERIFY_ACCEPTANCE_PORT` 覆盖。每次运行重建生产产物，并只清理自身 `.verify/k-acceptance/acceptance.sqlite` 及其 WAL、SHM 文件。该数据库供两次生产进程共用。构建与每次 Chromium 流程上限 300 秒，ready 上限 60 秒，SIGTERM 上限 15 秒，进程组退出等待上限 10 秒，HTTP 上限 20 秒。未提供跳过浏览器的开关。

证据位于 `.verify/k-acceptance/`。`evidence.json` 是生产进程断言，`browser-before.json` 与 `browser-after.json` 是逐条浏览器断言。`before.json` 和 `after.json` 只记录页面实际值。`state.json` 保存会话用于重启恢复，含认证 cookie，不提交。`isolation-*.body` 保留完整 RPC 响应，配套 `.headers.json` 保留状态码与 requestId。`isolation-page-*.txt` 保留越权页面可见文本。所有日志和状态文件都是本机复跑产物。

## 真实命令记录

验证的应用基线为 `da4aebb924b41881c6663f38466f7e328f9dded0`。可能超过 60 秒的命令均在后台执行，日志与退出码分别落盘。本机命令记录如下。

| 命令                                                                                             | 退出码 | 关键输出与证据                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                 | 0      | 锁文件不变，562 个依赖安装完成。`/tmp/p2-e-install.log`、`/tmp/p2-e-install.exit`                                                                                                                    |
| `bash scripts/verify/k-acceptance.sh` 首轮                                                       | 1      | 重启断言通过，RPC 响应驱动解码错误。`/tmp/p2-e-k-first.log`、`/tmp/p2-e-browser-first.log`                                                                                                           |
| `bash scripts/verify/k-acceptance.sh` 修正后                                                     | 0      | 8 条生产与 SQLite 断言全 PASS，两次 Chromium 退出 0。`/tmp/p2-e-k-second.log`、`/tmp/p2-e-k-second.exit`                                                                                             |
| `bash scripts/verify/k-acceptance.sh` 最终实现                                                   | 0      | RPC 用例改为函数名到输入的对象表，断言保持不变。8 条 runner、65 条重启前与 12 条重启后浏览器断言全 PASS。`/tmp/p2-e-k-final.log`、`/tmp/p2-e-k-final.exit`                                           |
| `bash scripts/verify.sh` 首次全量                                                                | 0      | `Verification scripts=13 failed=0`。`/tmp/p2-e-verify-full.log`、`/tmp/p2-e-verify-full.exit`                                                                                                        |
| `bash scripts/verify.sh` 最终实现                                                                | 0      | `Verification scripts=13 failed=0`。其中 k 的浏览器重启前 `checks=65 failed=0`、重启后 `checks=12 failed=0`，runner `checks=8 failed=0`。`/tmp/p2-e-verify-final.log`、`/tmp/p2-e-verify-final.exit` |
| `pnpm exec vp fmt scripts/browser/k-acceptance-flow.mjs docs/p2/acceptance.md` 与 `pnpm check`   | 0、0   | 最终文档与脚本格式通过，格式、lint、类型门禁通过。`/tmp/p2-e-final-check.log`、`/tmp/p2-e-final-check.exit`                                                                                          |
| `bash -n scripts/verify/k-acceptance.sh` 与 `node --check scripts/browser/k-acceptance-flow.mjs` | 0、0   | shell 与 JavaScript 语法通过                                                                                                                                                                         |

全量运行包含实际的格式、lint、类型、测试、生产构建与 Chromium 检查。最终文档的格式门禁结果记录于 `/tmp/p2-e-final-check.log`。

首轮 k 的浏览器 RPC 驱动未解开 Seroval 根节点，导致 requestId 比较失败。原始响应已含 `not_found`，页面和重启检查通过。修正为调用 Start 已安装的 Seroval `fromCrossJSON`，没有修改应用或放宽断言。首轮记录保留于 `/tmp/p2-e-k-first.log`、`/tmp/p2-e-browser-first.log`。此失败是验收驱动缺陷，不计为产品缺陷。

## P2 六项对应关系

| development-plan 的 P2 项                             | 结论   | 可定位断言                                                                                                                                                                   |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project 配置、Agent profile 和 Project Agent 成员关系 | 已验证 | `two_authenticated_contexts_two_projects`、`profile_edit_and_configuration_keep_identity_history`、`deep_settings`、`deep_members`、`deep_agents`、`deep_agent`              |
| Chat 与分身持久身份，profile × Chat 唯一              | 已验证 | `repeat_DM_keeps_chat_and_instance`、`profile_chat_duplicate_instance_rejected_by_SQLite`、`restart_literal_chatId`、`restart_literal_instanceId`                            |
| DM 与持久消息，配置、人设修改保留身份和历史           | 已验证 | `profile_edit_and_configuration_keep_identity_history`、`restart_literal_messages`、两条 `restart_literal_message_*`、三条配置字面量断言与 `restart_profile_persona_literal` |
| 稳定 URL，刷新、前进后退保持目标和 Project 上下文     | 已验证 | 七个目标各有 `deep_*`、`reload_*`、`back_*`、`forward_*`                                                                                                                     |
| Project 授权，查询与错误不暴露其他 Project 数据       | 已验证 | 六条 `isolation_page_*`、17 条 `isolation_RPC_*`、两条 `isolation_list_*`、`B_own_Project_still_works_after_denials`                                                         |
| 当前对象的 Info Hub 查询与页面呈现                    | 已验证 | Project 目标校验 profile 名、DM 链接；`deep_chat` 校验 Info Hub instance、成员种类和消息数；Info Hub 两个 RPC 隔离断言；`unavailable_*`                                      |

数据库唯一性通过真实 SQLite 的重复 INSERT 反证。新 instance ID 使用随机 UUID，profile、chat、Project 使用页面建立的实际对象。预期 `SQLITE_CONSTRAINT_UNIQUE` 且该组合仍只有一行。该探针在事务内执行，意外成功也会因断言失败回滚。

## 出口条件与字面量

以下字面量来自最终全量运行的 `before.json` 与 `after.json`。每一行都独立断言相等。

| 字段        | 重启前字面量                               | 重启后字面量                               | 结果           |
| ----------- | ------------------------------------------ | ------------------------------------------ | -------------- |
| chat ID     | `cnv_c7e8f85f-e154-424d-9d78-d7965e568433` | `cnv_c7e8f85f-e154-424d-9d78-d7965e568433` | 相等           |
| instance ID | `ins_cc7e0cb6-4eb6-4f2e-9017-263064836cda` | `ins_cc7e0cb6-4eb6-4f2e-9017-263064836cda` | 相等           |
| 第 1 条消息 | `第一条独立验收消息。`                     | `第一条独立验收消息。`                     | 相等           |
| 第 2 条消息 | `第二条消息，字面量与顺序都必须保留。`     | `第二条消息，字面量与顺序都必须保留。`     | 相等，顺序相同 |
| Git remote  | `https://example.test/acceptance/a.git`    | `https://example.test/acceptance/a.git`    | 相等           |
| 默认分支    | `acceptance-main`                          | `acceptance-main`                          | 相等           |
| 工作目录    | `workspaces/acceptance-a`                  | `workspaces/acceptance-a`                  | 相等           |
| 人设        | `编辑后的人设，保留身份与历史。`           | `编辑后的人设，保留身份与历史。`           | 相等           |

P2 出口条件逐条结论如下。

| 出口条件                              | 结论   | 实际对比                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 重启后同一对话仍对应同一分身          | 已验证 | 上表 chat ID 与 instance ID 逐字相等；列表恰好为该 chat ID 的单元素数组                                                                                                                                                                                                                                             |
| 消息与配置保留                        | 已验证 | 两条正文、有序数组、三项 Project 配置与人设均逐字相等；profile 编辑页另行读取相同人设与 profile ID                                                                                                                                                                                                                  |
| 两个 Project 的上下文与查询边界可验证 | 已验证 | A 为 `prj_ecb61bab-2745-44d1-a8c6-5693ee094454`，B 为 `prj_6147c3ef-d46d-4831-b80d-7863830de0c5`。七个目标的直接进入、刷新、后退和前进均与原 URL 及对象值相等。B 对 A 的六个页面与 17 个 RPC 均 `not_found`，完整 RPC 响应体均 `leaked: []`；B 自己的分支保存值与刷新值均为 `b-control`，自己的 Info Hub `ok: true` |

最终运行的 bootId 由 `boot_f4297469-dde9-432f-9777-02c53d12638d` 变为 `boot_7797467e-a2bf-41f1-b098-edbb27e763fc`。两次健康检查均为 ready，迁移已应用。两次 SIGTERM 退出码均为 0。

本次未发现缺陷。

重启前先把实际页面值与明确输入比较，再保存快照。重启后使用新 Chromium 进程与恢复的 A 会话，从页面重新取值，逐字段与原快照比较。消息既比较整个有序数组，也分别比较第 1、2 条正文。profile 编辑页另行比较 profile ID 与人设；对话列表必须恰好为原 chat ID 的单元素数组。

两次生产进程都通过 `pnpm start` 启动。第一次 SIGTERM 退出 0 后才启动第二次。bootId 必须不同，数据库路径保持相同。两次退出码及 bootId 对保存在 `evidence.json`。

## 隔离反证与正常对照

B 使用独立 context 注册并创建自己的 Project。B 访问 A 的 Project hub、配置、成员、对话列表、对话详情及 profile 详情，逐页断言可见 `not_found` 与 `req_` UUID。

以下每个生产 HTTP 调用都断言 HTTP 200、`ok === false`、`error.code === "not_found"`、错误与载荷 requestId 等于响应头，并检查完整响应体的零泄漏。

| 对象           | RPC                                                                   |
| -------------- | --------------------------------------------------------------------- |
| Project        | `getProjectFn`                                                        |
| Project 配置   | `getProjectProfileFn`、`updateProjectProfileFn`                       |
| Project 成员   | `listProjectMembersFn`、`addProjectMemberFn`、`removeProjectMemberFn` |
| Agent profile  | `getAgentProfileFn`、`updateAgentProfileFn`                           |
| DM             | `listChatsFn`、`createDirectChatFn`、`getChatFn`                      |
| 对话成员与分身 | `listChatMembersFn`、`listInstancesForChatFn`                         |
| 消息           | `listMessagesFn`、`sendMessageFn`                                     |
| Info Hub       | `getProjectInfoHubFn`、`getChatInfoFn`                                |

被隔离 token 集合含 A 的 Project ID 与名称、profile ID 与名称、chat ID、instance ID、两条 message ID、A 的 user ID 与名称，并额外覆盖消息正文、人设及三项配置。页面检查可见文本，RPC 检查原始响应体。每条成功输出都含 `leaked: []`。

B 的 `listProjectsFn` 必须只返回 B 的 Project ID，`listAgentProfilesFn` 不含 A 的 token。拒绝 A 的全部调用后，B 在自己的配置页保存 `b-control`，刷新后字面量不变，自己的 Info Hub 返回 `ok === true` 与 B 的 projectId。A 重启后的快照比较同时证明越权写入没有改变 A 的配置、人设或消息。

## 七个页面的导航矩阵

| 目标       | URL                         | 目标证据                                                     |
| ---------- | --------------------------- | ------------------------------------------------------------ |
| `project`  | `/projects/<A>`             | Project 名、Project 子导航、Info Hub Agent 名、DM 链接       |
| `settings` | `/projects/<A>/settings`    | 三项配置                                                     |
| `members`  | `/projects/<A>/agents`      | Agent 成员名                                                 |
| `chats`    | `/projects/<A>/chats`       | chat ID 的单元素列表                                         |
| `chat`     | `/projects/<A>/chats/<cnv>` | chat、instance、人设、消息；Info Hub 成员、instance 与消息数 |
| `agents`   | `/agents`                   | profile 名与 ID 的单元素列表                                 |
| `agent`    | `/agents/<agp>`             | profile ID 与人设                                            |

每行分别执行直接 `goto`、刷新、进入下一行后后退、再前进。第七行的下一目标回到第一行。每次都比较 URL 和该行目标值。Project 内页面还比较 A 的 Project 名、配置导航 href、Info Hub Agent 名及 DM href。全局 profile 页面用 profile ID 定位，不捏造 Project 上下文。

## 未实现状态、截图与限制

五个 Project 页面逐一断言 Agent run 视角的「未实现」徽标和 P3 原因，以及 Machine 视角的「未实现」徽标和 P4 原因。对话页另行检查 chat run 视角与「P2 未接入真实 Pi 运行」文案，两条消息 sender 均为 human。七个目标都拒绝「0 个活动 run」「无活动 run」「无 Machine」成功空值文案。两次 Chromium 会话均要求零 console.error 与零 pageerror。

以上为 P2 当时的验收行为。P3-b 已移除静态的「P2 未接入真实 Pi 运行」文案；P3-d 已将 Project 与 Chat 的 run 视角改为真实数据，并按 [SO17 更新既有断言](../p3/info-hub-runs.md#so17-断言更新)，Machine 仍属 P4，继续显示显式未实现状态。历史截图与当时观测保留，当前验收见 [P3 阶段结论](../p3/acceptance.md#阶段结论)。

截图位于 `docs/p1/evidence/`，本次新增文件如下。

- `p2-k-before-chat.png`、`p2-k-after-chat.png`、`p2-k-after-settings.png`。
- `p2-k-deep-project.png`、`p2-k-deep-settings.png`、`p2-k-deep-members.png`、`p2-k-deep-chats.png`、`p2-k-deep-chat.png`、`p2-k-deep-agents.png`、`p2-k-deep-agent.png`。
- `p2-k-isolation-project.png`、`p2-k-isolation-settings.png`、`p2-k-isolation-members.png`、`p2-k-isolation-chats.png`、`p2-k-isolation-chat.png`、`p2-k-isolation-agent.png`。
- `p2-k-B-control.png`。

本次未验证项如下。

- P3 的真实 Pi session、Agent 回复、run、运行时配置快照与宿主仓库入口。本次没有用模拟 Agent 回复充当接入证据。这是 P2 当时的未验证面；P3-a/b/c/d 已接入真实数据并由 p3-e 验收，剩余限制见 [P3 未验证项](../p3/summary.md#未验证项汇总)。
- P4 的 Machine、租约与宿主执行恢复。
- P5 的 Task、Group 与 Public Channel，P6 的自动接续，P7 的手机与 PWA。
- 并发写入、多进程 SQLite 竞争、大数据分页、性能、长时间会话过期及备份恢复。
- 运行时快照的隔离。P2 没有这项业务对象；已验证的是现有查询和错误载荷。

以上能力不能因本次验收通过而视为已支持。此限制描述 P2 当时的验收范围；后续 P3 已验证的能力以 P3-e 的逐项结论为准，Machine 仍属 P4。未发现产品缺陷的结论以本次断言覆盖范围为限。

## 跨家族补充复核 k2

本文上文的 p2-e 验收跑在 `magpie/codex/gpt-6.1-sol` 上，与授权入口实现者 p2-a 的模型家族相同，因此那一轮验收独立于 b/c/d 的页面与功能实现者，但对 Project 授权边界不具备跨家族独立性。补救 unit p2-g 的复核脚本 `scripts/verify/k2-cross-family-isolation.sh` 与页面流程 `scripts/browser/k2-isolation-flow.mjs` 由 `magpie/group/auto-mimo-v2-6-flash`（reasoning `high`）独立编写，断言不照抄 k-acceptance。k2 与 p2-a、p2-e、p2-f（均为 `magpie/codex/gpt-6.1-sol`）不同家族，与 b/c/d（`magpie/group/auto-mimo-v2-6-flash`）同家族，所以 k2 只对授权边界提供跨家族独立性，不构成对 b/c/d 页面与功能实现的独立复核；页面层的独立性仍以 p2-e 的断言为准。

复跑命令为 `bash scripts/verify/k2-cross-family-isolation.sh`。k2 使用端口 3146（`SPROUT_VERIFY_K2_PORT` 可覆盖），从真实生产构建、`pnpm start`、两个真实账号的独立 session 与两个独立 cookie 开始；纯 HTTP 覆盖 RPC 与诊断，Chromium 只承担页面断言。证据位于 `.verify/k2-cross-family-isolation/`：`evidence.json` 是逐条断言结果，`browser.json` 是逐条页面断言，`deny-*`、`sub-*`、`enum-*`、`diagnostics-*`、`B-own-*`、`A-unchanged-*` 的 `.body` 保留完整响应，`a-snapshot.json` 保存越权尝试前的 A 基线。截图位于 `docs/p1/evidence/p2-k2-isolation-*.png`。本机最终运行 `k2 runner checks=45 failed=0`、`k2 browser checks=6 failed=0`，退出码 0。

k2 的断言分组如下。

| 组         | 内容                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 越权拒绝   | B 用 A 的 projectId 调 Project 详情、配置读写、成员列出/添加/移除、对话列出、Info Hub Project 视角与 createDirectChat；B 用 A 的 chatId 调对话详情、成员、分身、消息、发消息、Info Hub Chat 视角；B 用 A 的 profileId 调 profile 详情与更新。每条独立断言 HTTP 200、`ok: false`、`error.code: not_found`、错误 requestId 等于响应头、完整响应体零泄漏 |
| ID 替换    | B 的 projectId × A 的 profileId 组合（建 DM、加成员、伪造 human sender 向 A 的对话发消息）、B 的对话 × A 的 profile（伪造 agent sender）均被拒绝；SQLite 探针确认没有 (A profile × B project) 的 instance 或成员行                                                                                                                                    |
| 枚举       | B 传 A 的 projectId 的 list 入口返回错误而不是 `ok: true` 空数组；`listProjectsFn` 只含 B 自己的 Project，`listAgentProfilesFn` 不含 A 的 profile                                                                                                                                                                                                     |
| 诊断       | B 查 `/api/diagnostics?projectId=<A>` 返回空数组；B 查 A 写请求的 requestId 时只可能命中无 projectId 的 `http.response` 行（P1 约定的非 Project 诊断），断言不含任何 Project 范围数据与 A 的 token                                                                                                                                                    |
| 正对照     | 越权尝试全部结束后，B 对自己的 Project 完成 11 项读、配置写后重读、发消息后列表增长、重复建 DM 幂等返回同一分身，全部成功                                                                                                                                                                                                                             |
| A 数据不变 | 越权尝试后 A 重新读取成员、消息、人设、配置、对话列表，逐对象与越权前快照 deepEqual；SQLite 探针确认 A 的对话仍恰好两条消息、sender 仍为 A 本人、人设未被覆盖、不存在任何 `k2-forbidden` 写入                                                                                                                                                         |
| 页面       | B 用自己的 session 直接访问 A 的 `/projects/<A>`、`/projects/<A>/settings`、`/projects/<A>/agents`、`/projects/<A>/chats/<cnv>` 与 `/agents/<A profile>`，断言渲染 `not_found` 与 `req_` UUID、页面文本不含 A 的任何 id、名称、人设、消息正文与邮箱，且零 console error                                                                               |
| 进程       | 生产构建、健康检查 ready、SIGTERM 退出码 0                                                                                                                                                                                                                                                                                                            |

与 k-acceptance 相比，k2 新增的对抗角度及其理由：ID 替换交叉组合验证「授权查询过滤双方 id」而非只挡单 id；越权写后立即从 A 的会话重读而不是依赖重启快照；覆盖 `/api/diagnostics` 的两个入口（k-acceptance 未覆盖诊断）；验证 `sendMessageFn` 边界把伪造 sender 改写为认证会话身份；用 SQLite 探针证明越权尝试没有留下任何交叉行。

复核结论：授权边界在 k2 的断言范围内成立。B 对 A 的全部对象读写均被拒绝且零泄漏，越权尝试没有改变 A 的任何数据，B 自己的 Project 全程正常。复核中发现一条非授权类缺陷：`createDirectChatFn` 在 B 的 Project 引用他人的 profileId 时返回 `internal` 而不是约定的 `not_found`（`src/server/functions/chat.ts` 的 failure 未映射 `AgentError`，而 `src/server/functions/agent.ts` 已映射）。该行为不泄漏数据、也不构成存在性 oracle（同一入口对格式合法但不存在的 profileId 返回同样的 `internal`），k2 以 `sub_B_ownProject_A_profile_createDM_rejected_without_leak` 与 `sub_profile_reference_indistinguishable_from_nonexistent` 两条断言固定了这两个安全不变量。该缺陷已由 p2-h 修复：chat 边界现在映射 `AgentError`，复现路径返回 `not_found` 且不再写 error 诊断；k2 的 `sub_B_ownProject_A_profile_createDM_rejected_without_leak` 已改回严格 `not_found` 断言，零泄漏与不可区分两条不变量保留为附加断言，行为测试见 `tests/chat.test.ts`。首轮 k2 运行中另有一处断言自身错误：曾把「伪造 agent sender 被边界合法改写」与「P1 约定的非 Project 诊断按 requestId 可见」误判为缺陷，已修正为上述断言。

## P2 补充收尾与只读审查

P2-f 之后还有 g、h、i、j 四个 unit。P2 最终基线截止 `db185f8`，完整范围 `28d4fb2..db185f8`，共 10 个 unit、9 行 ledger，对应 PR #10 至 #18；j 只读，无 PR。`git log --first-parent --oneline 28d4fb2..db185f8` 可重建合入顺序。原 e 与 k2 的历史结果不因新增复核而改写。

| unit                | Git 身份与结论                                                                                                           | 可复跑证据与边界                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| g，跨家族复核 k2    | PR #16，head `b9a6b92`，merge `cd1bb1c`。mimo 相对 a/e 的 sol 独立，授权拒绝与正常对照成立；发现一条错误映射缺陷         | [k2 正文](#跨家族补充复核-k2)，`bash scripts/verify/k2-cross-family-isolation.sh`；与 b/c/d 同家族，不扩展独立性声明                                      |
| h，错误映射修复     | PR #17，head `458f533`，merge `d4aedbb`。chat 边界补 `AgentError` 映射，k2 恢复严格 `not_found`                          | [k2 修复记录](#跨家族补充复核-k2)，`bash scripts/verify/k2-cross-family-isolation.sh`；行为测试在 `tests/chat.test.ts`                                    |
| i，错误映射清扫     | PR #18，head `6886bfa`，merge `db185f8`。五个边界共用错误映射表，可达错误与映射差异表为空，最初候选均未实测成立          | [共享表说明](summary.md#已落实的架构说明更新)，`bash scripts/verify/m-error-mapping.sh`；coordinator 删除 `AgentError` 行得到红、恢复得到绿，未制造新缺陷 |
| j，第三家族只读审查 | 无 PR。glm 在本次审查前无 P2 产出，相对 sol 的 a/e/f 与 mimo 的 b/c/d 独立；未发现授权、事务或校验缺陷，确认五份映射重复 | 原报告 `/tmp/p2-j-review/report.md` 与 exp1 至 exp5 为本机产物；i 的门禁可复跑共享表回归，不能替代 j 的全部只读实验                                       |

j 的未修事项已由 coordinator 路由。CSRF 中间件归 P7 前；`getInstance` 死代码与跨实体归属约束原路由 P3，P3-e 已证实不一致 run 可被 SQL 写入但领域层拒绝消费，约束方案继续归 P4+；索引缺口归 P5。
