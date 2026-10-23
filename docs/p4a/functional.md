# Machine functional implementation

Implementation uses the selected Phase D design. Identity, enrollment, connection session, Project intent and observations retain the shared contract shapes. No alternate architecture or sub-workers are started.

## Risk → Test

| Risk                                                                  | Truthful verification                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unauthenticated or cross-owner operations disclose or mutate identity | Human boundary calls with real sessions, second owner and absent session                                |
| Enrollment retry replaces identity or exposes secrets                 | Real SQLite hash-only rows, same-secret retry, changed-secret refusal, pending-only renewal             |
| Diagnostic failure leaves business writes committed                   | Inject failure before diagnostic insert and compare SQLite rows                                         |
| Retry or stale connection overwrites newer facts                      | Real database open/exchange/close sequences across attempts, boot, seq and expiry; canonical hash retry |
| Binding races or old directory revision appear current                | CAS update and historical observation queries against SQLite                                            |
| Local identity changes after failure or leaks through permissions     | CLI init retries and corrupt/private-file checks against real filesystem                                |
| Runtime retry cannot stop or package depends on checkout              | Independent copied Worker, SIGTERM during retry, production restart                                     |
| Probe manufactures executable or directory facts                      | Actual macOS fixed shell probes and stat/realpath/access, missing path counterpart                      |
| HTTP adapters bypass validation or boundary limits                    | Real production routes with Origin, oversized body, bad credential and unsupported version              |

## Throughput checkpoint

First verify authenticated create → init → open → exchange against production. Then add binding and stale-write counterexamples. Keep long builds in background with separate logs and exit files. A missing dependency or production adapter failure gets a minimal reproduction before expanding work.

Model the Domain keeps Machine identity, session and intent distinct. Prove It Works requires an independently copied CLI and real HTTP/SQLite evidence.

## Delivered behavior and integration points

`src/domain/machine.ts` owns createMachine, renewMachineEnrollment, listMachines, getMachine, listProjectMachines and saveProjectMachineBinding. Each write uses an IMMEDIATE SQLite transaction and inserts its diagnostic in the same transaction. MachineError registers not_found and conflict with the shared boundary mapping. Reads return explicit field projections with enrollmentStatus derived from credential activation. MachineContext receives userId, requestId, bootId and Clock time from the server boundary.

`src/server/functions/machine.ts` exports matching `*Boundary` functions and `createMachineFn`, `renewMachineEnrollmentFn`, `listMachinesFn`, `getMachineFn`, `listProjectMachinesFn`, `saveProjectMachineBindingFn`. All six RPCs use POST with `{ data: input }` at TanStack callers and return MachineResult. The boundary authenticates before Zod parsing and domain calls. UI imports these functions directly and the existing shared Human contracts. listMachinesFn requires `{}`. getMachineFn accepts optional projectId.

`src/server/worker-gateway.ts` exports enrollWorker, openWorker, exchangeWorker, closeWorker and workerResponse. The four `/api/worker/{enroll,open,exchange,close}` POST file routes load that gateway. They use the delivered private body-secret schema. Origin is rejected. Bodies are limited to 2 MiB during streaming. Errors carry the current service requestId and safe codes. No request body or credential is recorded.

Runtime supplies its existing boot identity and ManagedRuntime Clock. There is no registry or background host loop. Transactions authenticate each request and check boot, counter, attempt, open status, expiry and seq. Equal seq uses the canonical semantic payload hash and retains lastSeenAt. Binding changes use expectedRevision CAS. Old observations remain queryable with current=false. High-water and revision overflow reject.

Worker identity, probes and client live in src/worker. `pnpm worker:build` bundles Effect and Zod into dist/worker/main.js. The installed file can be named main.mjs. Installation and CLI instructions are in [worker.md](worker.md). Worker logs contain only safe connection identifiers, seq, observation counts and retry intervals.

## Build integration deviation

This functional branch has no Machine page importing its server functions. TanStack discovers RPCs from the client module graph. A server-only side-effect import did not produce transformed RPCs, and a second client build entry failed because Start requires one client entry. vite.config.ts therefore adds a small pre-transform import of the Machine RPC module to Start's default client entry. The final production output contains all six createServerRpc registrations. This does not add a protocol or UI adapter. Once integrated page imports make the module reachable, the coordinator can remove this discovery hook and prove the six functions remain emitted.

## Existing assertion updates

Only the Worker CLI assertions in scripts/verify/a-base.sh changed.

| Original assertion                                | Replacement                                    | Trigger                                                                      |
| ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Exact version ends with protocol=unimplemented    | Version has protocol=1 and actual Node version | Real protocol and runtime are delivered                                      |
| No arguments prints unimplemented connection text | No arguments prints init usage                 | CLI now provides init and run                                                |
| Help contains --version                           | Help contains sprout-worker version            | Documented command names now include help and version; old flags still parse |

The extension status assertion and CI were not changed. No contracts, schema, migration, product page, dev presentation or plan checklist changed.

## Verification scope

Machine transaction fixtures use real isolated migrated SQLite. Worker filesystem tests cover private permissions, corrupt identity, immutable identity, private ticket files, directory symlinks, missing paths and actual macOS probes. The HTTP script creates isolated production and dev services, authenticates through Better Auth, drives the real RPC protocol, copies the bundled Worker outside the project, runs hidden PTY input, and checks actual connection and directory facts. It interrupts production, observes same-process Worker reconnection, restarts production, rejects the old boot and proves persistent high-water. SIGTERM during network backoff exits cleanly. Failure injection covers wrong credentials, Origin, oversized body, unsupported version, changed equal seq, lower seq, old close and old directory revision.

The PTY test first failed because the prompt preceded raw mode. Moving raw mode before the prompt made the terminal echo assertion pass. This is a captured red-to-green regression. Other new tests protect feature invariants rather than claim pre-existing bug regressions.

Cross-machine network, TLS deployment, reverse proxy, physical power loss and real-device soft keyboard are unverified. P4a does not install LaunchAgent or provide remote shell operations. Full chapter integration and Human confirmation remain coordinator-owned.
