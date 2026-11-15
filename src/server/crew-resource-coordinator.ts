import { crewResourceCallSchema } from "../contracts/crew-resource";
import {
  approveCrewResource,
  reconcileCrewResources,
  advanceCrewResources,
  releaseCrewResource,
  requestCrewResource,
  revokeCrewResource,
  takeoverCrewResource,
  type CrewResourceActor,
} from "../domain/crew-resource";

/** Intent handlers only commit durable facts. Machine exchange drives fencing outside these transactions. */
export function coordinateCrewResource(command: unknown, actor: CrewResourceActor) {
  const call = crewResourceCallSchema.parse(command);
  switch (call.op) {
    case "request":
      return requestCrewResource(call.input, actor);
    case "approve":
      return approveCrewResource(call.input, actor);
    case "revoke":
      return revokeCrewResource(call.input, actor);
    case "release":
      return releaseCrewResource(call.input.resourceRequestId, actor);
    case "takeover":
      return takeoverCrewResource(call.input, actor);
  }
}
export function tickCrewResources() {
  const released = reconcileCrewResources();
  const allocated = advanceCrewResources();
  return { released, allocated };
}
