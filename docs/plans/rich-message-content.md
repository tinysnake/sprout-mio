# 让 Chat 消息显示富文本

- 目标：每条消息能显示 markdown、图片与 HTML，同时让输入区能写 markdown、带附件与对附件的引用，呈现参考 t3code。
- 现状：正文是一个纯字符串，前端按 `whitespace-pre-wrap` 原样显示。生产库里 52 条消息中，19 条带行内代码、14 条带列表、10 条带加粗，现在都显示为字面标记。
- 三段 PR。RM1 渲染 markdown，RM2 图片、附件与输入区，RM3 沙箱 HTML。
- 版本 v2，基线 `main@edebe97`（已含 RM1）。本版取代 `origin/plan/rich-message-content`，那一份停在 RM1 之前。
- RM1 已合并（PR #53，`c75b419`）。RM2 与 RM3 都从 `main` 分叉，两者无文件重叠，可并行。
- 三段都改交互，合并前都要 operator 看截图与视频。
- 执行走 `playbooks/autopilot-full.md`，每个 PR 一个 owner 负责到合并。operator 于 2026-11-12 把 RM2 及以后指派给本 thread，owner 与 root 是同一个。
- 消息侧的呈现形状已由 operator 选定为方案 A 紧凑内联，人类与 agent 统一渲染，选定记录在 `.lavish/rich-message-rm1.html` 的 v2 与收据 `rm1-shape` / `rm1-human-plain`。
- 输入侧的四条决定记在 Appendix E，RM2 从这四条往下做。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-full.md`. The root swarm-verifies each PR before its owner merges. All three PR ids are review-gated, so the operator clicks before each merge.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

本仓库另有两条本计划的硬约束。一是呈现形状归 Human，每个 PR 的 Build 第一格就是先交 artifact 方案并取得选定，见 Appendix D。二是本章按 `docs/verification.md` 走定向门禁加真实页面证据，不把一次 CI 绿当作验收。输入侧的形状与行为已在 Appendix E 选定。

## Program checklist

### Arm the program

- [x] 把协议与这份计划交给 operator。operator 于 2026-11-12 选定输入侧的形状与行为，并把 RM2 及以后指派给本 thread，owner 与 root 是同一个。
- [ ] 每个 PR 的 review gate 仍要 operator 点，指派不含代点。
- [ ] 开工时读一次，之后每个 tick 从 trunk 重读这些文件。
  - [ ] 本仓库不 vend pstack，技能与 playbook 读本机安装目录，不要用 `git show` 去仓库里找它们。
  - [ ] `/Users/snake/workspace/pi-stuff/pi-pstack/skills/poteto-mode/playbooks/autopilot-full.md`
  - [ ] `/Users/snake/workspace/pi-stuff/pi-pstack/skills/swarm/SKILL.md`
  - [ ] `/Users/snake/workspace/pi-stuff/pi-pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:docs/verification.md`
  - [ ] `git show origin/main:scripts/browser/ui-scenarios.mjs`
- [ ] operator 说开工后，用 `/loop 1h` 装上下面的 tick prompt。不要靠记忆维持节奏。
- [ ] tick prompt 用下面这段原文。

```
Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none.
```

- [ ] operator 喊停或暂停时，立刻给每个 owner 一条零写入指令。

### Spawn owners

- [ ] 每个 PR 一个 owner，生命周期按执行 playbook。
- [ ] 依赖图照这个顺序，父 PR 合入后再开子 PR。
  - [x] RM1 从 `main` 分叉，无前置。已合并，PR #53，`c75b419`。
  - [ ] RM2 从 `main` 分叉，无前置，RM1 已合入。
  - [ ] RM3 从 `main` 分叉，与 RM2 无文件重叠。
- [ ] 文件边界按 PR 段落的 Files 区块执行，越界即打回。
- [ ] review gate 由 operator 在合并前把关，三段都受 gate 约束。

### PR mechanics, for every PR

- [ ] forge 固定用 `gh`，远端是 GitHub，不走其他 CLI。
- [ ] PR 直接开 ready，`gh pr create --base main --head <branch>`。
- [ ] push 前跑一次 `pnpm typecheck` 与 `pnpm exec vp lint`。
- [ ] 每次提交前按 poteto-mode 的 diff 清理做一遍，review 前跑 `/no-comments`。
- [ ] 每条 Bugbot 与安全审查评论按 `../references/bugbot-triage.md` 判。
- [ ] 跨分身沟通必须用 `@显示名` 直接点名，不在正文里用代称，否则对方收不到唤醒。
- [ ] 每个施工或验收窗口结束前处理租约，释放或挂靠到本群，空闲期不留租约在自己手里。
- [ ] code-ready 报告与 babysit 前 rebase 到当前 trunk，fix 轮沿用同一个 merge base。

### Verdict and merge, for every PR

- [ ] code-ready head 上跑一次完整 swarm，一个 gates lane、该 PR 的 `Verify, live` 声明的全部 lane（RM2 为十条）、perf lane 与至少两个 audit lane。
- [ ] 每个 finding 按执行 playbook 的阻塞规则判。干净指没有任何一条阻塞。
- [ ] root 判定干净、Bugbot 处理完、rebase 后 patch-id 不变、CI 全绿后，owner squash-merge。三段都 review-gated，operator 点过再合。

### Boot recipe, for every live lane

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`。
- [ ] `pnpm install --frozen-lockfile`，同一台机器上第一个 lane 做完即可。
- [ ] `DATABASE_URL="$PWD/.verify/rm.sqlite" BETTER_AUTH_SECRET=sprout-swarm-only-not-a-secret pnpm db:migrate`，再按 lane 需要种数据。
- [ ] `APP_ORIGIN="http://127.0.0.1:<port>" vp dev --host 127.0.0.1 --port <port>`，等到 `runtime ready`。
- [ ] 只通过 Playwright 驱动真实页面，只读诊断走 `/api/diagnostics`。
- [ ] 截图统一存 `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png`，回报时给路径。

