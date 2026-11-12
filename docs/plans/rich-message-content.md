# 让 Chat 消息显示富文本

- 目标：每条消息能显示 markdown、图片与 HTML，呈现参考 t3code。
- 现状：正文是一个纯字符串，前端按 `whitespace-pre-wrap` 原样显示。生产库里 52 条消息中，19 条带行内代码、14 条带列表、10 条带加粗，现在都显示为字面标记。
- 三段 PR。RM1 渲染 markdown，RM2 图片与附件，RM3 沙箱 HTML。
- 依赖关系：RM1 最先且独立，RM2 与 RM3 都接在 RM1 的渲染入口上，两者可并行。
- 三段都改交互，合并前都要 operator 看截图与视频。
- 执行走 `playbooks/autopilot-full.md`，每个 PR 一个 owner 负责到合并。
- 形状已由 operator 选定为方案 A 紧凑内联，人类与 agent 统一渲染，选定记录在 `.lavish/rich-message-rm1.html` 的 v2 与收据 `rm1-shape` / `rm1-human-plain`。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-full.md`. The root swarm-verifies each PR before its owner merges. All three PR ids are review-gated, so the operator clicks before each merge.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

本仓库另有两条本计划的硬约束。一是正文与图片的呈现形状归 Human，RM1 与 RM2 的 Build 第一格就是先交 artifact 方案并取得选定，见 Appendix D。二是本章按 `docs/verification.md` 走定向门禁加真实页面证据，不把一次 CI 绿当作验收。

## Program checklist

### Arm the program

- [ ] 把协议与这份计划交给 operator，然后停下。只有 operator 明确说开工才进入执行。
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
  - [ ] RM1 从 `main` 分叉，无前置。
  - [ ] RM2 在 RM1 合入后从 `main` 分叉。
  - [ ] RM3 在 RM1 合入后从 `main` 分叉，与 RM2 无文件重叠。
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

- [ ] code-ready head 上跑一次完整 swarm，一个 gates lane、10 个 live lane、perf lane 与至少两个 audit lane。
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

## 让消息内能显示图片与附件（RM2）

**Depends on.** RM1.

**Files.**

- [ ] Edit `src/contracts/chat.ts`，消息带上附件引用
- [ ] Create `src/contracts/attachment.ts`
- [ ] Edit `src/db/schema.ts` 与新增一个迁移
- [ ] Create `src/domain/attachment.ts`
- [ ] Create `src/routes/api/attachments.$attachmentId.ts`
- [ ] Edit `src/components/chat/message-composer.tsx`，支持粘贴与选择文件
- [ ] Edit `src/components/chat/message-markdown.tsx`，渲染图片与文件块
- [ ] Create `tests/attachment.test.ts`
- [ ] Edit `scripts/browser/ui-scenarios.mjs`

**Build.**

- [ ] 先用 Lavish artifact 给图片与文件块的 2 到 3 个呈现方案，取得 operator 选定，产物存 `.lavish/rich-message-rm2.html`。
- [ ] 附件表只存元数据与相对路径，字节落在实例数据目录下，文件名用短 id 生成，不沿用上传原名。
- [ ] 消息写入口接受附件 id 列表，附件必须属于同一 Project，跨 Project 直接拒。
- [ ] 读取路由按 session 与 Project 鉴权后再回字节，响应带 `content-type` 与 `cache-control`。
- [ ] 单文件上限、单条消息附件数上限与总大小上限写成显式常量并落进契约。

**You see.**

- [ ] 人类在输入框粘贴一张 PNG 并发送后，消息里出现内联图片。
- [ ] 消息列表接口的载荷只增加附件引用，不随图片字节增长。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/attachment.test.ts` 覆盖四个用例，只存元数据不存 base64、跨 Project 附件被拒、超限被拒、删除后读取返回明确错误。跑 `pnpm exec vp test run tests/attachment.test.ts`。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `magpie/auto/deepseek-v4.1-flash:low` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 一条纯文本消息在 trunk 与 head 各看一次。Save `rm2-lane1-trunk-vs-head.png`. Pass when 没有附件的消息渲染与 trunk 逐字一致。
- [ ] Lane 2. 人类粘贴一张 200 KB 的 PNG 并发送。Save `rm2-lane2-paste.png`. Pass when 消息内出现图片元素且图片自然宽高比正确。
- [ ] Lane 3. 夹具里一条带图片附件的 agent 消息。Save `rm2-lane3-agent-image.png`. Pass when 图片渲染并带可读的替代文本。
- [ ] Lane 4. 5 MB 的图片按同一路径发送。Save `rm2-lane4-large.png`. Pass when 列表载荷增量不超过每条约 1 KB 且图片滚动到附近才加载。
- [ ] Lane 5. 一个 PDF 附件。Save `rm2-lane5-pdf.png`. Pass when 渲染为文件名与大小的芯片，不出现坏图图标。
- [ ] Lane 6. 不存在的附件 id。Save `rm2-lane6-missing.png`. Pass when 该处显示明确的缺失占位，且请求返回 404 而不是 500。
- [ ] Lane 7. 磁盘上文件被删掉的附件。Save `rm2-lane7-gone.png`. Pass when 占位写明原因，页面没有未捕获错误。
- [ ] Lane 8. 用第二个账号请求他 Project 的附件 id。Save `rm2-lane8-cross-project.png`. Pass when 返回 403 或 404 且响应体里没有字节。
- [ ] Lane 9. 390 宽度下看同一条带图消息。Save `rm2-lane9-mobile.png`. Pass when 图片不超出容器且页面无横向溢出。
- [ ] Lane 10. 刷新页面并翻到更早的一页。Save `rm2-lane10-paging.png`. Pass when 旧页里的附件同样解析成功，没有坏图。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 消息列表响应里单条消息的字节数，以及 1 MB 图片读取路由的 TTFB。
- [ ] Probe. 同一台机器上对 trunk 与 head 交错各跑 5 次，列表响应用 curl 量字节数，图片路由用浏览器 network 计时。
- [ ] Baseline. 先记 trunk 的单条消息字节数与 head 上无附件消息的字节数。
- [ ] Rule. head 的单条消息字节数不超过 trunk 加 1 KB，1 MB 图片的 TTFB p95 不超过 200 毫秒。任一条不满足即失败。

