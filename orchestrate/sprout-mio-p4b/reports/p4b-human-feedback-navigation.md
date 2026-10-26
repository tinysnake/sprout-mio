# P4b Human feedback: navigation and Machine lease list

Status: implementation and additive browser evidence verifier committed. Production-route integration passed in `/tmp/p4b-verify13`; no merge performed.

## Changes

- Added a Project × Machine lease list to Machine details, with one link per binding and Project names from the existing loader data. Kept the existing Machine settings route and binding editor.
- Removed lease shortcuts from Machine detail header actions and removed the lease page's self-navigation action.
- Changed the lease page back control to browser history back when the router has a prior history index, with Project settings or Machine details as direct-open fallback.
- Updated real and demo browser assertions to cover list presence, the removed actions, and history back/forward/refresh navigation.

## Verification

- `git diff --check`: passed.
- Initial `scripts/verify/y-lease-ui.sh` attempt in this isolated worktree could not resolve dependencies through the temporary symlink to `/tmp/p4b-verify13/node_modules`; Vite resolved package files relative to that other checkout. No source changes were made there.
- Ran `pnpm typecheck` in this worktree using the temporary dependency symlink: passed. Removed the symlink before commit.
- Ran `scripts/verify/y-lease-ui.sh` from the clean `/tmp/p4b-verify13` checkout at commit `d5000df`, which contains this implementation: passed 18/18, evidence at `/private/tmp/p4b-verify13/.verify/p4b-ui/evidence`.
- Added production-route responsive browser evidence in commit `28851e7` on the isolated worktree branch and cherry-picked as `5bf24ee` into `/tmp/p4b-verify13` (parent `1a9b852`). No product source changed, so no typecheck was needed for this verifier-only commit.
- Ran `bash scripts/verify/z-lease-integration.sh` in `/tmp/p4b-verify13` at `5bf24ee` in the foreground; exit 0, all 13 named `PASS` checks. This run retains the Project settings, history, direct-open fallback, refresh, and security assertions.
- Evidence run: `/private/tmp/p4b-verify13/.verify/p4b-integration/evidence/run-YAaJiu`. `machine-details-leases-390.png` is 390×844 and `machine-details-leases-1200.png` is 1200×900, confirmed from image metadata with `sips`.
- Both new screenshots show the actual authenticated production route `/machines/$machineId` with a held real lease, at the requested viewport dimensions. The script asserts the real lease list exists; the Project identity is visible; the link has `/machines/${machineId}/lease?projectId=${projectId}`; the document has no horizontal overflow; the row bounds fit within the viewport; and clicking the row reaches the exact lease route with that Project context. These are browser assertions, not a visual review. Visual PASS is not claimed; the independent visual reviewer handles appearance review.
- P4a scripts are not required because this unit changes neither Worker behavior nor capability shapes.
- P4a scripts are not required because this unit changes neither Worker behavior nor capability shapes.
- Cross-machine networking and physical-device soft keyboard remain unverified, consistent with the chapter's existing limits.

## Screenshot review

Reviewed `/tmp/p4b-fb-review/vision-findings.md` and the four supplied images: `fb1-project-count.png`, `fb3-unnecessary-button.png`, `fb6a-mobile-lease.png`, and `fb6b-settings-list.png`. The list design follows the Project Machines list reference; those source images are not verification evidence for this implementation.

## Scope

No changes to `docs/development-plan.md`; no P4c work; no changes to Worker or capability behavior. UI scene verification used port 3099. No server was started on port 3000.
