# I-P1/P2 视觉读图记录（主线程）

状态：主线程已实际读图 7 张。**这不是 Human 体验确认**，Human 确认仍待。特别说明：本次未声明这 7 张截图视觉通过，只记录可指认的画面观察。

## 清单

前 4 张为此前轮次已读，后 3 张为本轮读图。

| #   | 文件                                      | 轮次 | 可证观察                                                                                        |
| --- | ----------------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| 1   | `regression-layout-light-901.png`         | 前轮 | 901px 下分栏可见：列表、Chat 与右侧 Info Hub 同时存在，侧栏为图标窄栏                           |
| 2   | `regression-layout-dark-1440.png`         | 前轮 | 1440px 暗色下右侧 inspector 的事实区正常呈现，Chat ID、分身 Instance ID、成员与运行事实分区可读 |
| 3   | `regression-layout-light-390.png`         | 前轮 | 390px 下为手机单栏，inspector 与返回入口可见                                                    |
| 4   | `regression-p3-b-run-running-pending.png` | 前轮 | P3 运行态事实：运行中/排队中标识与「1 条输入未投递」同时出现                                    |
| 5   | `final-real-settings-1440-light.png`      | 本轮 | Settings 分区顺序为基本信息、基本事实、协作配置；事实区展示 Project ID、创建时间、requestId     |
| 6   | `final-login-390-dark.png`                | 本轮 | 390px 暗色登录页无横向裁切，表单与品牌区完整落在视口内                                          |
| 7   | `final-gallery-390-dialog-dark.png`       | 本轮 | 390px Dialog 左右各留 16px，取消与确认按钮同一行                                                |

## 边界

- 上述是读图观察，不是逐像素比对，也不是视觉验收结论。
- 未读的图片不代表已看过。
- Human 的键盘操作与物理拖动体验仍待确认。
