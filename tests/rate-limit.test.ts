import { describe, expect, it } from "vite-plus/test";
import { consumeSlidingWindow, createSlidingWindowLimiter } from "../src/server/rate-limit";

describe("内存滑动窗口限流", () => {
  it("允许 max 次，拒绝额外尝试且拒绝不延长窗口，到期恢复", () => {
    let now = 0;
    const consume = createSlidingWindowLimiter({ max: 2, windowMs: 1000, now: () => now });
    expect(consume("account")).toEqual({ allowed: true, retryAfterMs: 0 });
    now = 500;
    expect(consume("account").allowed).toBe(true);
    now = 999;
    expect(consume("account")).toEqual({ allowed: false, retryAfterMs: 1 });
    now = 1000;
    expect(consume("account").allowed).toBe(true);
    now = 1001;
    expect(consume("account")).toEqual({ allowed: false, retryAfterMs: 499 });
    now = 2000;
    expect(consume("account").allowed).toBe(true);
  });

  it("清理所有过期 key，容量满时拒绝新 key 而不驱逐活跃账号预算", () => {
    const policy = { max: 1, windowMs: 1000, maxKeys: 2 };
    const first = consumeSlidingWindow(new Map(), "target", policy, 0);
    const second = consumeSlidingWindow(first.state, "other", policy, 100);
    const overflow = consumeSlidingWindow(second.state, "new", policy, 200);
    expect(overflow.decision).toEqual({ allowed: false, retryAfterMs: 800 });
    expect(overflow.state.size).toBe(2);
    expect(consumeSlidingWindow(overflow.state, "target", policy, 200).decision.allowed).toBe(
      false,
    );
    const recovered = consumeSlidingWindow(overflow.state, "new", policy, 1100);
    expect(recovered.decision.allowed).toBe(true);
    expect([...recovered.state.keys()]).toEqual(["new"]);
    expect([...first.state]).toEqual([["target", [0]]]);
  });

  it("不同 key 独立，时钟回拨不会缩短已消耗的窗口", () => {
    let now = 1000;
    const consume = createSlidingWindowLimiter({ max: 1, windowMs: 1000, now: () => now });
    expect(consume("target").allowed).toBe(true);
    expect(consume("other").allowed).toBe(true);
    now = 500;
    expect(consume("target")).toEqual({ allowed: false, retryAfterMs: 1000 });
    now = 2000;
    expect(consume("target").allowed).toBe(true);
  });
});
