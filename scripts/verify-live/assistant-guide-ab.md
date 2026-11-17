# 个人助理 guide A/B 检查器

从当前 checkout 运行（先 `pnpm install --frozen-lockfile`）：

```bash
# 默认 dry；实际 Pi SDK + 本地脚本模型，不访问付费模型
AB_DRY=1 AB_REF_A=0130cbe AB_REF_B=origin/main bash scripts/verify-live/assistant-guide-ab.sh
# 单 ref 也可以；用恢复提交的 SHA 替换 HEAD 可固定受验对象
AB_DRY=1 AB_REF=HEAD bash scripts/verify-live/assistant-guide-ab.sh
# 断言单测，含 CDN 红例 → 内联绿例
node --test scripts/verify-live/assistant-guide-ab/checks.test.mjs
# 全链路负例：预期退出 1，report-reply.md:5 报 external-url
AB_DRY=1 AB_FIXTURE_CDN=1 AB_REF=HEAD bash scripts/verify-live/assistant-guide-ab.sh
```

付费 live 由 Human 运行；必须显式 `AB_DRY=0`，沿用现有模型选择变量和 Pi 凭证：

```bash
AB_DRY=0 SPROUT_VERIFY_PI_MODEL=provider/model AB_REF_A=0130cbe AB_REF_B=origin/main bash scripts/verify-live/assistant-guide-ab.sh
```

可选：`PI_CODING_AGENT_DIR` 指定现有 Pi 安装/凭证目录；`AB_EFFORT` 默认 `off`，两边一致；`AB_OUT` 指定新一轮证据目录的父目录；`AB_TURN_TIMEOUT_MS` 默认 180000，`AB_TIMEOUT_MS` 每个 ref 默认 480000。负例开关只作用于 dry fixture。两边严格使用相同任务与阈值，模型不会自动回退。

## 路径和证据

参考 `pi-dm-turn.sh` 的 sendMessage → agent_run → config_snapshot.sessionFile → transcript 流程，以及 `tests/fixtures/assistant-feedback.ts` 的 assistant profile / runtime 启动方式。当前基线没有 `scripts/verify-live/lib/`，共享模型 fixture 在 `scripts/verify/lib/`，crew A/B 模块在 `scripts/verify-live/crew-prompt-ab/`。

普通 DM 并不保证挂载 `ASSISTANT_GUIDE`；本检查器显式创建 `purpose: "assistant"` 的 profile，逐任务开独立 DM，并断言 run snapshot 的 purpose。它走实际 domain、runtime、Pi host 和持久化链路，不替换 runner。dry 还逐条核对本地模型收到的 system prompt 包含被测 ref 的两个完整常量，`fixture.json` 记录 exactGuidesVerified 和零付费调用证据。

每个 ref 用 `git archive` 解出隔离临时 checkout，runner、extension、domain、theme 都来自该 ref，只叠加当前检查器。依赖复用调用 checkout 的 node_modules，因此 package.json / pnpm-lock.yaml 不一致时明确失败。无需移动当前分支，也不接触其它 worktree。网关绑定 0.0.0.0，并用同一 LAN hostname 作 APP_ORIGIN；结束后关闭网关、runtime、fixture 并清理临时源码。

证据默认保存在 `.verify/assistant-guide-ab/run-*/`：manifest 记录 ref 与解析后的 commit；各 arm 保存数据库、run 配置、原始 transcript、最终回复、results.json、driver.log 及耗时/退出码。失败输出文件路径 + 行号；中间 assistant 文本另存文件，避免错误定位到最终回复。原始 session 路径可能随临时 checkout 清理失效，已复制的 `*-transcript.jsonl` 可直接检查。

## 机械断言及阈值

- HTML 报告：最终回复必须有 fenced `html` 块；每块检查 src/href、CSS url()/@import 不含 http(s) 外部 URL，也拒绝 // URL。常见数字实体和 CSS 转义会解码检查。
- 高度：拒绝 100vh；html/body/:root 的 height、min/max-height 和 block-size 仅允许 auto、内容尺寸等非固定关键字，包括 style 属性和常见媒体查询。图表等子元素可以固定高度。
- 变量：每个 `var(--xxx)` 必须在该 ref 的 `src/theme.css` 有定义，带 fallback 的未知变量也失败。旧指南删掉但 theme 仍有的 6 个变量必须通过；不要求模型一定使用它们。
- 一句话任务：整个会话的 assistant 文本都不得出现 HTML 块或常见 HTML 标签，包括中间说明；检查最终回复与 transcript 的最后一条 assistant 文本一致。
- 简短代理指标：报告去掉 HTML 块后 ≤600 个 Unicode code points，一句话回复 ≤160。不会把 HTML 本身计入说明长度。

长度预算是保守的固定契约。此次 0130cbe 本地 fixture 的说明/回复实测为 9/7 字符，远低于 600/160；**未运行付费基线，阈值尚未按真实模型输出校准**，不能称其为真实模型基线实测值。首次 live 应保存长度分布后再决定是否收紧，不能为某一侧单独放宽。

## 本轮离线结果与覆盖边界

- 0130cbe（压缩前）、bca1af1（压缩后）与 584a24d（加回指南）均通过本地 fixture 两项任务；5 个断言测试通过。CDN 红例失败后改为内联内容通过，另有全链路 CDN 负例验证非零退出与回复文件行号。
- dry 只证明实际 assistant 路径、指南装载、transcript 提取和断言能工作。模型输出由 fixture 指定，不能据此声称真实模型表现等价或压缩没有影响。
- 无已证实的“基线会过、压缩后会挂”断言：两版都保留网络/高度/简短规则，变量检查又以实际 theme 为准。它不能衡量指南变量可发现性、前景对比质量、字体选择、措辞自然度、需要排查时是否给出恰当细节，也未覆盖 watch/proposal 行为。
- 检查器分析静态源码中的常见 HTML/CSS 写法，不执行 JS，不检查脚本动态拼接 URL/高度/变量或所有 CSS 语法，不是安全沙箱验证；不做截图/视觉评审，不验证数据计算与图表质量。报告中 HTML 主体不设长度预算。
