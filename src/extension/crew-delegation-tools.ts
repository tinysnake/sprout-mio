import { randomUUID } from "node:crypto";
import { crewDelegationToolInputSchemas } from "../contracts/delegation";
import type { CrewDelegationToolName } from "../contracts/delegation";
import { remoteAgentRequestSchema } from "../contracts/remote";
import type { RemoteAgentRequest } from "../contracts/remote";
import { objectToolParameters } from "./tool-parameters";
import type { RemoteToolClient, RemoteToolResponse } from "./remote-client";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

const actions = {
  sprout_delegation_start: "dispatch",
  sprout_delegation_input: "input",
  sprout_delegation_cancel: "cancel",
  sprout_delegation_list: "list",
} as const;

const descriptions: Record<CrewDelegationToolName, string> = {
  sprout_delegation_start:
    "Delegate one piece of work from this Crew to an Agent member. Returns immediately with a child chat; the result arrives as a durable event. Use clientRequestId to make retries idempotent.",
  sprout_delegation_input:
    "Send an additional instruction to a running delegation. It is delivered to the worker run without posting into the Crew timeline.",
  sprout_delegation_cancel: "Cancel one delegation of this Crew and stop its worker run.",
  sprout_delegation_list: "List this Crew's delegations and their latest events.",
};

function buildRequest(
  name: CrewDelegationToolName,
  raw: unknown,
  projectId: string,
): RemoteAgentRequest {
  const input = {
    ...crewDelegationToolInputSchemas[name].parse(raw),
    projectId,
  } as Record<string, unknown>;
  if (name === "sprout_delegation_start" && !input.clientRequestId)
    input.clientRequestId = randomUUID();
  return remoteAgentRequestSchema.parse({
    version: 2,
    call: { type: "crew_mutate", input: { ...input, action: actions[name] } },
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

export function registerCrewDelegationTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
): void {
  for (const name of Object.keys(crewDelegationToolInputSchemas) as CrewDelegationToolName[]) {
    pi.registerTool({
      name,
      label: name,
      description: descriptions[name],
      parameters: objectToolParameters(crewDelegationToolInputSchemas[name]),
      async execute(_toolCallId, parameters, signal) {
        let request: RemoteAgentRequest;
        try {
          request = buildRequest(name, parameters, client.projectId);
        } catch {
          return result({
            outcome: "response",
            result: {
              ok: false,
              requestId: "crew-delegation-tool-validation",
              error: {
                code: "validation_failed",
                message: "Invalid delegation parameters; identity and scope come from the grant.",
                requestId: "crew-delegation-tool-validation",
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
