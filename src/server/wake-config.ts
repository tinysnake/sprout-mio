import type { WakeProviderAvailability } from "../contracts/project";

/**
 * 判定器的模型、阈值版本与凭据都是部署配置，浏览器只选 provider。
 * 页面需要先知道"这台部署能不能用某个判定器"，才能决定渲染选项还是说明；
 * 让保存失败再回一个错误码，人类读到的是内部术语而不是现状。
 */
export function wakeProviderAvailabilityFromEnv(): WakeProviderAvailability[] {
  const thresholdVersion = process.env.SPROUT_WAKE_THRESHOLD_VERSION;
  const smallBrainModel = process.env.SPROUT_WAKE_SMALL_BRAIN_MODEL;
  const jevModel = process.env.SPROUT_WAKE_JEV_MODEL;
  const jevKey = process.env.JEV_API_KEY;
  const smallBrainReady = Boolean(smallBrainModel && thresholdVersion);
  const jevConfigured = Boolean(jevModel && thresholdVersion);
  const jevReady = jevConfigured && Boolean(jevKey);
  return [
    {
      provider: "small_brain",
      configured: smallBrainReady,
      available: smallBrainReady,
      unavailableReason: smallBrainReady
        ? null
        : smallBrainModel || thresholdVersion
          ? "provider_unavailable"
          : "missing_model",
    },
    {
      provider: "jev",
      configured: jevConfigured,
      available: jevReady,
      unavailableReason: jevReady ? null : !jevConfigured ? "missing_model" : "missing_credentials",
    },
  ];
}
