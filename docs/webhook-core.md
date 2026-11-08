# Project webhook automation

## Implemented boundary

The core domain accepts a rule, raw bearer secret, stable event ID, and JSON object. The HTTP route `POST /api/webhooks/$ruleId` pre-authenticates credentials before it reads the body, enforces a 64 KiB streamed request limit, requires `X-Sprout-Event-Id` and `application/json`, and then rechecks authorization inside atomic admission. HTTP errors are bounded and do not expose secrets or framework errors. Management uses Human-session server functions; the domain denies Agent contexts and checks Project ownership/access. Endpoints are generated from configured `APP_ORIGIN`.

The Project settings section offers rule create/list/edit/enable state, action and target selection, a create-only secret disclosure with curl example, a JSON-object Trial control, and recent receipt details. Trial invokes real admission and is not a dry run. The secret is not persisted in browser storage. History is capped at 50 and resolves Chat/run associations from the accepted message input rather than the rule's current action. No browser end-to-end acceptance or Human UI approval is claimed yet.

## Contract

- A Human with Project access creates, lists, and revision-updates a Project-owned rule. The action is one strict `dm_agent`, `group_agent`, or `group_owner`; the endpoint secret is returned once and only its SHA-256 digest is stored. The HTTP ingress adapter must authenticate the raw credential before parsing/deduplicating event content and must never log or reflect it.
- Admission uses `(rule, live|trial, eventId)` and canonical JSON fingerprint. A same-payload retry returns the original immutable receipt; changed payload conflicts. Accepted admission snapshots rule revision/instruction/action and atomically writes one `automation` source Chat message and one ordinary Agent-run input. Authenticated disabled/invalid-target admissions yield skipped receipts without a message. Trial uses its own deduplication namespace but deliberately exercises the same Chat/run path.
- `automation` is a message provenance kind, not a Chat member kind. Its `senderId` identifies the trigger, and its required `automationSource` is tied to the trigger. Public `sendMessage` remains Human/Agent-only. The source envelope is passed through the existing Pi user/custom-origin input path; event text is not a system prompt, recipient selector, mention, or skill invocation.
- The configured Agent is pinned at admission. Current Chat participation, Project access, stop/archive state, and owner identity are checked again at delivery. If authority changes before send, the pending input is cancelled; no retarget, retry, or recovery worker is introduced. The existing `admittedAt` attempted-send boundary prevents uncertain wire delivery from being retried automatically. No exactly-once model-execution promise is made.

## Risk → test map

| Risk | Evidence |
| --- | --- |
| Foreign Project/Agent context or source forgery | `tests/automation-core.test.ts` management and `sendMessage` denial cases |
| Secret exposure, invalid credentials, duplicate collision, trial leakage | `tests/automation-core.test.ts` digest, auth-before-dedupe, canonical retry/conflict, separate trial namespace |
| NULL bypass, invalid receipt shape, Task/FK regression | `tests/automation-migration.test.ts` SQL negative cases and populated 0036 upgrade |
| Wrong action recipient, mention/skill parsing, or source misclassification | `tests/automation-core.test.ts` all three actions, source UI identity, provenance and empty mention/skill spans |
| Initial/active protocol bypass, revoked participation, owner retarget, uncertain send retry | Actual fixture-backed `executeRun` prompt/steer and final-authority-boundary tests in `tests/automation-core.test.ts` |
| Existing Chat and Task behavior regression | `tests/chat.test.ts`, `tests/chat-wake.test.ts`, `tests/agent-run-turn.test.ts`, `tests/task-start.test.ts`, `tests/task-migration.test.ts`, `tests/run-activity-ui.test.ts` |

## Focused verification

```sh
pnpm exec vp test run tests/automation-core.test.ts tests/automation-migration.test.ts tests/automation-contracts.test.ts tests/task-start.test.ts tests/task-migration.test.ts tests/run-activity-ui.test.ts tests/chat.test.ts tests/chat-wake.test.ts tests/agent-run-turn.test.ts
pnpm typecheck
pnpm exec vp fmt src/contracts/agent-run.ts src/contracts/automation.ts src/contracts/chat.ts src/db/schema.ts src/domain/agent-run.ts src/domain/automation.ts src/domain/automation-input.ts src/domain/automation-target.ts src/domain/chat.ts src/server/message-skills.ts src/server/pi-host/run.ts src/components/chat/message-list.tsx tests/automation-core.test.ts tests/automation-contracts.test.ts tests/automation-migration.test.ts tests/run-activity-ui.test.ts tests/fixtures/webhook-wire.mjs --check
```

The fixture is a protocol-only Pi peer; tests perform no paid model calls. The HTTP route, Project settings UI, and browser tests remain outside this core checkpoint.
