/**
 * Minimal Sprout probe extension.
 *
 * Proves three registration surfaces load in a real Pi process:
 * - registerTool: a model-callable tool `sprout_probe_ping`
 * - registerCommand: `/sprout-probe`
 * - on("session_start"): a startup landmark appended to the session
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROBE_MARKER = "SPROUT_EXTENSION_LOADED";

export default function sproutProbe(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sprout_probe_ping",
    label: "Sprout Probe Ping",
    description:
      "Returns the Sprout probe marker. Call this whenever the user asks to ping the Sprout probe.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as never,
    async execute() {
      return {
        content: [{ type: "text" as const, text: PROBE_MARKER }],
        details: { marker: PROBE_MARKER },
      };
    },
  });

  pi.registerCommand("sprout-probe", {
    description: "Sprout probe command",
    handler: async (_args, ctx) => {
      ctx.ui.notify(PROBE_MARKER, "info");
    },
  });

  pi.on("session_start", async () => {
    pi.appendEntry("sprout-probe-session-start", { marker: PROBE_MARKER });
  });
}
