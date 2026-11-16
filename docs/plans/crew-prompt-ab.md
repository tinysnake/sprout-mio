# Crew 提示词 A/B 测

给 crew lead 与 delegation worker 换上按处境组装的 system prompt 之后，看委派链路的任务成功率有没有变化。

## 主张，跑之前写死

在同一套任务、同一个模型、同一台机器上，只把提示词骨架这一段换掉，任务成功率从 X% 变成 Y%。

决定规则。B 臂提升超过噪声地板就 promote。差异落在噪声地板内就不认定这次改造有效，改文案重测。B 臂更差就回滚并读 transcript。

## 两臂

- A 臂（对照组）。取提示词 PR 之前那个 commit，也就是只有工具面修复的 ref。
- B 臂（处理组）。取提示词骨架 PR 的 ref。

两臂之间只差提示词那一段。两边都不加只在测试里存在的开关，靠 AB_REF 选 ref 跑，这样生产代码里没有测试专用的分支。

## 实测到的形状来自哪里

任务集从用户 2026 年 11 月的 sprout-mio session 里提炼。382 个 session、606 个人类回合里，最高频的形状依次是排查定位线上问题、分支与 PR 合并、UI 与显示、部署到 prod、派活编排、review 评审、代码库问答。当年第二类高频失败（92 个人类抱怨回合）就是本次要测的东西。lead 声称已派活但没有可观测结果、重复派活、成员在 review 里打转不收尾、把提问当成任务。</s>

## 任务集

下面这个 fenced JSON 块是任务集的唯一来源，harness 直接解析它，不要另抄一份。fixture 是 harness 要为该任务准备的沙箱项目，oracle 是 harness 要实现的判定器名字。

```json
[
  {
    "id": "delegate-one-fix",
    "shape": "正例，必须有可观测的委派",
    "prompt": "派一个成员去把项目里 utils/format.js 那个四舍五入的 bug 修掉，跑一遍 npm test，修完把测试结果给我。",
    "fixture": "sandbox-fix",
    "oracle": "delegate_confirmed",
    "evidence": "pi:01a1b03b-4d12-715a-ba09-565e6c55a131 entry:001002 与 pi:01a1a93d entry:000007",
    "mined": "派活幻觉与线上排查两类高频形状，人类只给现象、要结论"
  },
  {
    "id": "delegate-parallel-two",
    "shape": "一次派两件，要看是否落到不同成员",
    "prompt": "两件事同时做。一件事让一个成员查清楚项目里 retry 次数写在哪几个地方，另一件事让另一个成员把 README 里过期的 Node 版本改成 22。两边都做完再一起告诉我。",
    "fixture": "sandbox-parallel",
    "oracle": "delegate_parallel",
    "evidence": "pi:01a1a26d-c7b7-7631-be0f-624935c4901c entry:000007",
    "mined": "并行派活时没有隔离、互相抢分支，是当年反复复发的问题"
  },
  {
    "id": "worker-must-finish",
    "shape": "成员容易在探查里打转，要会收尾",
    "prompt": "让一个成员 review 一下 src/queue.js，我只要分级结论加文件行号，不要再读别的文件，也不要继续查。",
    "fixture": "sandbox-review",
    "oracle": "worker_finishes",
    "evidence": "pi:01a19c17-ef5f-7270-a940-e1650c170ddd entry:000389",
    "mined": "当年人类必须喊「立即停止继续探查」，成员才交出最终报告"
  },
  {
    "id": "donot-delegate-question",
    "shape": "反例，纯提问不该动手",
    "prompt": "我只是问一下，自动接续和小脑接续在项目的英文数据里分别是什么词？",
    "fixture": "sandbox-question",
    "oracle": "no_delegation",
    "evidence": "pi:01a1a438-5a25-72ff-b56c-4994c5b17ff4 entry:000007 与 pi:01a197c8-ffbf-7504-9f57-b04d59595fbb entry:001435",
    "mined": "人类原话就是「我只是在向你提问，你怎么干起活来了」"
  },
  {
    "id": "donot-delegate-small-edit",
    "shape": "反例，lead 自己能做的小事不该派出去",
    "prompt": "把 config/app.json 里的 timeout 从 3000 改成 5000。",
    "fixture": "sandbox-small-edit",
    "oracle": "no_delegation_but_work_done",
    "evidence": "pi:01a19bc9-9d22-7194-bf14-45a2a00b26a2 entry:001615",
    "mined": "人类原话是「我感觉你其实好像已经完成了任务，为什么又开一个新的子代理出去呢」"
  },
  {
    "id": "no-duplicate-delegation",
    "shape": "同一件事不该派第二遍",
    "prompt": "上次已经让成员改过 docs/usage.md 的安装步骤了，你确认一下现在还有没有遗漏的地方，有就补上，不要重复做已经做过的事。",
    "fixture": "sandbox-duplicate",
    "oracle": "no_duplicate",
    "evidence": "pi:01a19bc9-9d22-7194-bf14-45a2a00b26a2 entry:001615",
    "mined": "重复派活浪费并发槽位，是当年第二类高频失败"
  }
]
```

## 判定器，全部机械，从 DB 读

公共字段：delegatedCount、distinctWorkerProfiles、workerRunTerminalStatuses、workerReportedComplete、workerBlocked（含 reason）、leadFinalReplyAtMs、firstDelegationTerminalAtMs、fixtureChangeObserved、settleMs、wallClockPerPhase、testedRef、model。

- delegate_confirmed。派发至少一次，每个被派的 worker run 终态是 completed，worker 调过 sprout_delegation_complete，并且 lead 给人类的最终回复晚于 worker 的 complete 事件。最后一条专治幻觉派活，它保证「宣布完成」不早于「成员真的报完」。
- delegate_parallel。两个不同 worker profile 各自拿到一件，收到两次 complete，lead 汇总。
- worker_finishes。worker run 终态是 completed，不是 canceled 或 timeout，且 worker 调过 complete。
- no_delegation。delegatedCount 为 0，且 lead 给出了回答。
- no_delegation_but_work_done。delegatedCount 为 0，且 fixture 里那个改动确实发生了（读文件内容，不看模型自述）。
- no_duplicate。同一 worker 的派发次数不超过 1。

## 样本量与分辨力

一轮是一套任务在两臂上各跑一遍。3 轮、6 个任务时，每臂 18 次观测，成功率标准误约 ±11 个百分点，只能看大效应。要看清 20 个点以内的差别靠不住，报告里必须写明这一层。

## 报告纪律

领读结论要放最前，写成 faster、slower、no measurable difference 或 inconclusive 之一。数字要带上单位、运行次数、范围与限制因素。

出错单独计数。一次跑崩了既不算成功也不算失败，记为 errored 并单列。settle 超时记 timeout、判定为 null，不要记成 false。

每次跑都要证明工作真的发生，worker run 的真实启动、真实工具调用、真实 token 消耗都进结果行，避免「成功」落在一条没跑起来的路径上。

限制因素也要写。两臂都到 100% 或都到 0% 时指标饱和，这一轮判定为 inconclusive 并说明。

## 账本

每行一条 JSON 进 AB_OUT，默认 .verify/crew-prompt-ab.jsonl，字段含 arm、task、repeat、ref、head、model、判定、各阶段墙钟、token。