import { z } from "zod";
import type { RunConfigSnapshot } from "../../contracts/agent-run";
import type { RemoteToolGrant } from "../../contracts/remote";

export type OpenSession = {
  type: "open";
  id: string;
  instanceId: string;
  sessionId: string;
  sessionFile?: string;
  sessionDirectory: string;
  cwd: string;
  agentDir: string;
  extensionPath: string;
  profile: RunConfigSnapshot["profile"];
  remote: RemoteToolGrant;
};
export type PiHostCommand =
  | OpenSession
  | { type: "prompt"; id: string; messageId: string; text: string }
  | { type: "steer"; id: string; messageId: string; text: string }
  | { type: "abort" | "close"; id: string };

const snapshotSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  thinking: z.string().min(1),
  tools: z.array(z.string()),
  extensions: z.array(z.string()),
  sessionId: z.string().min(1),
  sessionFile: z.string().min(1),
  cwd: z.string().min(1),
  sdkVersion: z.string().min(1),
  profile: z.object({
    id: z.string(),
    name: z.string(),
    persona: z.string(),
    harness: z.literal("pi"),
    model: z.string().optional(),
    effort: z.string().optional(),
    updatedAt: z.string(),
  }),
});

export const piHostEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    id: z.string(),
    kind: z.enum(["text_delta", "tool_start", "tool_end"]),
    text: z.string().optional(),
    toolName: z.string().optional(),
  }),
  z.object({ type: z.literal("ready"), id: z.string(), snapshot: snapshotSchema }),
  z.object({ type: z.literal("input_delivered"), id: z.string(), messageId: z.string() }),
  z.object({
    type: z.literal("input_rejected"),
    id: z.string(),
    messageId: z.string(),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("settled"),
    id: z.string(),
    text: z.string().max(8000),
    stopReason: z.string(),
  }),
  z.object({
    type: z.literal("failure"),
    id: z.string(),
    code: z.string().max(100),
    message: z.string().max(500),
    stopReason: z.string().optional(),
  }),
]);
export type PiHostEvent = z.infer<typeof piHostEvent>;