**Review gate.** operator 在合并前看截图与视频。

- [ ] 把 lane 2、lane 5 与 lane 9 的 screenshot 拷到 `.verify/rich-message/rm2-review-<slug>.png`。
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

本轮是前期探索，没有建分支、没有写代码，因此这里没有已完成的原型。执行开始时按 `playbooks/prototype.md` 先补三个原型，每个都留分支名、SHA 与截图。

- RM1 原型要回答的问题。markdown 与冻结 span 的哨兵方案，在点名落在加粗区间、技能 pill 落在列表项内这两种情形下是否都能保住原字符范围。
- RM2 原型要回答的问题。附件只存元数据时，粘贴大图后消息列表的载荷与加载时机是否符合 RM2 的 perf 规则。
- RM3 原型要回答的问题。沙箱 iframe 的自动高度方案在内容高度变化时是否稳定，以及清洗后的行内 HTML 是否与既有语义色 token 相容。

## Appendix B. Alternatives rejected

- 结构化正文契约。把正文改成块数组，DB、写入口、唤醒快照、飞书出站与两个发送方一起改。当前语料没有需要它的构造，代价却是全链路。
- 只渲染 agent 消息。人类的纯文本里有 `*` 与 `1.` 这类内容，分叉两套渲染规则会让同一条规则在两种发送者下不同。operator 于 2026-11-12 在 artifact v2 上选定统一渲染，本计划按统一渲染执行。
- 不做清洗直接渲染 HTML。消息正文的来源包括模型与 webhook 外部输入，产品里现在没有一处 `innerHTML`，不能为了渲染破这个面。
- 现在就上 tiptap 富文本编辑器。输入侧改动会牵动草稿、@ 候选与 `$` 技能候选，属于另一条线，本程序不包含。
- 服务端渲染 markdown 后落库。渲染结果会随主题与组件变动过期，且会把展示细节写进不可变正文。

## Appendix C. Risks

- 本项目没有 `verify-*` 控制技能。live lane 直接用 Playwright 驱动真实页面，控制路径写在 Boot recipe 里，不假装有控制技能。
- 既有浏览器门禁用 `textContent` 比对 `message-body`。渲染 markdown 后字面标记从文本里消失，RM1 要重跑 `i-chat-flow`、`k-acceptance-flow`、`as-p5a-chat-ui` 与 `p4b-chat-title-flow` 并核对每条断言的语义。
- 飞书出站仍是 `msg_type: "text"`。三段都不改飞书，两边呈现会暂时不一致，记录为遗留项。
- 图片存储会持续增长。RM2 只做上限与鉴权，不做清理与配额，增长速率由 owner 在合并报告里给出实测数字。
- HTML 沙箱是新的攻击面。RM3 的 audit lane 要专门读清洗规则与 CSP 改动，不用单元测试替代。
- 段落标题与运行方式改变时，既有的 p7 与 p6 浏览器门禁可能换义。每个 PR 的 Regression lane 只覆盖本 PR 的载荷面，不做全量。

## Appendix D. Links and reading list

- `docs/project-conventions.md` 规定页面形状先给 Human 2 到 3 个方案，选定前不进入实现。
- `docs/verification.md` 规定验证范围与证据形式，RM1 到 RM3 的门禁选择按它执行。
- `docs/frontend-conventions.md` 规定 token、组件与颜色边界，RM1 与 RM3 的渲染必须读语义 token。
- `docs/feature-map/chat-runs.md` 记录消息分页、`chat-skills` 与冻结 span 的现状。
- `docs/web-ui-decisions.md` 曾把富文本列为非前置项，本任务反转这一条，落地时同步改写那句。
- `docs/p6b/contracts.md` 记录 Chat 正文不在 Info Hub 视角里，附件路由的鉴权按同一边界执行。
- RM1 先过 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/how/SKILL.md`，RM2 与 RM3 的契约改动先过 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/interrogate/SKILL.md`。
- 决策轨迹按 `/Users/snake/workspace/pi-stuff/pi-pstack/skills/show-me-your-work/SKILL.md` 记，落在 `.verify/rich-message/decision-trail.md`。
