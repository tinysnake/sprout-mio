import { z } from "zod";
import {
  turnContextSubmittedEventSchema,
  type TurnContextPromptInput,
} from "../../contracts/turn-context";
import type { InfoHubHint } from "../../contracts/info-hub-hint";
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
  /**
   * 是否让宿主 skills 与 prompt templates 进入分身的 resource loader。
   * 默认（缺省或 false）与 P3 相同：只加载 Sprout extension 与四个基础工具。
   */
  inheritHostResources?: boolean;
  profile: RunConfigSnapshot["profile"];
  remote: RemoteToolGrant;
};
export type PiHostCommand =
  | OpenSession
  | {
      type: "prompt";
      id: string;
      messageId: string;
      text: string;
      turnContext: TurnContextPromptInput;
    }
  | { type: "info_hub_hint"; id: string; hint: InfoHubHint }
  | { type: "steer"; id: string; messageId: string; text: string }
  | { type: "abort" | "close"; id: string };

const snapshotSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  thinking: z.string().min(1),
  tools: z.array(z.string()),
  // registry 里注册的工具；`tools` 是真正声明给模型的那一份。旧快照没有，可选。
  registeredTools: z.array(z.string()).optional(),
  extensions: z.array(z.string()),
  // 继承边界的实测结果（runner 从 loader 自己读出）。旧快照没有这一段，所以可选。
  resources: z
    .object({
      inheritHostResources: z.boolean(),
      agentDir: z.string().min(1),
      hostAgentDir: z.string().min(1),
      skillPaths: z.array(z.string()),
      promptPaths: z.array(z.string()),
      skills: z.array(z.string()),
      prompts: z.array(z.string()),
      themes: z.array(z.string()),
      contextFiles: z.array(z.string()),
      systemPromptChars: z.number().int().nonnegative(),
    })
    .optional(),
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
  turnContextSubmittedEventSchema.extend({ id: z.string() }),
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
