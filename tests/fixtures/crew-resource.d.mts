export interface ProvisionCrewResourceInput {
  crewChatId: string;
  machineId: string;
  operations: Array<"shell" | "file_read" | "file_write" | "file_edit">;
  clientRequestId?: string;
}

export interface ProvisionedCrewResource {
  id: string;
  state: string;
  approval: string;
  generation: number | null;
  grantId: string | null;
  runId: string;
  instanceId: string;
}

export function provisionCrewResource(
  database: string,
  input: ProvisionCrewResourceInput,
): ProvisionedCrewResource;
