# UI 迁移 独立技术收口（只读，独立验收 B1-B4）

结论：技术 PASS。范围限定在两个提交，不声称 21 脚本在 3c745a6 上跑过。
Human 体验确认仍 pending，未计入本次判定。

## 验证范围

1. 全量基线 251ddbb（`/tmp/ui-migration-parent-final/`）
   - `result.json`: revision 251ddbb…, exitCode 0, 518.9s；`verify.log` PASS 307 行、FAIL 0 行，
     末行 `Verification scripts=21 failed=0`；单测 158 见 `/tmp/ui-final-regression/report.md`（`Tests 158 passed`）。
   - B1 闭环：`o-turn-semantics.sh:319` 用 `?info=1`，`:348` 显式等 `chat-inspector` visible；
     P3 三处断言未删（`info-chat-runs-active-status` 排队/运行、`info-turn-active-run` 未投递、
     stop 后 `已停止` + `pending-input-count`），日志 1768 行 PASS 带 `p3-b-run-running-pending.png`。
   - B2 闭环：`scripts/browser/project-flow.mjs:53-66` 的 `readFieldError` 先等 `aria-invalid=true`，
     再按 `aria-describedby` 取可见 `role="alert"`；产品侧 `field.tsx:38-58` + `input/textarea`
     确实输出 `aria-describedby` / `aria-invalid`。原断言强度保留：仍校验 `名称不能为空`、
     `validation_failed`、页面 requestId 与响应头 `x-sprout-request-id` 一致、`/api/diagnostics` 有该行
     （`project-flow.mjs:215-240`）。`e-project.sh` 在 251ddbb 为 PASS。
   - B3 闭环：`c-data-auth`、`e-project`、`h-project-agents`、`i-chat`、`j-info-hub`、`k-acceptance`、
     `o-turn-semantics` 在同一次运行里全部 PASS（`verify.log` 83/1602/1635/1646/1654/1664/1773 行）。
   - B4：`c-data-auth` PASS 覆盖登录成功整页导航路径；`src/routes/login.tsx` 在 251ddbb..3c745a6 无改动。

2. 单点修复 251ddbb..3c745a6（`/tmp/ui-final-devfix/`、`/tmp/ui-parent-devfix/`）
   - 提交只有一个文件 `src/routes/_authed/projects.$projectId.settings.tsx`，2 行：
     key 改为 `profile-${projectId}` / `repo-${projectId}`；仍随 projectId 变化，跨 Project 重挂语义保留，
     未改 props、请求参数与断言。
   - 红绿：`red.log` 9/10（`FAIL no_console_errors :: 2 条`）→ `green.log` 10/10（`0 条`），
     `settings_real_facts_and_save` 仍 PASS（Info Hub 实际展开=true）。
   - 主线程独立复跑：`/tmp/ui-parent-devfix/result.json` revision 3c745a6、exitCode 0，
     `verify.log` 10/10 且 `no_console_errors :: 0 条`。
   - `pnpm typecheck` exit 0；`pnpm check` exit 0（0 errors / 1 warning，warning 在
     `scripts/ui-review/review.mjs:255`，属明确不在范围的 Dev 复核工具）。

## 未验证 / 边界

- 21 脚本全套只在 251ddbb 跑过；3c745a6 只以真实 10 项管理流程 + typecheck + check 复验。
- `/tmp/ui-migration-parent-final/run.json` 的 `status` 仍为 `running`（未收尾的记账字段），
  以 `result.json` 与 `verify.log` 末行为准；非阻塞。
- 未重做全仓审查，未追既有非阻塞项（标题字体、44px 遗漏、壳层回退显示、N+1、草稿生命周期等）。
- Human 体验确认未做，故本次不是最终发布判定。
