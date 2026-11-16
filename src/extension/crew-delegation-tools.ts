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
    "Delegate one piece of work from this Crew to an Agent member. Optional resources registers and approves the worker's Machine, directory and operation scopes during dispatch; allocation still waits for the Crew resource coordinator. Read the current Crew context from sprout_info_hub; a delegation child chat ID is not a crewChatId. Waits up to blockMs (default 10000, max 60000) for the real worker run to start. Returns running, queued (blockMs:0), blocked, failed, canceled, or timed_out with the dispatched IDs. queued/timed_out are already dispatched: do not list to confirm or create a second delegation. Completion arrives as a durable event. Without clientRequestId, retries for the same Crew, worker and normalized request reuse a non-terminal delegation across lead runs. reused=true means the worker already exists: do not re-dispatch. Terminal delegations allow a fresh dispatch. Normalization trims outer whitespace and converts CRLF/CR to LF; internal spacing and case remain significant. Explicit clientRequestId retains key-based replay.",
  sprout_delegation_input:
    "Send an additional instruction to a running delegation. It is delivered to the worker run without posting into the Crew timeline.",
  sprout_delegation_cancel: "Cancel one delegation of this Crew and stop its worker run.",
  sprout_delegation_list: "List this Crew's delegations and their latest events.",
};

function buildRequest(
  name: CrewDelegationToolName,
  raw: unknown,
  client: RemoteToolClient,
): RemoteAgentRequest {
  const input = {
    ...crewDelegationToolInputSchemas[name].parse(raw),
    projectId: client.projectId,
  } as Record<string, unknown>;
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
      description:
        descriptions[name] +
        " rejected 表示服务端明确拒绝：读取 status、error.code 和 error.message，先解决原因，不要盲目重试。",
      parameters: objectToolParameters(crewDelegationToolInputSchemas[name]),
      async execute(_toolCallId, parameters, signal) {
        let request: RemoteAgentRequest;
        try {
          request = buildRequest(name, parameters, client);
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