## 让 agent 消息按 markdown 渲染（RM1）

**状态.** 已合并，PR #53，`main` 上是 `c75b419`。本段的 Lane 10 断言「输入框内仍是原文」已被 RM2 的输入时即时呈现取代，见 Appendix E，本段作为已执行的历史保留不改。

**Depends on.** None.

**Files.**

- [ ] Edit `src/components/chat/message-list.tsx`
- [ ] Create `src/components/chat/message-markdown.tsx`
- [ ] Edit `src/components/chat/message-segments.ts`
- [ ] Edit `package.json` 与 `pnpm-lock.yaml`，加 markdown 解析依赖
- [ ] Create `tests/message-markdown.test.ts`
- [ ] Edit `scripts/browser/ui-scenarios.mjs`

**Build.**

- [x] 先用 Lavish artifact 给 2 到 3 个可比较的呈现方案，取得 operator 选定再动手，产物存 `.lavish/rich-message-rm1.html`（已选定方案 A 紧凑内联，人类与 agent 统一渲染）。
- [ ] `message-markdown.tsx` 导出 `MessageMarkdown({ body, mentions, skills })`，允许子集为加粗、斜体、行内代码、围栏代码、无序列表、有序列表、标题与引用块。
- [ ] 先把 mention 与 skill 的字符区间换成哨兵占位符，解析 markdown，再把哨兵换回既有组件，span 的字符范围一字不改。
- [ ] `message-list.tsx` 的 `MessageBody` 改为调用新组件，人类消息与 agent 消息走同一条渲染。
- [ ] 依赖取 `react-markdown` 与 `remark-gfm`，版本写死，不用 range。

**You see.**

