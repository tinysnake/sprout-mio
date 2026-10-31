import { z } from "zod";
import { infoHubToolInputSchemas } from "../contracts/info-hub-query";
import { remoteAgentRequestSchema } from "../contracts/remote";
import {
  readInfoHubResponse,
  type RemoteToolClient,
  type RemoteToolResponse,
} from "./remote-client";
import { INFO_HUB_TOOL_DESCRIPTION } from "./remote-tools";
import type { SproutExtensionAPI, SproutToolResult } from "./types";
function result(response: RemoteToolResponse): SproutToolResult {
  const details = response.outcome === "response" ? response.result : response;
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: response.outcome !== "response" || !response.result.ok,
  };
}
export function registerInfoHubTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
): void {
  const schema = infoHubToolInputSchemas.sprout_info_hub_get;
  pi.registerTool({
    name: "sprout_info_hub_get",
    label: "sprout_info_hub_get",
    description: INFO_HUB_TOOL_DESCRIPTION,
    parameters: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
    async execute(_id, parameters, signal) {
      const parsed = schema.safeParse(parameters);
      if (!parsed.success)
        return result({
          outcome: "response",
          result: {
            ok: false,
            requestId: "info-hub-tool-validation",
            error: {
              code: "validation_failed",
              message:
                "Invalid Info Hub query. Project and execution identity come from the grant.",
              requestId: "info-hub-tool-validation",
            },
          },
        });
      const request = remoteAgentRequestSchema.parse({
        version: 2,
        call: { type: "info_hub_get", input: { ...parsed.data, projectId: client.projectId } },
      });
      try {
        const response = await client.request(request, signal);
        return result(
          response.outcome === "response" && response.result.ok
            ? (readInfoHubResponse(response.result, request) ?? {
                outcome: "unknown",
                reason: "invalid_response",
              })
            : response,
        );
      } catch {
        return result({ outcome: "unknown", reason: "transport_error" });
      }
    },
  });
}
