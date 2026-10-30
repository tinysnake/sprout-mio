import { z } from "zod";
import { remoteAgentRequestSchema } from "../contracts/remote";
import type { RemoteAgentRequest } from "../contracts/remote";
import { taskToolInputSchemas } from "../contracts/task";
import { readTaskChatResponse } from "./remote-client";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

type ToolName = keyof typeof taskToolInputSchemas;
const actions = {
  sprout_task_update: "update",
  sprout_task_checklist_add: "checklist_add",
  sprout_task_checklist_update: "checklist_update",
  sprout_task_checklist_remove: "checklist_remove",
  sprout_task_record_append: "record_append",
  sprout_task_complete: "complete",
  sprout_task_cancel: "cancel",
} as const;
const descriptions: Record<ToolName, string> = {
  sprout_task_list: "List Tasks in this run's current Chat.",
  sprout_task_get: "Read a Task visible from this run's current Chat.",
  sprout_task_update: "Update Task metadata using its expectedRevision.",
  sprout_task_checklist_add: "Add a Task checklist item using expectedRevision.",
  sprout_task_checklist_update: "Update a Task checklist item using expectedRevision.",
  sprout_task_checklist_remove: "Remove a Task checklist item using expectedRevision.",
  sprout_task_record_append: "Append a progress record as this run's Agent.",
  sprout_task_complete: "Finish a Task, optionally appending its final progress record.",
  sprout_task_cancel: "Cancel a Task when this Agent has permission.",
  sprout_chat_get: "Read this run's current Chat and messages.",
  sprout_chat_send: "Send a message as this run's Agent in its current Chat.",
};

function buildRequest(name: ToolName, raw: unknown, projectId: string): RemoteAgentRequest {
  const input = { ...taskToolInputSchemas[name].parse(raw), projectId };
  let call: unknown;
  switch (name) {
    case "sprout_task_get":
      call = { type: "task_get", input };
      break;
    case "sprout_task_list":
      call = { type: "task_list", input };
      break;
    case "sprout_chat_get":
      call = { type: "chat_get", input };
      break;
    case "sprout_chat_send":
      call = { type: "chat_send", input };
      break;
    default:
      call = { type: "task_mutate", input: { ...input, action: actions[name] } };
  }
  return remoteAgentRequestSchema.parse({ version: 2, call });
}
function result(response: RemoteToolResponse): SproutToolResult {
  const details = response.outcome === "response" ? response.result : response;
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: response.outcome !== "response" || !response.result.ok,
  };
}
export function registerTaskTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
): void {
  for (const name of Object.keys(taskToolInputSchemas) as ToolName[]) {
    pi.registerTool({
      name,
      label: name,
      description: descriptions[name],
      parameters: z.toJSONSchema(taskToolInputSchemas[name], { target: "draft-7", io: "input" }),
      async execute(_toolCallId, parameters, signal) {
        let request: RemoteAgentRequest;
        try {
          request = buildRequest(name, parameters, client.projectId);
        } catch {
          return result({
            outcome: "response",
            result: {
              ok: false,
              requestId: "task-tool-validation",
              error: {
                code: "validation_failed",
                message:
                  "Invalid Task/Chat parameters; execution identity and scope come from the grant.",
                requestId: "task-tool-validation",
              },
            },
          });
        }
        try {
          const response = await client.request(request, signal);
          if (response.outcome === "response" && response.result.ok) {
            return result(
              readTaskChatResponse(response.result, request) ?? {
                outcome: "unknown",
                reason: "invalid_response",
              },
            );
          }
          return result(response);
        } catch {
          return result({ outcome: "unknown", reason: "transport_error" });
        }
      },
    });
  }
}