- [ ] agent 回复里的 `**加粗**` 显示为加粗文字，界面上不再出现字面星号。
- [ ] 围栏代码块显示为等宽块，块内换行与缩进保留。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/message-markdown.test.ts` 覆盖四个用例，加粗与列表、围栏代码、mention span 仍落在原字符范围、人类纯文本里的孤立 `*` 与 `_` 不变形。跑 `pnpm exec vp test run tests/message-markdown.test.ts`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash:low` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 同一个 52 条消息的 Chat 在 trunk 与 head 各开一次。trunk 显示字面 `**`，head 显示加粗。Save `rm1-lane1-trunk-vs-head.png`. Pass when head 页面上 `**` 出现 0 次且没有 markdown 的纯文本消息在两侧的可见文字完全一致。
- [ ] Lane 2. 一条包含加粗、无序列表、有序列表与行内代码的 agent 消息。Save `rm1-lane2-mixed.png`. Pass when DOM 里出现 `strong`、`ul > li`、`ol > li` 与 `code`，且可见文字里没有字面标记。
- [ ] Lane 3. 一条含围栏代码块（含缩进与空行）的消息。Save `rm1-lane3-fence.png`. Pass when 出现 `pre > code` 且块内文字与原始正文逐字相同。
- [ ] Lane 4. 一行里同时有点名与加粗的消息。Save `rm1-lane4-mention.png`. Pass when mention 高亮的字符范围与 `message_mention` 行一致，且周边加粗照常渲染。
- [ ] Lane 5. 列表项里带技能 pill 的消息。Save `rm1-lane5-skill.png`. Pass when pill 落在 `li` 内且 pill 文本与冻结 span 一致。
- [ ] Lane 6. 含标题与引用块的消息。Save `rm1-lane6-heading-quote.png`. Pass when 出现对应标题层级与 `blockquote`，且可见文字里没有字面 `#` 与 `>`。
- [ ] Lane 7. 人类与 agent 走同一套 markdown 规则，逐条核五件事，单侧不成对的 `*` 与 `_` 保持字面且字符与输入一致，成对强调渲染为斜体且不作为缺陷，行首 `1. ` 解析为有序列表项且不作为缺陷，词内下划线不得变斜体（例如 `payload_hash` 与 `task_id`），点名与技能 pill 的字符范围不变。Save `rm1-lane7-human-plain.png`. Pass when 五条各自的判定都为真，任何一条不成立即记为阻塞。
- [ ] Lane 8. 5888 字的长消息混合多种构造。Save `rm1-lane8-long.png`. Pass when 无横向溢出且消息列表的 DOM 节点数不超过 trunk 的 8 倍。
- [ ] Lane 9. 浅色与深色各截一张，正文与代码块文字对比度按 `docs/frontend-design.md` 的语义色要求核对。Save `rm1-lane9-themes.png`. Pass when 代码块背景与文字来自语义 token 且实测对比度不低于 4.5 比 1。
- [ ] Lane 10. 人类在输入框粘贴同一段 markdown 并发送。Save `rm1-lane10-composer.png`. Pass when 发送后该消息按同一规则渲染，输入框内仍是原文。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 52 条消息的 Chat 页面首屏消息列表绘制耗时 p95，在 trunk 与 head 各测一次。
- [ ] Probe. Playwright 脚本导航到该 Chat，读 `performance` 里消息列表挂载前后的时间戳，两侧交错各跑 5 次。
- [ ] Baseline. 先记 trunk 的 p95。
- [ ] Rule. head 的 p95 不超过 trunk 的 1.6 倍，且绝对值不超过 60 毫秒。任一条不满足即失败。

**Review gate.** operator 在合并前看截图与视频。

- [ ] 把 lane 2、lane 3 与 lane 9 的 screenshot 拷到 `.verify/rich-message/rm1-review-<slug>.png`。
- [ ] 在 lane 机器上录一段 30 到 60 秒的 video，存为 `.verify/rich-message/rm1-review.mp4`。
- [ ] 在群里贴 screenshot 与 video，停在 merge-ready 等 operator 点。

**Merge.**

- [ ] root 在精确 head SHA 上的干净判定。
- [ ] Bugbot 与安全审查评论处理完。
- [ ] 判定后 rebase 到当前 trunk，patch-id 不变。
- [ ] owner squash-merge。

## 让消息能显示图片与附件，并让输入区支持富文本与附件引用（RM2）

**Depends on.** RM1，已合入 `main`。

**Files.**

