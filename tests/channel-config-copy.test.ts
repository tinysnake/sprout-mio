import { expect, it } from "vite-plus/test";
import type { ChannelConfigView } from "../src/contracts/channel";
import {
  FEISHU_SECRET_EMPTY_HINT,
  FEISHU_SECRET_KEPT_HINT,
  channelConfigDraft,
  channelConfigFailureText,
  channelConfigSaveInput,
  channelConfigStatusLabel,
} from "../src/components/project/channel-config-copy";
import type { AppError } from "../src/contracts/result";

const view: ChannelConfigView = {
  projectId: "prj_1",
  kind: "feishu",
  enabled: true,
  settings: { origin: "https://open.feishu.cn", appId: "cli_0123456789abcdef" },
  hasAppSecret: true,
  configured: true,
  revision: 3,
  updatedAtMs: 1_700_000_000_000,
  updatedByHumanId: "hum_1",
};

it("starts the draft from the stored settings without the secret", () => {
  expect(channelConfigDraft(view)).toEqual({
    enabled: true,
    origin: "https://open.feishu.cn",
    appId: "cli_0123456789abcdef",
    appSecret: "",
  });
});

it("omits the secret when the field was left blank so the stored one survives", () => {
  const input = channelConfigSaveInput(
    "prj_1",
    { ...channelConfigDraft(view), appSecret: "  " },
    view,
  );
  expect(input).toEqual({
    projectId: "prj_1",
    kind: "feishu",
    enabled: true,
    settings: { origin: "https://open.feishu.cn", appId: "cli_0123456789abcdef" },
    revision: 3,
  });
});

it("sends a typed secret together with the revision it was read at", () => {
  const input = channelConfigSaveInput(
    "prj_1",
    {
      enabled: false,
      origin: " https://open.larksuite.com ",
      appId: " cli_0123456789abcdef ",
      appSecret: " s3cret ",
    },
    view,
  );
  expect(input).toEqual({
    projectId: "prj_1",
    kind: "feishu",
    enabled: false,
    settings: { origin: "https://open.larksuite.com", appId: "cli_0123456789abcdef" },
    appSecret: "s3cret",
    revision: 3,
  });
});

it("labels the three configurable states", () => {
  expect(channelConfigStatusLabel({ ...view, configured: false, enabled: false })).toBe("未配置");
  expect(channelConfigStatusLabel(view)).toBe("已启用");
  expect(channelConfigStatusLabel({ ...view, enabled: false })).toBe("已停用");
});

it("keeps the server message for a conflict and explains who may edit", () => {
  const conflict: AppError = {
    code: "conflict",
    message: "渠道配置已变化",
    requestId: "req_1",
  };
  expect(channelConfigFailureText(conflict)).toBe("渠道配置已变化，请按最新配置重试。");
  expect(
    channelConfigFailureText({
      code: "forbidden",
      message: "只有 Human 可以管理渠道配置",
      requestId: "req_2",
    }),
  ).toBe("只有 Human 可以修改渠道配置。");
  expect(
    channelConfigFailureText({
      code: "validation_failed",
      message: "App ID 格式不正确",
      requestId: "req_3",
    }),
  ).toBe("App ID 格式不正确");
});

it("tells the Human how a blank secret is treated", () => {
  expect(FEISHU_SECRET_KEPT_HINT).toContain("留空");
  expect(FEISHU_SECRET_EMPTY_HINT).toContain("不会回显");
});
