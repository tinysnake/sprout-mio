# recovery-probe

Minimal recovery model and fault matrix for P0 item 6: what a host disconnect,
a host restart, a worker restart, and a machine restart each promise about a
running or finished remote command.

The experiment answers three questions with real processes and real kills:

- Which results survive each fault?
- Which become explicitly `unknown` instead of guessed?
- What never re-runs a command whose result is unknown?

It is a prototype, not the production implementation. It reuses an idea from
P0-e (a durable per-request record that is written before the child starts) but
the code is independent and does not import `experiments/worker-probe`.

## Run

```bash
bash scripts/verify.sh
```

The shell launches the harness in the background and polls it, so no cell can
block the terminal. The full run takes about a minute. Exit code is non-zero if
any cell's promise does not hold. Output is kept in `evidence/matrix-run.txt`
and a scratch copy of each cell is kept under `.matrix/<cell-id>/`.

One cell on its own:

```bash
node scripts/matrix.mjs --cell machine-restart__long-running
```

## Layout

| File | Responsibility |
| --- | --- |
| `src/wire.mjs` | Newline-delimited JSON framing |
| `src/journal.mjs` | Worker-side durable execution journal and reconciliation |
| `src/runner.mjs` | The command under test. Side effect, claim, sleep, result |
| `src/worker.mjs` | Long-lived command host. Spawns runners, answers `query` |
| `src/host.mjs` | Host client and the durable host intent journal |
| `src/host-child.mjs` | A host that holds its connection until killed |
| `scripts/matrix.mjs` | The 12-cell harness and its assertions |

## Model

Three durable layers, each with a distinct authority.

1. **Host intent journal.** Written before a command is submitted. A restarted
   host rebuilds pending intent from here, not from memory.
2. **Worker execution journal.** Written before the runner starts. It holds the
   execution id, a fence token, the runner pid, and the state. A restarted
   worker reconciles it and never re-spawns a non-terminal record.
3. **Runner claim and result files.** The runner records its pid and token at
   start and writes its terminal result after the sleep. A kill before that
   write leaves no outcome on disk.

State is a discriminated union, not parallel booleans:

```
starting | running | exited { code, signal } | unknown { reason }
```

`unknown` is a first-class result. It is what the system reports when it cannot
confirm an outcome, and it is never converted into a silent re-run.