- [ ] Edit `src/contracts/chat.ts`，消息带上附件引用与引用 span
- [ ] Create `src/contracts/attachment.ts`，附件记录、引用 token 的生成与解析、三个上限常量
- [ ] Edit `src/contracts/ids.ts`，登记附件 id 前缀 `att`
- [ ] Edit `src/contracts/index.ts`，导出新契约
- [ ] Edit `src/db/schema.ts` 与新增一个迁移，`attachment` 与 `message_attachment` 两张表
- [ ] Create `src/domain/attachment.ts`
- [ ] Create `src/domain/message-attachment.ts`，按 `src/domain/message-skill.ts` 的形状解析与写入引用 span
- [ ] Create `src/server/functions/attachment.ts`，一次性提交的边界与 multipart 解析
- [ ] Create `src/routes/api/attachments.ts`，POST，发送带附件的一条消息
- [ ] Create `src/routes/api/attachments.$attachmentId.ts`，GET，读取字节
- [ ] Edit `src/domain/chat.ts`，`sendMessage` 在同一个事务里落附件与引用 span
- [ ] Edit `src/server/functions/domain-errors.ts`，把 `AttachmentError` 登记进领域错误映射
- [ ] Edit `scripts/verify/lib/test-targets.mjs`，把新测试文件登记进验证清单（未登记 CI 会在开跑前就失败）
- [ ] Edit 既有 `Message` 夹具与新契约的必填字段对齐（`src/dev/scenes/chat/index.tsx`、`tests/chat-live.test.ts`、`tests/message-window.test.ts`、`tests/run-activity-ui.test.ts`、`tests/run-attention-ui.test.ts`）；`src/routeTree.gen.ts` 由 `pnpm exec tsr generate` 重写，不手改
- [ ] Edit `src/server/message-skills.ts`，`preparePiMessage` 把附件写进投递文本
- [ ] Edit `src/components/chat/message-composer.tsx`，`+` 上传、Ctrl+V 粘贴、附件栏、即时呈现
- [ ] Create `src/components/chat/attachment-bar.tsx`，方案 A 的附件条与 `×`、标签按钮
- [ ] Create `src/components/chat/composer-markdown.ts`，镜像层的装饰分段
- [ ] Edit `src/components/chat/message-segments.ts`，附件引用加入 span 类型
- [ ] Edit `src/components/chat/message-markdown.tsx`，渲染图片、文件芯片与附件引用
- [ ] Create `tests/attachment.test.ts`
- [ ] Create `tests/composer-markdown.test.ts`
- [ ] Edit `scripts/browser/ui-scenarios.mjs`

**Build.**

- [ ] 先用 Lavish artifact 给消息侧图片与文件块的 2 到 3 个呈现方案，取得 operator 选定，产物存 `.lavish/rich-message-rm2.html`。输入侧的形状与行为已选定，产物 `.lavish/rich-message-input.html`，四条决定记在 Appendix E。
- [ ] 发送是一次提交。输入框只持本地文件与临时附件 id，提交时用一个 multipart 请求把正文与字节一起送；服务端在同一个事务里写 `attachment`、`message` 与 `message_attachment`，任一步失败整体回滚，不产生孤儿文件。
- [ ] 引用 token 是占位符，且与附件有明确关联。composer 在光标处插入 `[[att:<临时 id>]]`（临时 id 由 composer 自配，例如 `[[att:1]]`），正文照旧是纯字符串，浏览器的 textarea 也是它；服务端按 token 扫出 span，写 `message_attachment(chatId, messageId, attachmentId, start, end)` 时把临时 id 换成真实附件 id。渲染与投递只认 span，不按文件名反查。正文里出现没随这次提交带上来的 token 直接拒掉。
- [ ] 移除附件时一并移除正文里该附件的引用 token，光标位置不跳。
- [ ] 附件表只存元数据与相对路径，字节落在实例数据目录下，文件名用短 id 生成，不沿用上传原名。
- [ ] 消息写入口接受附件，附件必须属于同一 Project，跨 Project 直接拒。
- [ ] 读取路由按 session 与 Project 鉴权后再回字节，响应带 `content-type` 与 `cache-control`。
- [ ] 单文件上限、单条消息附件数上限与总大小上限写成显式常量并落进契约。
- [ ] 输入区的即时呈现扩写既有镜像浮层，只用品字形宽度不变的装饰：`text-shadow` 假粗体、真斜体、行内代码只改背景色与颜色、标题只改颜色、标记调暗。`font-weight` 与字号变化会推移后续文字，禁用。量法与结论见 Appendix A。
- [ ] 附件栏按方案 A，输入框上方一行附件条。每项右上角 `×` 移除，右下角「标签」在光标处插入引用 token。点文件名或缩略图直接查看，未发送用本地 object URL，已发送走读取路由。
- [ ] 附件栏与引用 token 的显示走既有镜像层：token 的原文留在文本流里撑宽度，芯片浮在它上面，镜像层与 textarea 的前进宽度逐字相同（`SkillMark` 的同一手法），所以加附件与加装饰都不移动后面的光标。
- [ ] `preparePiMessage` 把每个附件按文件名、id、落盘绝对路径、类型与大小写进投递文本，agent 因此能打开文件。

