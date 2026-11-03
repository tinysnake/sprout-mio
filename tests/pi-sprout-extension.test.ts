import { describe, expect, it } from "vite-plus/test";
import sproutExtension from "../pi/sprout-extension";

type HeaderHandler = (
  event: { headers: Record<string, string | null> },
  ctx: { sessionManager: { getSessionId(): string } },
) => void;

describe("sprout pi extension 的网关身份", () => {
  it("覆盖 pi 的 UA 并写入实例 session", () => {
    let handler: HeaderHandler | undefined;
    const pi = {
      on(event: string, next: unknown) {
        if (event === "before_provider_headers") handler = next as HeaderHandler;
      },
      appendEntry() {},
    };
    sproutExtension(pi as never);
    const headers: Record<string, string | null> = { "User-Agent": "pi/1.4.0" };
    handler!({ headers }, { sessionManager: { getSessionId: () => "ins_test1234" } });
    expect(headers["User-Agent"]).toBeUndefined();
    expect(headers["user-agent"]).toBe("sprout-mio/0.1.0");
    expect(headers["x-session-affinity"]).toBe("ins_test1234");
  });
});
