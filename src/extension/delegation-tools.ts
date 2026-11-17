import { remoteAgentRequestSchema } from "../contracts/remote";
import type { RemoteAgentRequest } from "../contracts/remote";
import { delegationToolInputSchemas, type DelegationToolName } from "../contracts/delegation";
import { objectToolParameters } from "./tool-parameters";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

const actions = {
  sprout_delegation_complete: "complete",
  sprout_delegation_block: "block",
} as const;

const descriptions: Record<DelegationToolName, string> = {
  sprout_delegation_complete:
    "Report this delegation finished. The result reaches the Crew lead as a durable event; it never posts into the Crew timeline. Give a short summary and, for reports longer than 200 characters, an HTML artifact.",
  sprout_delegation_block:
    "Report this delegation blocked. Use needs_input for a decision needing Human 或 Crew lead, resource_unavailable when the Machine or workspace is missing, out_of_scope when the request cannot be done as stated, failed when the attempt did not succeed. The lead resumes with this event.",
};

function buildRequest(
  name: DelegationToolName,
  raw: unknown,
  projectId: string,
): RemoteAgentRequest {
  const input = { ...delegationToolInputSchemas[name].parse(raw), projectId };
  return remoteAgentRequestSchema.parse({
    version: 2,
    call: { type: "delegation_mutate", input: { ...input, action: actions[name] } },
  });
}

function result(response: RemoteToolResponse): SproutToolResult {
  const details = response.outcome === "response" ? response.result : response;
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: response.outcome !== "response" || !response.result.ok,
  };
}

export function registerDelegationTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
): void {
  for (const name of Object.keys(delegationToolInputSchemas) as DelegationToolName[]) {
    pi.registerTool({
      name,
      label: name,
      description:
        descriptions[name] +
        " rejected=服务端明确拒绝，读 status/error.code/error.message 后先解决原因，不要盲目重试；无法继续时用 sprout_delegation_block 报告原因。",
      parameters: objectToolParameters(delegationToolInputSchemas[name]),
      async execute(_toolCallId, parameters, signal) {
        let request: RemoteAgentRequest;
        try {
          request = buildRequest(name, parameters, client.projectId);
        } catch {
          return result({
            outcome: "response",
            result: {
              ok: false,
              requestId: "delegation-tool-validation",
              error: {
                code: "validation_failed",
                message: "Invalid delegation parameters; identity and scope come from the grant.",
                requestId: "delegation-tool-validation",
              },
            },
          });
        }
        try {
          return result(await client.request(request, signal));
        } catch {
          return result({ outcome: "unknown", reason: "transport_error" });
        }
      },
    });
  }
}