**You see.**

- [ ] 人类在输入框粘贴一张 PNG 并发送后，消息里出现内联图片。
- [ ] 人类在输入框打 `**粗体**`，输入框内显示粗体而不是 `**` 字面，发送后消息里同样是粗体。
- [ ] 人类点某个附件的「标签」，光标处出现该附件的引用 token，紧接着写的一句话在消息里挂在该附件上。
- [ ] 消息列表接口的载荷只增加附件引用，不随图片字节增长。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/attachment.test.ts` 覆盖八个用例，只存元数据不存 base64、跨 Project 附件被拒、超限与空附件被拒、删除后读取返回明确错误、临时 id 被换成真实 id 且 span 落在最终正文的 token 上、没被正文引用的附件照样落库、引用不存在的 token 时整体拒且库里与磁盘上都不留痕、点名与技能在带 token 的正文里下标仍对得上。跑 `pnpm exec vp test run tests/attachment.test.ts`。
- [ ] `tests/composer-markdown.test.ts` 覆盖三个用例，装饰只包 span 且字符下标不变、未成对的 `*` 不装饰、同一行里引用 token 与 `@` 点名与 `$` 技能混排时下标仍对得上。跑 `pnpm exec vp test run tests/composer-markdown.test.ts`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash:low` at the PR head, per the boot recipe. RM2 的十 lane 同时盖住消息侧与输入侧。

- [ ] Lane 1. Regression lane against trunk. 一条纯文本消息在 trunk 与 head 各看一次，输入框也各看一次。Save `rm2-lane1-trunk-vs-head.png`. Pass when 没有附件的消息渲染与 trunk 逐字一致，输入框的占位与发送后清空行为也与 trunk 一致。
- [ ] Lane 2. 入附件的三条路径。Ctrl+V 粘贴、`+` 按钮选择、拖放各走一次。Save `rm2-lane2-intake.png`. Pass when 三条路径都能把文件加进附件栏，且附件栏出现在输入框上方。
- [ ] Lane 3. 输入框的即时呈现与光标。在输入框打 `**粗体**`、`*斜体*` 与一个行内代码。Save `rm2-lane3-live-md.png`. Pass when 输入框里看到装饰后的文字，且光标始终落在正确的字符之间，在行首、行中与行尾各点一次再用左右方向键走一遍都不跳字。
- [ ] Lane 4. `×` 移除与「标签」插入。Save `rm2-lane4-remove-tag.png`. Pass when 移除后附件栏少一项且正文里该附件的引用 token 一并消失，点「标签」后光标处出现该附件的 token，周围文字位置不变。
- [ ] Lane 5. 人类粘贴一张 200 KB 的 PNG 并发送。Save `rm2-lane5-paste-390.png`. Pass when 消息内出现图片元素且图片自然宽高比正确，把页面缩到 390 宽度后图片不超出容器且页面无横向溢出。
- [ ] Lane 6. 夹具里一条带图片附件的 agent 消息。Save `rm2-lane6-agent-image.png`. Pass when 图片渲染并带可读的替代文本。
- [ ] Lane 7. 5 MB 的图片按同一路径发送。Save `rm2-lane7-large.png`. Pass when 列表载荷增量不超过每条约 1 KB 且图片滚动到附近才加载。
- [ ] Lane 8. 一个 PDF 附件。Save `rm2-lane8-pdf.png`. Pass when 渲染为文件名与大小的芯片，不出现坏图图标。
- [ ] Lane 9. 附件缺失的两种情形。不存在的附件 id，以及磁盘上文件被删掉的附件。Save `rm2-lane9-missing.png`. Pass when 两处都显示明确的占位且第一种请求返回 404 而不是 500，页面没有未捕获错误。
- [ ] Lane 10. 越权、翻页与原子性。用第二个账号请求他 Project 的附件 id，刷新页面并翻到更早的一页，再用一个会被拒的附件触发一次发送失败。Save `rm2-lane10-cross-project.png`. Pass when 越权请求返回 403 或 404 且响应体里没有字节，旧页里的附件同样解析成功，失败后磁盘与库里都没有新增附件记录且输入框内容不丢。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 消息列表响应里单条消息的字节数，1 MB 图片读取路由的 TTFB，以及输入框从按键到镜像层重绘完成的耗时。
- [ ] Probe. 同一台机器上对 trunk 与 head 交错各跑 5 次，列表响应用 curl 量字节数，图片路由与输入框重绘用浏览器计时，重绘用 2000 字正文含 20 个装饰段。
- [ ] Baseline. 先记 trunk 的单条消息字节数与 head 上无附件消息的字节数。
- [ ] Rule. head 的单条消息字节数不超过 trunk 加 1 KB，1 MB 图片的 TTFB p95 不超过 200 毫秒，输入框重绘 p95 不超过 16 毫秒。任一条不满足即失败。

