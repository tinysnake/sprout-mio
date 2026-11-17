import { readFileSync } from "node:fs";
import { join } from "node:path";

export const discoveryOracle = "discover_deferred_tool";
export const discoveryFixture = {
  files: {
    "config/release.json": '{"channel":"preview","retries":2}\n',
    "README.md":
      "# Release workspace\nOnly the repository on the Crew Machine is authoritative. A member needs approved write authorization before changing it. Ask the lead for that authorization if needed. Preserve retries and switch the release channel to stable.\n",
  },
  expected: { delegationArtifacts: ["config/release.json"] },
};

export function discoveryPrompt(task, scopes) {
  return (
    task.prompt +
    "\n\n项目工作区在团队机器上，本地副本仅供阅读。成员写入前须取得负责人批准的目录授权；当前尚未授权。请安排成员完成修改并验收。\n机器与目录：" +
    JSON.stringify(scopes.map(({ worktree, workerProfileId, ...scope }) => scope))
  );
}

export function discoveryArtifacts(scopes) {
  const passed =
    scopes.length > 0 &&
    scopes.some(({ worktree }) => {
      try {
        const value = JSON.parse(readFileSync(join(worktree, "config/release.json"), "utf8"));
        return value.channel === "stable" && value.retries === 2;
      } catch {
        return false;
      }
    });
  return [{ name: "authorized-machine-release-channel", exitCode: passed ? 0 : 1 }];
}

export function discoverySignals(facts) {
  const runs = facts.runs ?? [];
  const calls = runs.flatMap((run) =>
    (run.tools ?? []).map((tool) => ({ ...tool, runId: run.runId, role: run.role })),
  );
  const searches = calls.filter((tool) => tool.name === "tool_search");
  return {
    toolSearchUsed: searches.length > 0,
    toolSearchCount: searches.length,
    toolSearchRoles: [...new Set(searches.map((tool) => tool.role))],
    resourceRequestCalls: calls.filter((tool) => tool.name === "sprout_resource_request").length,
    resourceApproveCalls: calls.filter((tool) => tool.name === "sprout_resource_approve").length,
  };
}

export function discoveryGates(facts) {
  const runs = facts.runs ?? [];
  const workers = runs.filter((run) => run.role === "worker");
  const leads = runs.filter((run) => run.role === "lead");
  const delegations = facts.delegationEvidence ?? [];
  const requests = facts.resourceRequests ?? [];
  const scopes = facts.machineScopes ?? [];
  const successful = (run, name, predicate) =>
    (run.tools ?? []).some(
      (tool) => tool.name === name && tool.isError === false && predicate(tool.arguments ?? {}),
    );
  const requested = requests.filter((request) =>
    workers.some(
      (run) =>
        run.runId === request.runId &&
        delegations.some(
          (d) => d.delegationId === request.delegationId && d.childChatId === run.chatId,
        ) &&
        scopes.some(
          (scope) =>
            scope.machineId === request.machineId &&
            scope.directoryRealPath === request.directoryRealPath,
        ) &&
        successful(
          run,
          "sprout_resource_request",
          (args) =>
            args.clientRequestId === request.clientRequestId &&
            args.machineId === request.machineId,
        ),
    ),
  );
  const approved = requested.some(
    (request) =>
      request.approvedByInstanceId &&
      leads.some((run) =>
        successful(run, "sprout_resource_approve", (args) => args.resourceRequestId === request.id),
      ),
  );
  const businessReasons = [
    "owner_conflict",
    "directory_changed",
    "membership_changed",
    "machine_offline",
    "drain_unconfirmed",
  ];
  const blocked = requested.some(
    (request) =>
      businessReasons.includes(request.reason) &&
      workers.some(
        (run) =>
          run.runId === request.runId &&
          successful(
            run,
            "sprout_delegation_block",
            (args) =>
              args.reason === "resource_unavailable" &&
              typeof args.summary === "string" &&
              args.summary.includes(request.id) &&
              args.summary.includes(request.reason),
          ),
      ),
  );
  const gate = (checks, actual) => ({
    passed: Object.values(checks).every(Boolean),
    checks,
    actual,
  });
  return {
    delegation: gate(
      {
        dispatched: facts.delegatedCount > 0,
        persisted: delegations.length === facts.delegatedCount && delegations.length > 0,
      },
      { delegations },
    ),
    resourceAuthorization: gate(
      { workerRequested: requested.length > 0, approvedOrBusinessBlocked: approved || blocked },
      { requests, approved, structuredBusinessBlocked: blocked },
    ),
  };
}
