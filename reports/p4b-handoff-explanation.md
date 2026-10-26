# P4b handoff disabled explanation

## Root cause

The reported state is valid: the handoff target Machine and target instance may both be selected while no Chat is selected. `ProjectLeaseActions` intentionally includes `!chatId` in the handoff button's disabled condition. Its `mutate` callback calls `requestProjectLease(input, chatId, ...)`, which sends the request through the selected Chat's agent and waits for the existing server receipt. Removing or guessing `chatId` would bypass that explicit routing prerequisite. The UI fault was that the handoff controls showed no local explanation for this disabled state.

## Change

`src/components/machine/project-lease-actions.tsx` now shows a short instruction beside the handoff/reclaim controls only when a Machine and target instance are selected but Chat is missing. Selecting Chat hides the instruction; the existing button gating and send/receipt path remain unchanged.

`scripts/verify/z-lease-integration.sh` now selects a handoff target while Chat is unset, asserts the target values are nonempty, the handoff button is disabled, and the instruction is visible; then explicitly selects the Chat and asserts the button is enabled and the instruction is gone. The existing real handoff flow continues through the same button and selected Chat to a real agent and confirms the resulting transfer.

## Verification

- `pnpm install --frozen-lockfile` — passed; dependencies were installed in this isolated worktree.
- `pnpm typecheck` — passed.
- `pnpm worker:build` — passed.
- `pnpm test -- tests/project-lease-actions.test.ts` — runner reported 45 files and 332 tests passed (the repository runner executes the full suite for this invocation).
- `pnpm build` — passed. Build output said ports 3000, 3001, and 3002 were occupied and selected another port; no server was started on those ports.
- `bash -n scripts/verify/z-lease-integration.sh` and `git diff --check` — passed.
- Isolated production browser integration — new disabled/explanation/enabled assertions passed; the existing real UI handoff and reclaim, acquisition, remote operation, authorization-denial, and other integration assertions passed. `.verify/p4b-integration/evidence/run-w1im0D/results.json` records all 12 PASS entries. The command nevertheless exited 1 after printing the evidence summary and timing report; there is no `failure.txt`, so this verifier invocation is not reported as fully passed. Evidence is under `.verify/p4b-integration/evidence/run-w1im0D/`.
- Screenshots `handoff-needs-chat.png` and `handoff-chat-selected.png` were captured. Browser state assertions passed, but screenshots were not visually reviewed because the available model has no image capability.

## Unverified

- Visual review of the two screenshots.
- The integration script's nonzero exit after all pass entries; no failure artifact was emitted to identify its cause.
- Cross-machine network and real-device soft keyboard, per project standing orders.
