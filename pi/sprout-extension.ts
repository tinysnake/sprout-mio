type ProviderHeaders = Record<string, string | null>;

type SproutPiApi = {
  on: {
    (event: "session_start", handler: () => void): void;
    (
      event: "before_provider_headers",
      handler: (
        event: { headers: ProviderHeaders },
        ctx: { sessionManager: { getSessionId(): string } },
      ) => void,
    ): void;
  };
  appendEntry: (customType: string, data: unknown) => void;
};

/** 与 src/contracts/version.ts 的 APP_VERSION 保持一致；扩展入口保持无相对导入。 */
const USER_AGENT = "sprout-mio/0.1.0";

function setHeader(headers: ProviderHeaders, name: string, value: string): void {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) delete headers[key];
  headers[name] = value;
}

export default function sproutExtension(pi: SproutPiApi): void {
  pi.on("before_provider_headers", (event, ctx) => {
    setHeader(event.headers, "user-agent", USER_AGENT);
    setHeader(event.headers, "x-session-affinity", ctx.sessionManager.getSessionId());
  });
  pi.on("session_start", () => {
    pi.appendEntry("sprout-session-binding", { version: 1 });
  });
}
