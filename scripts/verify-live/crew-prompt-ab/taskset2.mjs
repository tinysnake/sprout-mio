export const taskset2Oracles = [
  "worker_takes_minutes",
  "route_by_description",
  "clarify_before_guessing",
  "resolve_from_context",
  "budgeted_parallel_delivery",
];

export function maxActiveWorkers(runs = []) {
  const edges = runs
    .flatMap((run) => {
      const start = Number(run.startedAt);
      const end = Number(run.settledAt);
      if (
        run.startedAt == null ||
        run.settledAt == null ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      )
        return [];
      return [
        [start, 1],
        [end, -1],
      ];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of edges) peak = Math.max(peak, (active += delta));
  return peak;
}

export function taskset2Gates(name, facts) {
  const config = facts.oracleConfig ?? {};
  const delegations = facts.delegationEvidence ?? [];
  const workers = facts.workerRuns ?? [];
  const leads = (facts.runs ?? []).filter((run) => run.role === "lead");
  const tools = leads.flatMap((run) => run.tools ?? []);
  const gates = {};
  function gate(key, checks, actual) {
    gates[key] = { passed: Object.values(checks).every(Boolean), checks, actual };
  }
  if (name === "clarify_before_guessing") {
    const reply = facts.leadFinalReplyText ?? "";
    gate(
      "clarification",
      {
        noDelegation: facts.delegatedCount === 0,
        oneQuestion: (reply.match(/[?？]/g) ?? []).length === 1,
        asksMissingFact:
          typeof config.questionPattern === "string" &&
          new RegExp(config.questionPattern, "i").test(reply),
      },
      { reply, delegatedCount: facts.delegatedCount },
    );
    return gates;
  }
  const mapped = (delegation, file) => {
    if (delegation.requestArtifacts.includes(file) && delegation.workerArtifacts.includes(file))
      return true;
    const command = facts.artifactCommands?.[file];
    return (
      typeof command === "string" &&
      delegation.requestSummary?.includes(command) &&
      workers.some(
        (run) =>
          run.chatId === delegation.childChatId &&
          run.tools?.some(
            (tool) => tool.isError === false && JSON.stringify(tool.arguments).includes(command),
          ),
      )
    );
  };
  gate(
    "delegatedDelivery",
    {
      count: Number.isInteger(config.minDelegationCount)
        ? facts.delegatedCount >= config.minDelegationCount
        : facts.delegatedCount === config.delegationCount,
      mapped: delegations.length === facts.delegatedCount && delegations.length > 0,
      completed: delegations.every((d) => d.status === "completed"),
      workerRuns: workers.length >= facts.delegatedCount,
      allWorkersCompleted: workers.every((run) => run.status === "completed"),
      receipts:
        facts.workerReportedComplete?.length === facts.delegatedCount &&
        facts.workerReportedComplete.every(Boolean),
      artifactsAttributed:
        (facts.requiredDelegationArtifacts?.length ?? 0) > 0 &&
        facts.requiredDelegationArtifacts.every((file) =>
          delegations.some((d) => mapped(d, file)),
        ) &&
        delegations.every((d) => facts.requiredDelegationArtifacts.some((file) => mapped(d, file))),
      finalAfterReceipts:
        facts.completeEventTimes?.length === facts.delegatedCount &&
        facts.completeEventTimes.every((time) => facts.leadFinalReplyAtMs > time),
    },
    {
      delegations,
      workerRuns: workers.map(({ runId, startedAt, settledAt }) => ({
        runId,
        startedAt,
        settledAt,
      })),
    },
  );
  if (name === "worker_takes_minutes") {
    const deadline = Math.min(...(facts.completeEventTimes ?? []));
    const queries = tools.filter(
      (tool) =>
        tool.name === "sprout_delegation_list" &&
        (!Number.isFinite(tool.atMs) || tool.atMs < deadline),
    );
    const leadMs = leads.reduce(
      (sum, run) => sum + (Number(run.settledAt) - Number(run.startedAt)),
      0,
    );
    gate(
      "eventDrivenWait",
      {
        sleepObserved:
          Number.isFinite(facts.sleepMsTotal) && facts.sleepMsTotal <= config.maxSleepMs,
        noRepeatedQueries: queries.length <= 1,
        timestampsPresent:
          leads.length > 0 &&
          leads.every(
            (run) =>
              run.startedAt != null && run.settledAt != null && run.settledAt >= run.startedAt,
          ),
        leadBudget: leadMs <= config.leadBudgetMs,
        genuinelyLongWorker: workers.some(
          (run) =>
            run.startedAt != null &&
            run.settledAt != null &&
            run.settledAt - run.startedAt >= config.minWorkerMs,
        ),
      },
      { sleepMsTotal: facts.sleepMsTotal, queries: queries.length, leadMs },
    );
  }
  if (name === "route_by_description") {
    gate(
      "routing",
      {
        expectedProfilePresent: typeof facts.expectedWorkerProfileId === "string",
        correctProfile:
          delegations.length === 1 &&
          delegations[0].workerProfileId === facts.expectedWorkerProfileId,
        actualRunMatches:
          workers.length > 0 &&
          workers.every((run) => run.profileId === facts.expectedWorkerProfileId),
      },
      {
        expected: facts.expectedWorkerProfileId,
        profiles: delegations.map((d) => d.workerProfileId),
      },
    );
  }
  if (name === "resolve_from_context") {
    gate(
      "resolvedContext",
      {
        contextAvailable: Boolean(facts.projectContext),
        didNotAsk: !/[?？]/.test(facts.leadFinalReplyText ?? ""),
      },
      { projectContext: facts.projectContext, reply: facts.leadFinalReplyText },
    );
  }
  if (name === "budgeted_parallel_delivery") {
    const peak = maxActiveWorkers(workers);
    const started = facts.taskSentAtMs;
    gate(
      "parallelBudget",
      {
        simultaneousWorkers: peak >= 2,
        differentProfiles: new Set(workers.map((run) => run.profileId).filter(Boolean)).size >= 2,
        startKnown: Number.isFinite(started),
        deliveryWithinBudget:
          Number.isFinite(started) &&
          Number.isFinite(facts.leadFinalReplyAtMs) &&
          facts.leadFinalReplyAtMs >= started &&
          facts.leadFinalReplyAtMs - started <= config.deliveryBudgetMs,
      },
      { peak, started, delivered: facts.leadFinalReplyAtMs, budgetMs: config.deliveryBudgetMs },
    );
  }
  return gates;
}

export function successCohort(row) {
  return row.category === "sanity" ? "SANITY" : "ALL";
}

export const successPopulation =
  "Main success denominator: passed/failed primary items only; sanity is reported separately and excluded. Incomplete sanity still refuses batch comparison.";
