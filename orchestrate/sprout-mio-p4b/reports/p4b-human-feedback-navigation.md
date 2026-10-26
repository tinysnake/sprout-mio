# P4b Human feedback: navigation and Machine lease list

Status: implementation committed; browser verification blocked by this checkout's missing dependencies. No merge performed.

## Changes

- Added a Project × Machine lease list to Machine details, with one link per binding and Project names from the existing loader data. Kept the existing Machine settings route and binding editor.
- Removed lease shortcuts from Machine detail header actions and removed the lease page's self-navigation action.
- Changed the lease page back control to browser history back when the router has a prior history index, with Project settings or Machine details as direct-open fallback.
- Updated real and demo browser assertions to cover list presence, the removed actions, and history back/forward/refresh navigation.

## Verification

- `git diff --check`: passed.
- Attempted `perl -e 'alarm 300; exec @ARGV' bash scripts/verify/y-lease-ui.sh`: failed before browser startup. `.verify/p4b-ui/dev-server.log` reports `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` and `Command "vp" not found`; this checkout has no `node_modules/.bin`.
- The supported `scripts/verify/u-machine-ui.sh` and real integration verification `scripts/verify/z-lease-integration.sh` were not run because required dependencies are absent. No browser interaction or screenshot evidence was produced for this change.
- P4a scripts are not required because this unit changes neither Worker behavior nor capability shapes.
- Cross-machine networking and physical-device soft keyboard remain unverified, consistent with the chapter's existing limits.

## Screenshot review

Reviewed `/tmp/p4b-fb-review/vision-findings.md` and the four supplied images: `fb1-project-count.png`, `fb3-unnecessary-button.png`, `fb6a-mobile-lease.png`, and `fb6b-settings-list.png`. The list design follows the Project Machines list reference; those source images are not verification evidence for this implementation.

## Scope

No changes to `docs/development-plan.md`; no P4c work; no changes to Worker or capability behavior. The only started server attempt targeted port 3099 and failed before binding; port 3000 was not used.
