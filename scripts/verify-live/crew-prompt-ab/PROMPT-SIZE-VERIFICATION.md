# Prompt inventory verification (D3)

Branch: `t3/crew-ab-prompt-size`, based on `t3/crew-ab-metrics` (`9eeb054`).
Changed: `prompt-inventory.mjs`, `prompt-inventory.test.mjs`, `core.mjs`, `main.mjs`, `README.md`; evidence below.

Reproduce: `node scripts/verify-live/crew-prompt-ab/prompt-inventory.mjs <ref-or-checkout>` (default `origin/main`).
A: `277f506c15fe771bbd337efa259dc517c3ffc1cd`; B: `0130cbece1fde9d5e34e328f05c00475d534b615`.
Fixture: Pi 1.5.2, fixed profile/project/role facts and cwd; no skills, memory, Web extensions or Machine lease.
System totals include the SDK's 39-character suffix. Tool totals include parameter descriptions; units are UTF-16 characters.

| Role | A system | B system | Compression | A tools | B tools | Compression |
|---|---:|---:|---:|---:|---:|---:|
| lead | 582 | 1779 | -205.67% | 10171 | 13236 | -30.13% |
| worker | 582 | 1390 | -138.83% | 10251 | 12397 | -20.93% |

A crew sections: lead=0, worker=0. B crew sections: lead=1062, worker=673. Negative compression means growth.

| B largest tools (union of roles) | Roles | Description | Parameters | Total |
|---|---|---:|---:|---:|
| codemode | both | 1400 | 22 | 1422 |
| sprout_delegation_start | lead | 1122 | 0 | 1122 |
| grep | both | 221 | 462 | 683 |
| sprout_remote_execution_cancel | both | 477 | 0 | 477 |
| read | both | 303 | 123 | 426 |

Raw red→green output: [missing module red](prompt-size-evidence/red.txt), [report red](prompt-size-evidence/report-red.txt), [full green](prompt-size-evidence/green.txt).
```text
red: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../prompt-inventory.mjs' (full path and stack in red.txt); exit=1
report red: TypeError [Error]: Cannot read properties of undefined (reading 'rows'); exit=1
ℹ tests 88
ℹ pass 88
ℹ fail 0
ℹ duration_ms 6382.291791
```
Green command: `node --test scripts/verify-live/crew-prompt-ab/*.test.mjs`, exit=0. `git diff --check`: exit=0, no output.
Raw inventories: [A.json](prompt-size-evidence/A.json), [B.json](prompt-size-evidence/B.json).
Tests cover section reconciliation, nested parameter descriptions, compression/zero baseline, report integration, real role allowlists, repeated measurements, checkout inputs and worktree cleanup after success/failure.
A/B report integration is exercised through `summarize`; no paid live model batch was run. The two pre-existing unrelated edits were left untouched.
