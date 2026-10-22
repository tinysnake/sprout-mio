# Sprout Mio

开发编排统一从 [开发总计划](docs/development-plan.md)开始。功能与 UI 专项计划由总计划分派，不单独编排。

## 本机运行

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local   # 填入至少 32 字符的 BETTER_AUTH_SECRET
pnpm setup                   # 创建 data/ 并应用迁移
pnpm dev                     # 开发；生产用 pnpm build && pnpm start
```

首次打开 `/login` 注册即可，没有预置账号；注册会创建默认 Project 与 Amenda 助手。

开发与生产入口都监听全部接口，可用 `127.0.0.1`、局域网 IP 或 VPN 地址打开。`APP_ORIGIN` 是主 origin（如 `http://10.0.0.13:3200`），其他内网 / VPN 地址写进 `APP_TRUSTED_ORIGINS`，主机段可通配：

```bash
APP_ORIGIN=http://10.0.0.13:3200
APP_TRUSTED_ORIGINS=http://10.144.144.*:3200
```

只接受回环与内网网段，公网域名或 `http://*:3200` 会在启动时被拒。绑定全部接口意味着同网段设备可访问该应用，仅适合可信内网。

UI review 预览同样监听全部接口；用 `ui-review` 技能启动，不需要传 URL（默认从登录页开始，应用 origin 取自 `APP_ORIGIN`），详见 [UI review 工作流](docs/ui/review-workflow.md)。

> 独占整机算力，多 Agent 协作，把任务真正做完。

Sprout Mio 是一个多 Agent 协作平台：人类在 Project 里与有稳定人设的 Agent 分身通过 DM / Group 协作，所有工作以 Task 为驱动——提出目标、分配归属、用 checklist 分工、以施工记录交付结果；每个分身都能通过租约独占一台物理 PC（Machine），拿满整机 CPU、内存与磁盘去跑编译、测试、大型项目构建等重计算任务，而不用跟别人抢资源、也不用担心现场被干扰。