**Review gate.** operator 在合并前看截图与视频。

- [ ] 把 lane 3、lane 4、lane 5 与 lane 8 的 screenshot 拷到 `.verify/rich-message/rm2-review-<slug>.png`。
- [ ] 在 lane 机器上录一段 30 到 60 秒的 video，存为 `.verify/rich-message/rm2-review.mp4`。
- [ ] 在群里贴 screenshot 与 video，停在 merge-ready 等 operator 点。

**Merge.**

- [ ] root 在精确 head SHA 上的干净判定。
- [ ] Bugbot 与安全审查评论处理完。
- [ ] 判定后 rebase 到当前 trunk，patch-id 不变。
- [ ] owner squash-merge。

## 让消息内能显示 HTML（RM3）

**Depends on.** RM1.

**Files.**

- [ ] Edit `src/components/chat/message-markdown.tsx`
- [ ] Create `src/components/chat/html-block.tsx`
- [ ] Edit `src/server/server-entry.ts`，补 CSP 里的沙箱来源
- [ ] Create `tests/html-block.test.ts`
- [ ] Edit `scripts/browser/ui-scenarios.mjs`

**Build.**

- [ ] 行内 HTML 只接受白名单标签与属性，经 `dompurify` 清洗后再渲染，禁止脚本、事件属性与 `javascript` 链接。
- [ ] 独立 HTML 文档（围栏标为 html 且是完整文档）放进 `iframe` 的 `sandbox` 里渲染，不给 `allow-same-origin`，不给顶层导航。
- [ ] 单条消息的 HTML 长度上限写成显式常量，超限只显示提示与原文。
- [ ] 沙箱 iframe 的高度在内容加载后按内容高度设置，避免内部滚动条。

**You see.**

- [ ] 含 `<b>` 与 `<script>` 的消息里，`b` 渲染而 `script` 消失。
- [ ] 完整 HTML 文档显示在框内，框内样式不污染页面其余部分。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/html-block.test.ts` 覆盖四个用例，脚本标签被去掉、事件属性被去掉、`javascript` 链接被去掉、超长 HTML 走提示分支。跑 `pnpm exec vp test run tests/html-block.test.ts`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash:low` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 同一条纯文本消息在 trunk 与 head 各看一次。Save `rm3-lane1-trunk-vs-head.png`. Pass when 无 HTML 的消息渲染与 trunk 逐字一致。
- [ ] Lane 2. 消息正文含 `<b>粗</b>` 与 `<script>alert(1)</script>`。Save `rm3-lane2-script.png`. Pass when 出现加粗元素且 DOM 里没有 `script` 节点，控制台没有弹窗。
- [ ] Lane 3. 消息正文含带 `onerror` 的 `img` 与 `javascript:` 链接。Save `rm3-lane3-attrs.png`. Pass when 两个属性都被去掉且没有网络请求发出。
- [ ] Lane 4. 围栏标为 html 的完整文档。Save `rm3-lane4-iframe.png`. Pass when 内容显示在 `iframe[sandbox]` 内且外层页面 DOM 没有变化。
- [ ] Lane 5. 沙箱内的脚本尝试访问父页面。Save `rm3-lane5-sandbox.png`. Pass when 访问被拒且页面没有异常冒泡。
- [ ] Lane 6. 应用页面的 CSP 响应头。Save `rm3-lane6-csp.png`. Pass when `script-src` 里没有新增 `unsafe-inline`。
- [ ] Lane 7. 行内 HTML 带 `style` 属性。Save `rm3-lane7-style.png`. Pass when 行内样式被去掉，沙箱内的样式照常生效。
- [ ] Lane 8. 浅色与深色各截一张沙箱内容。Save `rm3-lane8-themes.png`. Pass when 沙箱画布用文档自己的背景且外层主题切换不影响可读性。
- [ ] Lane 9. 一条 10 MB 的 HTML 消息。Save `rm3-lane9-oversize.png`. Pass when 页面按上限分支显示提示，不卡住。
- [ ] Lane 10. 人类自己发一条含 HTML 的消息。Save `rm3-lane10-human-html.png`. Pass when 与 agent 消息同一套清洗与沙箱规则。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 一条 8 KB HTML 正文的清洗加渲染耗时 p95。
- [ ] Probe. 同一台机器上对 trunk 的纯文本渲染与 head 的清洗渲染交错各跑 5 次，用浏览器计时。
- [ ] Baseline. 先记 trunk 上同一正文的纯文本渲染 p95。
- [ ] Rule. head 的 p95 不超过 trunk 的 1.5 倍且绝对值不超过 25 毫秒。任一条不满足即失败。

