type SproutPiApi = {
  on: (event: "session_start", handler: () => void) => void;
  appendEntry: (customType: string, data: unknown) => void;
};

export default function sproutExtension(pi: SproutPiApi): void {
  pi.on("session_start", () => {
    pi.appendEntry("sprout-session-binding", { version: 1 });
  });
}
