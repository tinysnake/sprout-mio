# P4b Human feedback: navigation and Machine lease list

Status: implementation committed; independent integration reported and fixed a typecheck regression. Demo browser scenes pass; the real route integration currently fails at the new Machine lease list assertion in an independently checked-out commit. No merge performed.

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
- Ran `scripts/verify/z-lease-integration.sh` from the independent checkout: failed at `Machine details show the Project × Machine lease list` (`0 !== 1`). This checkout's current source was later checked at `0fcbdba`, which predates the feature, so it is not valid evidence for the intended feature. The real route path, back/forward, direct-open fallback, and refresh remain unverified; run this integration against a checkout that includes the fix commit.
- P4a scripts are not required because this unit changes neither Worker behavior nor capability shapes.
- P4a scripts are not required because this unit changes neither Worker behavior nor capability shapes.
- Cross-machine networking and physical-device soft keyboard remain unverified, consistent with the chapter's existing limits.

## Screenshot review

Reviewed `/tmp/p4b-fb-review/vision-findings.md` and the four supplied images: `fb1-project-count.png`, `fb3-unnecessary-button.png`, `fb6a-mobile-lease.png`, and `fb6b-settings-list.png`. The list design follows the Project Machines list reference; those source images are not verification evidence for this implementation.

## Scope

No changes to `docs/development-plan.md`; no P4c work; no changes to Worker or capability behavior. UI scene verification used port 3099. No server was started on port 3000.