**Review gate.** operator 在合并前看截图与视频。

- [ ] 把 lane 4、lane 5 与 lane 8 的 screenshot 拷到 `.verify/rich-message/rm3-review-<slug>.png`。
- [ ] 在 lane 机器上录一段 30 到 60 秒的 video，存为 `.verify/rich-message/rm3-review.mp4`。
- [ ] 在群里贴 screenshot 与 video，停在 merge-ready 等 operator 点。

**Merge.**

- [ ] root 在精确 head SHA 上的干净判定。
- [ ] Bugbot 与安全审查评论处理完。
- [ ] 判定后 rebase 到当前 trunk，patch-id 不变。
- [ ] owner squash-merge。

## Close the program

- [ ] 以上每个 box 都有对应证据，缺证据的 box 不勾。
- [ ] 按执行 playbook 给 operator 一份收尾报告，写明三段 PR 的 id、合并顺序与遗留项。

## Appendix A. Prototype evidence

- 输入区的即时呈现已做过原型，取代原计划里「执行开始时先补三个原型」中关于输入框的那一条。分支 `proto/composer-live-md`，SHA `acfaafd73ed5eb82848857fa32ee9f492f5e6816`，页面 `.lavish/composer-live-md-proto.html`，截图 `.lavish/composer-live-md-proto.png`。做法：在真实的 Geist Variable 字体下，把同一段 206 字正文分别铺在装饰层与纯文本层，用 `Range.getBoundingClientRect` 逐字符比较位置。量到 `text-shadow` 假粗体、真斜体、行内代码只改背景色与颜色、标题只改颜色都不移动后续文字（最大 0.36px，亚像素），因为装饰只包 span、不增删字符；`font-weight:700` 把后续文字推移 5.88px，字号变化同理。纯文本镜像与 textarea 的换行数一致（都是 6 行），所以 textarea 与镜像层继续对齐。结论：即时呈现扩写镜像浮层，不换掉 textarea。
- RM1 原型要回答的问题已由 RM1 本身与这次量测回答。markdown 与冻结 span 的哨兵方案，在点名落在加粗区间、技能 pill 落在列表项内这两种情形下都保住原字符范围。
- RM2 原型要回答的问题。附件只存元数据时，粘贴大图后消息列表的载荷与加载时机是否符合 RM2 的 perf 规则。
- RM3 原型要回答的问题。沙箱 iframe 的自动高度方案在内容高度变化时是否稳定，以及清洗后的行内 HTML 是否与既有语义色 token 相容。

## Appendix B. Alternatives rejected

- 结构化正文契约。把正文改成块数组，DB、写入口、唤醒快照、飞书出站与两个发送方一起改。当前语料没有需要它的构造，代价却是全链路。
- 只渲染 agent 消息。人类的纯文本里有 `*` 与 `1.` 这类内容，分叉两套渲染规则会让同一条规则在两种发送者下不同。operator 于 2026-11-12 在 artifact v2 上选定统一渲染，本计划按统一渲染执行。
- 不做清洗直接渲染 HTML。消息正文的来源包括模型与 webhook 外部输入，产品里现在没有一处 `innerHTML`，不能为了渲染破这个面。
- 现在就上 tiptap 富文本编辑器。输入侧改动会牵动草稿、@ 候选与 `$` 技能候选，属于另一条线，本程序不包含。
- 两步提交，先上传拿 id 再发消息。operator 于 2026-11-12 要求发送时一次提交，两步在发送失败时会留下孤儿文件。
- 换掉 textarea 改成 contentEditable，或在镜像里用真 `font-weight` 与字号。真 `font-weight:700` 与字号会把后续文字推移，原型量到 5.88px，光标会落错；contentEditable 会把草稿、`@` 候选与 `$` 技能候选全部重做，而原型已经证明扩写镜像层够用。
- 服务端渲染 markdown 后落库。渲染结果会随主题与组件变动过期，且会把展示细节写进不可变正文。

