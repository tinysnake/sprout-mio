/**
 * 消息里图片的显示宽度。比例永远是原始的，这里只决定横向占多宽：
 * 小图最多放大到 200%（免得一个 16 像素的图被拉满整列），宽图收进正文列，
 * 再高的图按视口高度上限回缩。宽度交给 <img> 的 width，高度由浏览器按原始比例算。
 */
export const ATTACHMENT_MAX_UPSCALE = 2;

/** 图片高度最多占视口的这个比例，超过就继续缩小宽度。 */
export const ATTACHMENT_MAX_HEIGHT_RATIO = 0.6;

export function attachmentDisplayWidth(
  naturalWidth: number,
  naturalHeight: number,
  containerWidth: number,
  maxHeight: number,
): number {
  const available = Math.max(1, containerWidth);
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return Math.floor(available);
  const bounded = Math.min(naturalWidth * ATTACHMENT_MAX_UPSCALE, available);
  const height = (bounded * naturalHeight) / naturalWidth;
  if (!(maxHeight > 0) || height <= maxHeight) return bounded;
  return (maxHeight * naturalWidth) / naturalHeight;
}
