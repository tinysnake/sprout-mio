# I-P1/P2 视觉读图记录（主线程）

状态：主线程已实际读图 7 张，未发现阻塞视觉问题。**这不是 Human 体验确认**，Human 确认仍待。

## 范围与来源

- 图片全部来自本目录，属本轮 `final-*` 系列（fixture 图对应 `251ddbb` / src `e61c23a`，真实业务图对应修复后 `c1fd6ba` / src `bf64431`）。
- 清单沿用覆盖各主要页面的 7 张本轮截图。若与主线程实际查看的文件有出入，以主线程复核为准；本表不声称逐像素比对。
- 读图结论只覆盖画面本身。断点数值、触控尺寸与行为断言以浏览器检查为准，不在此重复。

## 7 张

| # | 文件 | 场景 / 主题 / 视口 | 读图要点 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `final-gallery-1440-light.png` | 共享组件 gallery / 浅色 / 1440x900 | 标题与正文为 Geist，层级清楚；Button 变体、Field 说明与错误样式一致；无横向溢出 | 通过 |
| 2 | `final-gallery-390-dialog-dark.png` | gallery Dialog / 暗色 / 390x844 | Dialog 留在视口内，动作区单行右对齐，遮罩与背景层次可辨 | 通过 |
| 3 | `final-login-1440-light.png` | 登录 / 浅色 / 1440x900 | 表单居中、单一主操作，标签与输入框关联清楚 | 通过 |
| 4 | `final-agents-390-dark.png` | Agents / 暗色 / 390x844 | 列表行触控高度足够，移动底栏可达，无内容截断 | 通过 |
| 5 | `final-real-settings-1440-light.png` | 真实 Project settings / 浅色 / 1440x1000 | 侧栏 200px，标题区两层缩进；基本事实 ID、创建时间、requestId 可读 | 通过 |
| 6 | `final-real-settings-info-hub-1440-light.png` | 真实 Settings 展开「关联信息」/ 浅色 / 1440x1000 | 协作配置、仓库工作副本、Info Hub 分区顺序正确，无重叠或遮挡 | 通过 |
| 7 | `final-chat-1440-light.png` | Chat 三栏 + Info Hub inspector / 浅色 / 1440x900 | 列表、消息、输入区与右侧 inspector 并存，返回与状态入口可见 | 通过 |

## 边界

- 未读的图片不代表已看过，也不因存在于目录中而从证据升级为视觉结论。
- 深色真实业务页、多 Project 列表态与 P3 运行态截图在本轮读图范围内未逐张确认，若有需要由主线程补看。
