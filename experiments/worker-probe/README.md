# worker-probe

Throwaway P0 experiment. It checks four Worker protocol semantics with the
smallest transport that can exercise them: NDJSON over loopback TCP, no
dependencies, no build step.

Not a production protocol and not a Mio contract. The conclusion is in
`docs/p0/worker-lease.md`.

## Run

```
bash scripts/verify.sh
```

Each probe prints `PASS <name> (<ms>)` or `FAIL <name>: <reason>` and the run
exits non-zero on any failure. Per-probe logs land in `.verify-artifacts/`
(gitignored). Node 26.11.1 or later; no `npm install`.

Run one probe directly with `node probes/01-duplicate-request-id.mjs`.

## Shape

- `src/protocol.mjs` frames, the untrusted-input parser, and the one generation
  rule shared by both receivers.
- `src/host.mjs` TCP listener, durable generation authority, host-side gate.
- `src/worker.mjs` the Worker process. Connects out, executes `run` commands,
  gates every host frame on the generation it holds.
- `src/ledger.mjs` the Worker's durable execution ledger. The dedup key and the
  recovery record.
- `fixtures/append-tick.mjs` appends exactly one line to a file, then optionally
  sleeps. The line count is the evidence that a command ran an exact number of
  times.
- `probes/` one file per semantics under test.

The host mints a monotonic `generation` per `workerId` and persists the
high-water mark. Every frame after `hello` carries the sender's held generation.
Either receiver refuses a frame whose generation is not its current one.
