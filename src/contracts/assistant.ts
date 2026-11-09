import { z } from "zod";
import type { AgentRunStatus } from "./agent-run";

export const assistantInputContextSchema = z.strictObject({
  runId: z.string(),
  messageId: z.string(),
  serializedText: z.string().max(8192),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AssistantInputContext = z.infer<typeof assistantInputContextSchema>;

export const assistantTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("dm_agent"),
    projectId: z.string(),
    chatId: z.string().optional(),
    agentProfileId: z.string(),
  }),
  z.strictObject({
    kind: z.literal("group_agent"),
    projectId: z.string(),
    chatId: z.string(),
    agentProfileId: z.string(),
  }),
  z.strictObject({ kind: z.literal("group_owner"), projectId: z.string(), chatId: z.string() }),
]);
export type AssistantTarget = z.infer<typeof assistantTargetSchema>;
const observe = z.strictObject({
  projectId: z.string(),
  targetProjectId: z.string().optional(),
  chatId: z.string().optional(),
  runId: z.string().optional(),
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
const propose = z.strictObject({
  projectId: z.string(),
  target: assistantTargetSchema,
  body: z.string().trim().min(1).max(8000),
});
const watch = z.strictObject({
  projectId: z.string(),
  targetProjectId: z.string(),
  chatId: z.string(),
  active: z.boolean().optional(),
  intervalSeconds: z.number().int().min(60).max(86400).optional(),
});
export const ASSISTANT_TOOL_SPEC = {
  sprout_assistant_observe: {
    call: "assistant_observe",
    description:
      "Read bounded factual Projects, effective worker Agents (with agentProfileId even without a DM), Chats, messages and run activity currently visible to the Human. Omit targetProjectId to list Projects, provide it to list workers/Chats. Does not execute work.",
    input: observe,
  },
  sprout_assistant_propose: {
    call: "assistant_propose",
    description:
      "Create an immutable concrete work proposal in this DM. For dm_agent, provide projectId and agentProfileId; chatId is optional and resolves to the Human's canonical DM. Write body as a concise, concrete work instruction, without internal IDs, routing metadata or forwarding commentary. Only the Human can confirm it. No work starts here.",
    input: propose,
  },
  sprout_assistant_watch: {
    call: "assistant_watch",
    description:
      "Watch a Chat in this assistant DM: omit active (or use true) to request Human consent, or update an already authorized interval (integer 60..86400, default 300). Reports combine the window's messages and work activity, never notify per run. Use active:false to STOP the current Human's watch of that target in this DM immediately, including pending intents; stopping needs no new consent, is idempotent, and does not cancel work. Only a fresh native Human confirmation can re-enable a stopped watch.",
    input: watch,
  },
} as const;
export const assistantCallSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("assistant_observe"), input: observe }),
  z.strictObject({ type: z.literal("assistant_propose"), input: propose }),
  z.strictObject({ type: z.literal("assistant_watch"), input: watch }),
]);
export type AssistantCall = z.infer<typeof assistantCallSchema>;
export type AssistantNativeSource =
  | { kind: "assistant_event"; eventId: string }
  | { kind: "assistant_work"; proposalId: string };
export type AssistantFact = {
  kind: "decision" | "periodic" | "completed" | "intervention";
  targetProjectId: string;
  targetChatId: string;
  runId?: string;
  proposalId?: string;
  watchIntent?: boolean;
  watchId?: string;
  digest?: {
    windowStartedAt: string;
    windowEndedAt: string;
    messageIds: string[];
    runIds: string[];
    truncated: boolean;
  };
  intervalSeconds?: number;
  runState?: { status: AgentRunStatus; elapsedSeconds: number };
  action?: { label: string; elapsedSeconds?: number };
  body: string;
  sampledAt: string;
};
