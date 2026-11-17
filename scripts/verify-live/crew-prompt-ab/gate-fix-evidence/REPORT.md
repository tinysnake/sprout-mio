# Gate-fix verification

Baseline: `8d46a13`; branch: `t3/crew-ab-gate-fix`. Only harness files changed; no paid live, production source edits, PR operations or writes to `/Users/snake/sprout-ab-run`.

## Commands and results

- Red: `node --test scripts/verify-live/crew-prompt-ab/gate-behavior.test.mjs` → exit 1, four behavior regressions reproduced; parallel sleep policy test already passed on the baseline. See `red.txt`. The final test file additionally covers offline audit, lead-only delivery, missing replies and filesystem snapshots.
- Green: same targeted command → 5/5 at the initial green checkpoint (`initial-green.txt`); expanded suite result in `suite-green.txt`.
- Full acceptance: `node --test scripts/verify-live/crew-prompt-ab/*.test.mjs` → exit 0; exact counts and runner duration in `suite-green.txt`.
- Dry acceptance: `AB_DRY=1 AB_TASKS=clarify-before-guessing,resolve-from-context AB_REF_A=8d46a13 AB_REF_B=9c160c6 AB_MODEL=dry/fixture AB_OUT=/tmp/crew-ab-gate-dry-final/ledger.jsonl AB_TASK_TIMEOUT_MS=60000 bash scripts/verify-live/crew-prompt-ab-run.sh` → four actual executions, four expected FAILED rows, no errored/timeout/not_run. Process exit 1 because identical source trees produce overlapping prompt character counts and the comparison eligibility gate refuses them; the workflow reaches its final summary and ledger. Task phase totals were 7928/7296/7011/7133 ms (not workflow duration). See `dry.txt`.
- A previous completed dry used refs `8d46a13`/`177dc8a`, also producing four expected FAILED rows, with exit 1 due to tool-name differences. `AB_ALLOW_TOOL_DELTA=1` was not enabled. Neither completed dry is a model-quality comparison.
- Initial dry attempt deliberately used identical refs; the harness refused that pair. It also exposed a null-reply classifier error in unstarted rows, now fixed and tested. That attempt is excluded from the completed dry evidence.
- Offline, once per batch: `node scripts/verify-live/crew-prompt-ab/rejudge.mjs /tmp/crew-ab-<batch>/ledger.jsonl /tmp/crew-ab-gate-rejudge-final2/<batch>.jsonl` → exit 0; all five named historical ledgers plus discovery `disc1` processed without model calls. Source SHA-256 values follow.

## Historical ledger provenance

| batch | rows | source SHA-256 |
| --- | ---: | --- |
| bisect1 | 18 | `50914f9d576d523463a8e3ee5a0255031142efd4add7b6980224e200b2286afd` |
| bisect2 | 18 | `8cba1fd3b51888f52c4ac3a8d0d7888edddb279dea349bde9a519ffcf9a96548` |
| bisect3 | 18 | `7b334fb25ecbe2ef73ef7810fa63a93ea9f23b9e192a4c528f4c05de2c8517bd` |
| stats1b | 30 | `24ea0d3746f6a60ddee248d035c0335459ed26fc90362f47697f75a04a83a1da` |
| new1 | 10 | `80efbc1bc0f83198ea09046204b7475c38572a276777c64dc2a650c24e877395` |
| disc1 | 2 | `63c964ca326428a659706780b276ab390f12ec4b96494e910d9deda425868ee0` |

## Outcome summary

| batch | cells | failed → passed | passed → failed | unchanged |
| --- | ---: | ---: | ---: | ---: |
| bisect1 | 18 | 2 | 0 | 16 |
| bisect2 | 18 | 2 | 1 | 15 |
| bisect3 | 18 | 1 | 0 | 17 |
| stats1b | 30 | 5 | 0 | 25 |
| new1 | 10 | 1 | 1 | 8 |

## Every changed cell

| batch | rep | arm | task | before | after | reason |
| --- | ---: | --- | --- | --- | --- | --- |
| bisect1 | 1 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect1 | 3 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect2 | 1 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect2 | 1 | B | clarify-before-guessing | passed | failed | 除客户选择外额外索取 Total 值，不满足只询问缺失事实。 |
| bisect2 | 2 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect3 | 2 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 1 | B | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 1 | B | resolve-from-context | failed | passed | 产物断言全为零；交付报告中的问号不再否定已完成的自解。 |
| stats1b | 2 | B | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 2 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 2 | B | resolve-from-context | failed | passed | 产物断言全为零；交付报告中的问号不再否定已完成的自解。 |
| new1 | 1 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| new1 | 1 | B | clarify-before-guessing | passed | failed | 同时要求确认 README 已给出的两行格式，超出了缺失的客户选择。 |

## Brief discrepancies and limits

