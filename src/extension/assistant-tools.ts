import { z } from "zod";
import { ASSISTANT_TOOL_SPEC } from "../contracts/assistant";
import { remoteAgentRequestSchema } from "../contracts/remote";
import type { RemoteToolClient } from "./remote-client";
import { objectToolParameters } from "./tool-parameters";
import type { SproutExtensionAPI } from "./types";
export function registerAssistantTools(
  pi: Pick<SproutExtensionAPI, "registerTool">,
  client: RemoteToolClient,
) {
  for (const [name, spec] of Object.entries(ASSISTANT_TOOL_SPEC)) {
    const { projectId: _projectId, ...shape } = spec.input.shape;
    const input = z.strictObject(shape);
    pi.registerTool({
      name,
      label: name,
      description: spec.description,
      parameters: objectToolParameters(input),
      async execute(_id, parameters, signal) {
        const parsed = input.safeParse(parameters);
        if (!parsed.success)
          return {
            content: [{ type: "text", text: "Invalid assistant input" }],
            details: {},
            isError: true,
          };
        const request = remoteAgentRequestSchema.parse({
          version: 2,
          call: { type: spec.call, input: { ...parsed.data, projectId: client.projectId } },
        });
        const response = await client.request(request, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          details: response,
          isError: response.outcome !== "response" || !response.result.ok,
        };
      },
    });
  }
}
