import { runDurationMs, timestampMs, totalRunMs } from "./timing.mjs";

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
      const start = timestampMs(run.startedAt);
      const end = timestampMs(run.settledAt);
      if (start === null || end === null || end <= start) return [];
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

export function customerQuestion(text = "") {
  const clauses = (text ?? "").replace(/`([^`]*)`/g, "$1").split(/[。！？?\n]|(?<=[.;])\s+/);
  const selectionRequest =
    /(?:please\s+confirm|need from you|tell me|需要你确认|请(?:你)?(?:确认|回复|提供|给出))/i.test(
      text ?? "",
    );
  const request =
    /(?:which|what)\s+(?:[\w'-]+\s+){0,3}customer|哪(?:个|位|家).*客户|客户.*(?:哪|谁)|(?:please\s+confirm|tell me|请(?:你)?(?:确认|回复|提供|给出)).*(?:customer|客户)/i;
  const choices = /Northstar.*(?:or|还是).*Harbor|Harbor.*(?:or|还是).*Northstar/i;
  const asksMissingFact = clauses.some(
    (clause) =>
      (request.test(clause) || (selectionRequest && choices.test(clause))) &&
      (!/README|\b(?:missing|requires|blocked|blocker|won't ask|will not ask|cannot determine|can't determine|cannot tell|can't tell|don't know|do not know)\b|无法确定|不知道|缺(?:少|失|的是)|没有.*问/i.test(
        clause,
      ) ||
        /tell me|need from you|请(?:你)?(?:确认|回复|提供|给出)/i.test(clause)),
  );
  const asksKnownOrOtherFact = clauses.some((clause) =>
    /什么时候|何时|(?:what|which).*(?:format|deadline)|when\s+(?:do|should|is)|格式.*什么|Total\s*(?:值|是多少)|(?:请|告诉我).*(?:多少|格式)|(?:confirm\s+(?:the\s+)?file should|confirm.*two.*lines|请确认(?:一下)?[：:，,]?.*(?:格式|Total\s*(?:值|是多少)))|how much/i.test(
      clause,
    ),
  );
  return {
    asksMissingFact,
    asksKnownOrOtherFact,
    onlyMissingFact: asksMissingFact && !asksKnownOrOtherFact,
  };
}

export function taskset2Gates(name, facts, { corrected = false } = {}) {
  const config = facts.oracleConfig ?? {};
  const delegations = facts.delegationEvidence ?? [];
  const workers = facts.workerRuns ?? [];
  const leads = (facts.runs ?? []).filter((run) => run.role === "lead");
  const tools = leads.flatMap((run) => run.tools ?? []);
  const gates = {};
  function gate(key, checks, actual) {
    const values = Object.values(checks);
    gates[key] = {
      passed: values.includes(false) ? false : values.includes(null) ? null : true,
      checks,
      actual,
    };
  }
  if (name === "clarify_before_guessing") {
    const reply = facts.leadFinalReplyText ?? "";
    const question = customerQuestion(reply);
    gate(
      "clarification",
      {
        noDelegation: facts.delegatedCount === 0,
        oneQuestion: question.asksMissingFact && !facts.projectContext,
        asksMissingFact: question.asksMissingFact,
      },
      {
        reply,
        delegatedCount: facts.delegatedCount,
        // 顺口多确认一句已写明的事实（格式、Total 值）不算能力问题，只记信号不判失败。
        extraConfirmation: question.asksKnownOrOtherFact,
      },
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
  const selfResolved =
    name === "resolve_from_context" &&
    facts.delegatedCount === 0 &&
    delegations.length === 0 &&
    workers.length === 0;
  if (!selfResolved)
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
          delegations.every((d) =>
            facts.requiredDelegationArtifacts.some((file) => mapped(d, file)),
          ),
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
    const completeTimes = (facts.completeEventTimes ?? []).map(timestampMs);
    const deadline =
      completeTimes.length && completeTimes.every((ms) => ms !== null)
        ? Math.min(...completeTimes)
        : null;
    const toolsKnown =
      leads.length > 0 &&
      leads.every((run) => Array.isArray(run.tools) && run.transcriptObserved !== false);
    const dispatch = tools.find((tool) => tool.name === "sprout_delegation_start");
    const dispatchAt = timestampMs(dispatch?.atMs);
    const listCalls = tools.filter((tool) => tool.name === "sprout_delegation_list");
    const queryTimesKnown = listCalls.every((tool) => timestampMs(tool.atMs) !== null);
    const queries =
      toolsKnown &&
      deadline !== null &&
      queryTimesKnown &&
      (!corrected || !dispatch || dispatchAt !== null)
        ? listCalls.filter((tool) => {
            const atMs = timestampMs(tool.atMs);
            return atMs < deadline && (!corrected || dispatchAt === null || atMs >= dispatchAt);
          }).length
        : null;
    const leadMs = totalRunMs(leads);
    const workerMs = workers.map(runDurationMs);
    const sleepObserved = Number.isFinite(facts.sleepMsTotal)
      ? facts.sleepMsTotal <= config.maxSleepMs
      : null;
    const noRepeatedQueries = queries === null ? null : queries <= 1;
    const actionChecks = [sleepObserved, noRepeatedQueries];
    const leadActionBudget = actionChecks.includes(false)
      ? false
      : actionChecks.includes(null)
        ? null
        : true;
    gate(
      "eventDrivenWait",
      {
        sleepObserved,
        noRepeatedQueries,
        ...(corrected
          ? { leadActionBudget }
          : {
              timestampsPresent: leadMs === null ? null : true,
              leadBudget: leadMs === null ? null : leadMs <= config.leadBudgetMs,
            }),
        genuinelyLongWorker: workerMs.some((ms) => ms !== null && ms >= config.minWorkerMs)
          ? true
          : workerMs.includes(null)
            ? null
            : false,
      },
      {
        sleepMsTotal: facts.sleepMsTotal ?? null,
        queries,
        leadMs,
        workerMs,
        ...(corrected
          ? { leadActionBudget: { maxQueries: 1, maxSleepMs: config.maxSleepMs } }
          : {}),
        ...(leadMs === null ? { leadMsReason: "no timing evidence" } : {}),
        ...(sleepObserved === null
          ? { sleepMsTotalReason: "no complete lead sleep evidence" }
          : {}),
        ...(queries === null ? { queriesReason: "no complete lead query timing evidence" } : {}),
        ...(workerMs.includes(null)
          ? { workerMsReason: "no timing evidence for some worker runs" }
          : {}),
      },
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
        didNotAsk:
          (facts.artifactAssertions?.length > 0 &&
            facts.artifactAssertions.every((assertion) => assertion.exitCode === 0)) ||
          customerQuestion(facts.leadFinalReplyText).asksMissingFact,
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
