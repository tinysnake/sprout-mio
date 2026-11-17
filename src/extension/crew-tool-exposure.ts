import type { Situation } from "../contracts/prompt";

const deferredNames = new Set([
  "codemode",
  "sprout_remote_execution_cancel",
  "sprout_remote_execution_wait",
  "sprout_remote_execution_log",
  "sprout_remote_execution_get",
  "sprout_remote_execution_list",
  "sprout_remote_process_list",
  "sprout_remote_process_signal",
  "sprout_resource_request",
  "sprout_resource_approve",
  "sprout_resource_revoke",
  "sprout_resource_takeover",
  "sprout_chat_get",
]);

export function isCrewDeferredTool(situation: Situation | undefined, name: string): boolean {
  return (
    (situation?.kind === "crew_lead" || situation?.kind === "delegation_worker") &&
    (deferredNames.has(name) || name.startsWith("sprout_task_"))
  );
}