## Appendix C. Risks

- 本项目没有 `verify-*` 控制技能。live lane 直接用 Playwright 驱动真实页面，控制路径写在 Boot recipe 里，不假装有控制技能。
- 既有浏览器门禁用 `textContent` 比对 `message-body`。渲染 markdown 后字面标记从文本里消失，RM1 要重跑 `i-chat-flow`、`k-acceptance-flow`、`as-p5a-chat-ui` 与 `p4b-chat-title-flow` 并核对每条断言的语义。
- 飞书出站仍是 `msg_type: "text"`。三段都不改飞书，两边呈现会暂时不一致，记录为遗留项。
- 图片存储会持续增长。RM2 只做上限与鉴权，不做清理与配额，增长速率由 owner 在合并报告里给出实测数字。
- HTML 沙箱是新的攻击面。RM3 的 audit lane 要专门读清洗规则与 CSP 改动，不用单元测试替代。
- 段落标题与运行方式改变时，既有的 p7 与 p6 浏览器门禁可能换义。每个 PR 的 Regression lane 只覆盖本 PR 的载荷面，不做全量。
- 即时呈现是亚像素近似。原型里最大偏差 0.36px，在别的字体族、别的 DPR 或浏览器缩放下可能变大。RM2 的 Lane 3 要在真实页面上按字体与 DPR 复测，移动端字体族不同则重新量，量不过就退回「标记调暗、正文保持原文」。

## Appendix D. Links and reading list

- `docs/project-conventions.md` 规定页面形状先给 Human 2 到 3 个方案，选定前不进入实现。
- `docs/verification.md` 规定验证范围与证据形式，RM1 到 RM3 的门禁选择按它执行。
- `docs/frontend-conventions.md` 规定 token、组件与颜色边界，RM1 与 RM3 的渲染必须读语义 token。
- `docs/feature-map/chat-runs.md` 记录消息分页、`chat-skills` 与冻结 span 的现状。
- `docs/web-ui-decisions.md` 曾把富文本列为非前置项，本任务反转这一条，落地时同步改写那句。
- `docs/p6b/contracts.md` 记录 Chat 正文不在 Info Hub 视角里，附件路由的鉴权按同一边界执行。
- RM1 先过 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/how/SKILL.md`，RM2 与 RM3 的契约改动先过 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/interrogate/SKILL.md`。
- 决策轨迹按 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/show-me-your-work/SKILL.md` 记，落在 `.verify/rich-message/decision-trail.md`。
- 输入侧原型的分支 `proto/composer-live-md`（SHA `acfaafd73ed5eb82848857fa32ee9f492f5e6816`）与产物 `.lavish/composer-live-md-proto.html`、`.lavish/rich-message-input.html`。

## Appendix E. 输入侧的决策（2026-11-12）

- 附件栏形状取方案 A，输入框上方一行附件条。落选的是卡片网格与收进底部工具行。
- Markdown 输入行为取「输入时即时呈现」，扩写既有镜像浮层，不取「原样源码」也不取「编辑与预览切换」。
- 提交时机取发送时一次提交，不取先上传再发消息，后者会在发送失败时留下孤儿文件。
- 引用 token 是占位符，但必须与附件有明确关联。token 携带附件 id，span 落库时换成真实 id，不按文件名反查。
- 输入侧并入 RM2，不新开 PR。RM1 合入后 RM2 与 RM3 都从 `main` 分叉。
- RM2 及以后由本 thread 拥有，owner 与 root 是同一个。
- RM1 的 Lane 10 断言「输入框内仍是原文」由本轮的即时呈现取代。RM1 已合并，不回改它的历史段落，改在这里记一笔。
