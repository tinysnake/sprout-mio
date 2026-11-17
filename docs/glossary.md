# 术语表

状态：持续维护。只收容易被叫错、并且代码里有唯一英文名的词。

规则：中文名是唯一正式名，英文名对应代码与数据；两者是同一个词的两个写法，不做意译扩展。改名按 [项目开发约定](project-conventions.md:9) 直接改到目标形态，不留双名。

## 原生助理

- 助理（assistant）：`agent_profile.purpose = 'assistant'` 的独立 Agent，使用自己的 model / effort，在 Human 所有的 Project DM 中观察、提出工作与关注建议。权限由程序限定，详见[原生助理契约](assistant-core.md)。
- 关注（watch）：Human 在某个助理 DM 激活的持续 Chat 观察关系，代码为 `assistant_watch`；不等于工作 Agent 的运行生命周期。
- 工作提案（proposal）：固定目标与正文、经 Human 单次确认后产生原生 `assistant_work` input 的记录，代码为 `assistant_proposal`。

## 已移除的旧概念

Group、公共频道、唤醒判定（wake evaluation）与对话接续（chat continuation）已随 Crew 的落地整体移除：Crew 是 Project 内唯一的多人对话，消息、任务与自动化只到 lead。历史文档与迁移里出现的 `group_agent`、`group_owner`、`wake_policy`、`chat_schedule`、`wake_evaluation`、`continuation_delivery` 等名称只用于描述过去，不再是可用的产品或代码概念。

## 租约与机器

| 中文     | 英文           | 代码与数据                                                              | 定义                                                                                                                     | 不是什么                                                   |
| -------- | -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 分身     | agent instance | `agent_instance`、`agentInstance`、`instance_id`                          | 一个 Agent 在某个 Chat 里的具体实例，是消息、运行与租约的实际主体。                                                      | 不是 Agent Profile（配置），也不是进程。                   |
| 持有者   | holder         | `machine_lease.holder_instance_id`、`holderInstanceId`                     | 当前持有某台 Machine 租约的分身；租约的释放、交接与执行授权都以它为准。                                                    | 不是 Machine owner（人类/Project 层角色）；不等于占用中。   |
| 挂靠     | escrow         | `lease_escrow`、`leaseEscrow*`、`lease_authorization.state='escrowed'`     | 把租约临时交给一个 Crew 或“Crew + 指定 Agent”，由其中符合条件的分身凭身份领取；挂靠期间保持占用，原持有者失去执行授权。     | 不是释放（没腾出容量）；不是交接（未指定接任者）；不改进程状态。 |
| 领取     | claim          | `claimLease`、`lease_escrow` 的领取收据                                   | 挂靠中的租约被范围内分身认领并成为新持有者；代价是代次 +1，旧凭据全部失效。                                                | 不是重新申请；不是抢占；不复制进程。                        |

边界句：**持有者是“现在谁在用它”；挂靠是“暂时交给一群人”；领取是“其中一人接过来”。**

## 曾用名

- `chat automation` / 自动接续 / `small_brain` / 小脑：都是已移除的对话接续与唤醒判定体系里的旧名，不再指向任何现存实现。
- 已否决：`workflow rescue`（`workflow` 在本项目是被明确排除的词，见 [核心范围](core-scope.md:71)）、`work recovery`、`应答兜底`（把对象错定成"回话"）、`safeguard`。
