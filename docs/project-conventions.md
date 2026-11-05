# 项目开发约定

本文适用于所有项目任务。领域规范按 [AGENTS.md](../AGENTS.md) 的任务入口读取，验证范围按 [验证约定](verification.md)选择。

## 项目阶段与兼容性

本项目处于极早期开发阶段，不做向后兼容。

修改数据结构、契约、路由、标识符或术语时，直接改到目标形态，不保留旧形态的兼容层。不加别名、不写双读双写、不为旧数据补迁移脚本、不留 deprecation 过渡期。同一次改动能在同一轮改完调用方，就全部改完。

数据库已经合并的迁移同样不做兼容处理。迁移文件在本机与验收库里都可重建，需要改表名或列名时直接新增迁移，不为已存在的旧库写兼容分支。共享库的处置按 [P1 开发约定](p1/conventions.md) 的迁移约定执行。

## 页面设计与实现的分工

页面的形状由 Human 决定，不由实现方代为决定。

- 任务涉及新增页面、调整既有页面的信息层级或改变交互时，先给 2 到 3 个可比较的设计方案供 Human 选择，选定之前不进入实现。方案用 Lavish artifact 呈现，形状差异要能被一眼比较，同一批数据、同一套语义色与措辞。
- 选定之后，实现方只负责按选定方案写功能、写测试与做验证。实现中若发现方案本身有事实错误（例如某个状态在方案的数据形状下不可能出现），先报告再改，不擅自改形状。
- 集成结束时由 Human 走一次 [Human review](human-review.md)，看真实页面再给结论。这一步不是可选的收尾动作，是章节完成的判据之一。
- 编排单元里写页面任务的 brief 必须带上选定方案的 artifact 路径与选定结论，不写界面形状的 brief 视为未就绪。

P3 C 的代价就是这个顺序被跳过：brief 只写了「设置页能绑定、能看到来源与占用」，界面形状交给实现方自己决定，页面做完后整体重做了一遍。

## 分支与集成

一个阶段一个集成分支，`main` 只接收验收过的阶段。

- 开启 Px 时从 `main` 建 `integration/p5`。该阶段所有单元从集成分支分叉，完成后 rebase 回集成分支，不直接合 `main`。
- 每个单元边界把 `main` 合回集成分支一次。冲突在单元规模内解决，不攒到阶段结束再一次性处理。
- 阶段完成时先把 `main` 合回集成分支、解决冲突、跑完整 `pnpm verify` 并记录被验 commit，通过后再 merge 进 `main`。`main` 只接收这一步验证过的形态；直接推送被拒绝时走 PR 合并，不改写远端 ref。
- 同时最多开两个集成分支，第三个不开。
- 紧急修复直接进 `main`，并要求所有开着的集成分支当轮同步一次，同步时的冲突处理记进当阶段的决策记录。
- 串行资源由阶段独占，不靠事后排序。迁移编号按阶段分段预留，P5 用 `0020` 到 `0029`，P6 用 `0030` 到 `0039`，只有该阶段的集成 owner 跑 `pnpm db:generate`；共享契约文件同一时刻只允许一个写者，写者登记在当阶段的编排记录里。
- 生成物不手工合并。`src/routeTree.gen.ts`、`dist/`、`.output/` 一律重新生成。

P3 C 与 R1 并行时互相覆盖的正是这些串行资源，`drizzle/meta/_journal.json`、`src/db/schema.ts` 里同一张表的 CHECK 重建、`src/routeTree.gen.ts`，不是普通代码重叠。只加集成分支而不给串行资源定归属，只是把冲突推迟到最后一次合并。

## 工作区隔离

每个写代码的线程从创建起就待在自己的 worktree 里，不在主 checkout 上写。主 checkout 固定停在 `main`，只做集成、评审与 Human review。判断“这个小改动不值得开 worktree”这一步本身就会出错，所以它不交给执行者临时决定。

- 新线程要独立 worktree。环境与 sprout-mio 项目的 `defaultThreadEnvMode` 都已设为 `worktree`，但通过 tool 建线程或委派子代理时它不生效（tool 默认落在项目根目录），必须显式传 `workspaceStrategy: { type: 'worktree' }` 与 `delegate_task(isolation: 'worktree')`。
- 新 worktree 的第一条命令是 `bash scripts/dev/worktree-setup.sh`；它已登记为 T3 项目的 `runOnWorktreeCreate` 脚本，新建 worktree 时自动执行，手动重建环境时也跑它。它装依赖，把 gitignore 掉的本地文件与目录软链到主 checkout（`.env.local`、`AGENTS.local.md`、`.agents/dev-pipeline`、`.pi/`、`orchestrate/`、`.obelisk/memories`、`.sprout-pi-sessions/`、`.sprout-pi-workspaces/`），为这个 worktree 建独立 `data/` 并跑迁移。
  - 软链而不是复制：这些路径只有一份真值，各 worktree 读到的就是主 checkout 的那份。`orchestrate/` 是 200 MB 以上的设计原型与评审证据，复制会拖慢准备并制造两处真值。
  - `.pi/settings.json` 里 `./`、`../` 开头的包源会被改写成绝对路径：pi 解析 project 包时以 `<cwd>/.pi` 为基准、不跟随软链，相对路径在 `.t3/` 下的 worktree 里指向不存在的目录，包内 extension 与 skills 会静默不加载（`pi list` 里该包没有解析出的路径行）。
  - `data/` 是唯一 worktree 独占的路径：只跑迁移、不含主 checkout 的种子数据（种子库尚未纳入流程，页面数据要自己造）。
  - 每一步打印 `linked` / `keep` / `skip`。`skip` 表示主 checkout 里根本没有这个路径，不是脚本漏拷；排查环境问题先看这段输出。
  - 实测：`node_modules` 约 590 MB，已有 pnpm store 时整个准备数秒完成；缺了这些本地文件，执行者会因为环境不全退回主 checkout，隔离就只剩形式。
- git 自己挡住重复分支。同一分支不能在两个 worktree 同时 checkout；`main` 被主 checkout 占着时，任何 worktree 切 `main` 都失败（`fatal: 'main' is already used by worktree at ...`）。写代码的分支因此天然互斥。
- worktree 之间共享一份 `.git`。`git stash`、`git branch -D`、删 tag 会波及所有 worktree，不在 worktree 里做这些操作；分支收尾与删除在主 checkout 上做。
- 一个 worktree 只放一个写者。多个子代理并行写文件时各自开 worktree，共享同一个 checkout 就回到了这次事故。
- worktree 在其分支合入或明确放弃、且没有未提交改动之后才删除，随后 `git worktree prune`。

## 维护项目规范

- `AGENTS.md` 只维护任务触发条件与文档入口。新增规则先确定所属领域，写入对应规范；仅在出现新的任务类别时增加入口。
- 同一规则由一份规范维护，其他文档通过链接引用。迁移规则时删除旧副本，并核对原有约束是否完整保留。
- 通用工程规则放在本文或已有工程约定；前端设计与实现规则分别归入前端设计基线和前端开发约定；验证范围、证据与复跑要求归入验证约定。
- 章节 summary、编排报告和决策记录保存当次事实与证据。可复用的经验沉淀到所属规范，不把当次任务日志或临时例外扩成全局要求。
- 修改规范后核对入口、相对链接和引用它的任务说明，清除冲突表述。规范生效、实现完成、技术验收与 Human 体验确认分别记录。
