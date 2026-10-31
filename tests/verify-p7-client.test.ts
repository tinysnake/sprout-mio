import { afterEach, expect, it, vi } from "vite-plus/test";
import { safeReturnTarget } from "../src/lib/return-target";
import {
  createInfoHubPolling,
  InfoHubAccessError,
} from "../src/components/info-hub/use-info-hub-polling";
import { unwrapRefreshResult } from "../src/components/info-hub/info-hub-live";

it("retains application targets and rejects external, ambiguous and recursive destinations", () => {
  const target = "/projects/prj_123/chats/cnv_123?info=1#execution";
  expect(safeReturnTarget(target)).toBe(target);
  for (const value of [
    undefined,
    {},
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/ /evil",
    "/login?next=/login",
    "/api/auth/logout",
    "javascript:alert(1)",
  ])
    expect(safeReturnTarget(value)).toBe("/");
});
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});
it.each(["unauthorized", "forbidden", "not_found"] as const)(
  "keeps %s distinct from a transient refresh error and resumes with fresh facts",
  async (code) => {
    vi.useFakeTimers();
    const environment = {
      document: Object.assign(new EventTarget(), { visibilityState: "visible" as const }),
      navigator: { onLine: true },
      window: new EventTarget(),
    };
    const error = {
      ok: false as const,
      requestId: "req_p7",
      error: { code, message: code, requestId: "req_p7" },
    };
    await expect(unwrapRefreshResult(Promise.resolve(error))).rejects.toThrow(InfoHubAccessError);
    const states: string[] = [];
    let invalid = true;
    const facts = {
      kind: "unchanged" as const,
      projectId: "prj_11111111-1111-4111-8111-111111111111",
      revision: "r2",
      asOf: "2026-07-01T00:00:00Z",
      query: { view: "project" as const, section: "agents" as const, limit: 25 },
    };
    const refresh = vi.fn(async () => {
      if (invalid) return unwrapRefreshResult(Promise.resolve(error));
      return facts;
    });
    const onResult = vi.fn();
    stop = createInfoHubPolling({
      environment,
      input: { projectId: facts.projectId, query: facts.query },
      refresh,
      onState: (state) => states.push(state),
      onResult,
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(states.at(-1)).toBe(code);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
    invalid = false;
    environment.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledWith(facts);
    expect(states.at(-1)).toBe("current");
  },
);
