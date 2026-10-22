# OpenDesign P1/P2 原型归档

这是停止依赖 OpenDesign 前保存的源码快照，用于 UI 基础与 P1/P2 迁移对照。当前设计规则见 [前端设计基线](../../../docs/frontend-design.md)，实现方式见 [前端开发约定](../../../docs/frontend-conventions.md)。正式应用不导入本目录，后续组件在 `src/` 开发。

`source.tar.gz` 包含原型的 `src/`、`scripts/`、`tests/`、`package.json`、`package-lock.json`，以及不会由构建生成的手写手机外壳 `sprout-mobile.html`；不包含 node_modules、其余生成 HTML、字体二进制或 OpenDesign 版本数据库。`manifest.json` 保存归档时点、仓库基线、源项目 ID、压缩包及每个文件的 SHA-256，供完整性核对。归档不会随 `src/theme.css` 改动更新，其中的 tokens.css 只是当时的快照。

保存压缩源码是为了冻结参考并避免把原型第二套 JSX / CSS 加入正式应用的构建、格式化和依赖范围；需要查源码时在临时目录解包阅读。

## 独立复现

在仓库根目录运行，依赖安装需要可用的 npm registry 或本机缓存；不需要安装或打开 OpenDesign：

```bash
snapshot_dir=$(mktemp -d /tmp/sprout-ui-reference.XXXXXX)
tar -xzf design/archive/opendesign-p1p2/source.tar.gz -C "$snapshot_dir"
cd "$snapshot_dir"
npm ci
npm run build
npm test
npm start
```

默认预览地址为 `http://127.0.0.1:4173/`，端口占用时使用 `PORT=4174 npm start`。构建会生成 index、工作区、登录和组件页。原型使用 hash URL、固定数据与临时状态，不连接真实服务。

## 本次归档验证

已在新建临时目录解包，核对 16 个文件的 SHA-256 后执行 `npm ci --no-audit --no-fund`、`npm run build`、`npm test`，全部退出 0，测试 56/56 通过。验证使用归档的依赖锁独立安装，不复用 OpenDesign 的 node_modules，也不需要 OpenDesign 服务。本次没有重新做视觉验收或真实业务集成验收。

## 使用边界

- 只从中提取与当前设计基线一致的布局、交互和状态，不把原型当业务契约。
- 保留其历史状态，不在压缩包里继续修产品。原型遗留问题应在迁移记录里说明，并在正式组件中处理。
- `cursor-tokens.css` 保留了模板字体和营销说明，组件目录也列有额外色板；这些不属于 Mio 设计规范。正式字体、颜色与组件以仓库设计基线为准。
- 历史 `scripts/check.mjs` 仍按旧的 app.css token 结构读取，而且检查了当前构建不会生成的 mobile HTML；它不在 package scripts 中，不能用作新的验收门禁。迁移后使用真实浏览器与正式组件验证。
- 既有原型测试只证明原型行为；不得以其通过替代正式路由、真实保存、授权或消息持久性验收。
- 截图和 Human 确认按章节交付记录补齐。此归档不宣称原型或迁移已经验收完成。
