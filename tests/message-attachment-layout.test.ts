import { describe, expect, it } from "vite-plus/test";
import {
  ATTACHMENT_MAX_UPSCALE,
  attachmentDisplayWidth,
  attachmentViewerFitScale,
} from "../src/components/chat/message-attachment-layout";

describe("附件图片的显示宽度", () => {
  it("宽图收进正文列，高度按原始比例跟着缩", () => {
    const width = attachmentDisplayWidth(3000, 1500, 720, 540);
    expect(width).toBe(720);
    expect((width * 1500) / 3000).toBe(360);
  });

  it("小图最多放大到 200%，不会被拉满整列", () => {
    const width = attachmentDisplayWidth(120, 80, 720, 540);
    expect(width).toBe(120 * ATTACHMENT_MAX_UPSCALE);
    expect(width).toBe(240);
  });

  it("容器比小图还窄时按容器收，不放大", () => {
    expect(attachmentDisplayWidth(120, 80, 60, 540)).toBe(60);
  });

  it("很高的图受视口高度上限约束，比例仍然不变", () => {
    const width = attachmentDisplayWidth(400, 3000, 720, 540);
    expect(width).toBe((540 * 400) / 3000);
    expect((width * 3000) / 400).toBeCloseTo(540, 6);
  });

  it("原始尺寸未知时退回容器宽度", () => {
    expect(attachmentDisplayWidth(0, 0, 512, 540)).toBe(512);
    expect(attachmentDisplayWidth(100, 0, 512, 540)).toBe(512);
  });

  it("容器宽度为 0 时仍然给出可渲染的宽度", () => {
    expect(attachmentDisplayWidth(3000, 1500, 0, 540)).toBe(1);
    expect(attachmentDisplayWidth(0, 0, 0, 540)).toBe(1);
  });

  it("任何尺寸下高度都不超过上限", () => {
    const cases: readonly (readonly [number, number])[] = [
      [3000, 1500],
      [120, 80],
      [400, 3000],
      [2000, 4000],
      [1, 1],
    ];
    for (const [naturalWidth, naturalHeight] of cases) {
      const width = attachmentDisplayWidth(naturalWidth, naturalHeight, 720, 540);
      const height = (width * naturalHeight) / naturalWidth;
      expect(height).toBeLessThanOrEqual(540);
      expect(width).toBeLessThanOrEqual(720);
    }
  });
});

describe("大图窗口打开时的比例", () => {
  const box = { width: 1200, height: 800 };

  it("超出窗口的图整张落进窗口，比例不变", () => {
    const scale = attachmentViewerFitScale(3000, 2000, box.width, box.height);
    expect(scale).toBe(0.4);
    expect(3000 * scale).toBeLessThanOrEqual(box.width);
    expect(2000 * scale).toBeLessThanOrEqual(box.height);
  });

  it("很长的图受窗口高度限制，第一眼就能看全", () => {
    const scale = attachmentViewerFitScale(300, 900, box.width, box.height);
    expect(scale).toBeCloseTo(800 / 900, 6);
    expect(900 * scale).toBeLessThanOrEqual(box.height);
  });

  it("很宽的图受窗口宽度限制", () => {
    const scale = attachmentViewerFitScale(4000, 500, box.width, box.height);
    expect(scale).toBe(1200 / 4000);
    expect(4000 * scale).toBeLessThanOrEqual(box.width);
  });

  it("小图最多放大到 200%", () => {
    expect(attachmentViewerFitScale(48, 24, box.width, box.height)).toBe(ATTACHMENT_MAX_UPSCALE);
  });

  it("尺寸未量到时回退 1", () => {
    expect(attachmentViewerFitScale(0, 0, box.width, box.height)).toBe(1);
    expect(attachmentViewerFitScale(800, 600, 0, 0)).toBe(1);
  });

  it("任何图片尺寸下都看得全且不小于下限", () => {
    const cases: readonly (readonly [number, number])[] = [
      [3000, 2000],
      [48, 24],
      [300, 900],
      [4000, 500],
      [20000, 30000],
    ];
    for (const [naturalWidth, naturalHeight] of cases) {
      const scale = attachmentViewerFitScale(naturalWidth, naturalHeight, box.width, box.height);
      expect(scale).toBeGreaterThanOrEqual(0.02);
      expect(naturalWidth * scale).toBeLessThanOrEqual(box.width + 0.001);
      expect(naturalHeight * scale).toBeLessThanOrEqual(box.height + 0.001);
    }
  });
});