- `bisect2 A clarify rep1`: failed → passed as requested; rep3 remains failed (`noDelegation:false`).
- `bisect2 A clarify rep2`: raw reply includes **“Need from you (one of)”**, **“Which customer this delivery is for”**, and **“Tell me which customer and I’ll proceed.”** It is a Human request despite containing zero question marks, so it becomes passed. Keeping it failed would contradict the requested behavioral semantics. A separate blocker-only negative remains failed in tests.
- `stats1b B resolve rep3` is already passed in the original ledger and remains passed. The real failed → passed cells are rep1 and rep2; no nonexistent rep3 flip is claimed.
- `bisect1 B resolve rep3` remains failed: the retained `reports/customer.md` literally contains `Customer: Northstar and Total: 42`, a single line instead of the required two. Historical artifact assertions are not silently rerun or waived. The new stability window prevents future premature checks; it does not prove a historical timing race.
- Baseline parallel-delivery gates already had no sleep threshold. The regression test proves that 90000 ms requested sleep cannot fail that gate, while serial workers and over-budget completion still fail. No removal/red→green is claimed for absent code.
- Discovery interception is at the artifact-verdict boundary, as required by the nonzero-artifact negative control; it does not prevent an application process from touching the filesystem. Correct JSON plus absent, failed, late or unrelated authorization now fails artifact assertions. No paid live confirmation was attempted.

## Discovery historical negative control

| arm | original artifact exit | revised artifact exit | outcome |
| --- | ---: | ---: | --- |
| A | 0 | 1 | failed |
| B | 0 | 1 | failed |

## Every historical cell

| batch | rep | arm | task | before | after | reason |
| --- | ---: | --- | --- | --- | --- | --- |
| bisect1 | 1 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 1 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 1 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect1 | 1 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 1 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 1 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 2 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 2 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 2 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 2 | A | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 2 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 2 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 3 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 3 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 3 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect1 | 3 | B | clarify-before-guessing | failed | failed | 不变；失败门仍为 clarification。 |
| bisect1 | 3 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect1 | 3 | B | resolve-from-context | failed | failed | 不变；失败门仍为 artifactsPass,resolvedContext。 |
| bisect2 | 1 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 1 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 1 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect2 | 1 | B | clarify-before-guessing | passed | failed | 除客户选择外额外索取 Total 值，不满足只询问缺失事实。 |
| bisect2 | 1 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 1 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 2 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 2 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 2 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 2 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect2 | 2 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 2 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 3 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 3 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 3 | A | clarify-before-guessing | failed | failed | 不变；失败门仍为 clarification。 |
| bisect2 | 3 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 3 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect2 | 3 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 1 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 1 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 1 | A | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 1 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 1 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 1 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 2 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 2 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 2 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 2 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| bisect3 | 2 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 2 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 3 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 3 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 3 | A | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 3 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 3 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| bisect3 | 3 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | A | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | B | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | A | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | B | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 1 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | B | resolve-from-context | failed | passed | 产物断言全为零；交付报告中的问号不再否定已完成的自解。 |
| stats1b | 1 | A | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
| stats1b | 1 | B | budgeted-parallel-delivery | failed | failed | 不变；失败门仍为 parallelBudget。 |
| stats1b | 2 | B | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| stats1b | 2 | A | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| stats1b | 2 | B | route-by-description | failed | failed | 不变；失败门仍为 delegatedDelivery,routing。 |
| stats1b | 2 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| stats1b | 2 | B | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 2 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| stats1b | 2 | B | resolve-from-context | failed | passed | 产物断言全为零；交付报告中的问号不再否定已完成的自解。 |
| stats1b | 2 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| stats1b | 2 | B | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
| stats1b | 2 | A | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | A | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | B | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | A | route-by-description | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | A | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | B | clarify-before-guessing | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | A | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
| stats1b | 3 | B | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
| new1 | 1 | A | worker-takes-minutes | failed | failed | 不变；失败门仍为 eventDrivenWait。 |
| new1 | 1 | B | worker-takes-minutes | passed | passed | 不变；通过全部原判据。 |
| new1 | 1 | A | route-by-description | failed | failed | 不变；失败门仍为 delegatedDelivery,routing。 |
| new1 | 1 | B | route-by-description | passed | passed | 不变；通过全部原判据。 |
| new1 | 1 | A | clarify-before-guessing | failed | passed | 未委派，明确请求选定客户；候选问句或无问号请求属于同一缺失事实。 |
| new1 | 1 | B | clarify-before-guessing | passed | failed | 同时要求确认 README 已给出的两行格式，超出了缺失的客户选择。 |
| new1 | 1 | A | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| new1 | 1 | B | resolve-from-context | passed | passed | 不变；通过全部原判据。 |
| new1 | 1 | A | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
| new1 | 1 | B | budgeted-parallel-delivery | passed | passed | 不变；通过全部原判据。 |
