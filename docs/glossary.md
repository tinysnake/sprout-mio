# 术语表

状态：持续维护。只收容易被叫错、并且代码里有唯一英文名的词。

规则：中文名是唯一正式名，英文名对应代码与数据；两者是同一个词的两个写法，不做意译扩展。改名按 [项目开发约定](project-conventions.md:9) 直接改到目标形态，不留双名。

## 判定与接续

| 中文     | 英文             | 代码与数据                                                    | 定义                                                                                                     | 不是什么                                                       |
| -------- | ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 唤醒判定 | wake evaluation  | `wake_evaluation`、`WakeProvider`、`src/domain/wake-providers/` | 一次只读、有预算的判定：依据对话、Task 与当前运行情况，决定现在是否唤醒、唤醒谁。结论可以是零个人。       | 不是对话接续的同义词；不产生 run、不改消息、不占 Machine。      |
| 对话接续 | chat continuation | `chat_continuation_*`、`continuation_delivery`                 | 一层持续保障：工作该有人接手时确保有人接手，接不上就提醒 owner，并把结果暴露成可见状态。允许的结论是"现在不需要任何人动"。 | 不是"每条消息都要有人回"；不是 workflow 引擎；不是一次判定。  |
| LLM      | `llm`            | `llm`、`src/domain/wake-providers/llm.ts`、`SPROUT_WAKE_LLM_MODEL` | 唤醒判定的一种 provider 实现：在本机 pi runner 上跑一个模型，产品默认值。                                             | 不是对话接续本身；不是固定负责回话的 Agent；不与 JEV 级联。      |
| JEV      | JEV              | `jev`                                                          | 唤醒判定的另一种 provider 实现，适配器与契约保留，当前不作为可部署选择。                                  | 同上；不与 `llm` 级联。                                          |

边界句：**唤醒判定决定"现在该谁动"；对话接续保证"这件事始终有人负责"，包括"不需要任何人动"这个结论。**

## 租约与机器

| 中文     | 英文           | 代码与数据                                                              | 定义                                                                                                                     | 不是什么                                                   |
| -------- | -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 分身     | agent instance | `agent_instance`、`agentInstance`、`instance_id`                          | 一个 Agent 在某个 Chat 里的具体实例，是消息、运行与租约的实际主体。                                                      | 不是 Agent Profile（配置），也不是进程。                   |
| 持有者   | holder         | `machine_lease.holder_instance_id`、`holderInstanceId`                     | 当前持有某台 Machine 租约的分身；租约的释放、交接与执行授权都以它为准。                                                    | 不是 Machine owner（人类/Project 层角色）；不等于占用中。   |
| 挂靠     | escrow         | `lease_escrow`、`leaseEscrow*`、`lease_authorization.state='escrowed'`     | 把租约临时交给一个 Group 或“Group + Agent”，由其中符合条件的分身凭身份领取；挂靠期间保持占用，原持有者失去执行授权。     | 不是释放（没腾出容量）；不是交接（未指定接任者）；不改进程状态。 |
| 领取     | claim          | `claimLease`、`lease_escrow` 的领取收据                                   | 挂靠中的租约被范围内分身认领并成为新持有者；代价是代次 +1，旧凭据全部失效。                                                | 不是重新申请；不是抢占；不复制进程。                        |

边界句：**持有者是“现在谁在用它”；挂靠是“暂时交给一群人”；领取是“其中一人接过来”。**

## 曾用名

- `chat automation` / 自动接续 → 对话接续（`chat continuation`）。旧名描述的是实现手段（自动化）与结果（继续），这一层实际是一次持续保障，结论可以是不唤醒任何人。
- 同一轮改名落到代码与数据：表 `chat_automation_control` / `chat_automation_command` / `chat_automation_abort`、约束 `automation_*_check`、常量 `CHAT_AUTOMATION_*`、能力串 `chat.automation.*`、实例开关 `SPROUT_AUTOMATION_ENABLED` 与 `/api/health` 的 `automationEnabled` 全部改成 `continuation` 形态，不留别名；迁移 `drizzle/0033_chat_continuation_rename.sql` 负责库内改名。
- `small_brain` / 小脑 → `llm`（唤醒判定器）。旧名把「本机 pi runner 跑的判定器」比作小脑，形容的是实现方式而不是它是什么；它与中文「小脑」所指的脑区无关，且与另一选项 `jev` 混轴（`jev` 也是判定器，不是大脑）。现在两个枚举值直接回答「谁来判定」：`llm` 与 `jev`，设置页标签就是 `LLM` 与 `JEV`（`src/components/continuation/wake-provider-select.tsx`）。代码侧 `SmallBrain*` / `smallBrain` / `small-brain`、环境变量 `SPROUT_WAKE_SMALL_BRAIN_MODEL`、实现文件 `src/domain/wake-providers/small-brain.ts` 一并改成 `Llm*` / `llm` / `SPROUT_WAKE_LLM_MODEL` / `llm.ts`；库内旧值由 `drizzle/0034_wake_provider_llm.sql` 迁移。
- 已否决：`workflow rescue`（`workflow` 在本项目是被明确排除的词，见 [核心范围](core-scope.md:71)）、`work recovery`、`应答兜底`（把对象错定成"回话"）、`safeguard`。
