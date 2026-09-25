---
name: portal-launch-readiness-tour-2026-07-30
description: "Full role-by-role employee-portal tour before the 2026-07-30 account rollout — what was verified, the 2 bugs found/fixed, and the launch-day data blockers"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6dea2b2c-ead1-48dd-a7b8-051c0ec075c0
  modified: 2026-08-01T03:46:53.019Z
---

**2026-07-30 deep employee-portal tour** (owner: "take a tour in all emp portal modules, role by role, skip Medical Reps"). Ran against a dedicated worktree `_wt-portal-tour` (branch `codex/portal-final-polish`) on port 3005, webpack (`dev:no-turbopack` — Turbopack corrupted `.next` on a fresh worktree with a `routes-manifest.json` ENOENT loop), notifications neutered via blanked `RESEND_API_KEY`/`BREVO_API_KEY`/`TELEGRAM_BOT_TOKEN` + `PHOENIX_EMAIL_FORCE_TESTING=true`.

**Identity method that actually works for role sweeps:** `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` + per-request `x-phoenix-role` / `x-phoenix-hr-id` headers with `credentials:'omit'`. The dev-auth COOKIE is shared with any other session's browser profile — a stale `Regional Manager` cookie hijacked my first write and filed a vacation request as **B-119 while I was authenticated as B-118**. Never use cookie dev-auth for multi-role work; headers are per-request and cannot race.

**Checker bug worth remembering:** my first `portal-check.sh` only grepped the response BODY for error strings and never looked at the HTTP status, so it printed `err: none` for twenty real HTTP 500s. Any sweep script must flag non-200 status explicitly — a body-only check reports a clean bill of health on a dead page. Found only because a 500 happened to coincide with a byte-size drop I noticed by eye.

**THIRD BUG, found only because the sweep broke — a real regression in #1492 (Team Visits tab, merged 07-30).** `my-visits-workspace.tsx` ("use client") changed `import type { … }` to a VALUE import of `TEAM_VISIT_ROW_CAP` from `my-crm-visits.ts`. A type-only import is erased; a value import creates a real module edge, dragging the server-only chain `my-crm-visits → crm/reads → employee-directory → employee-photo → node:crypto` into the browser bundle. Webpack dev then hard-fails `/employee-portals/visits` with `UnhandledSchemeError: Reading from "node:crypto"` **and poisons the compilation for every route requested afterwards** — 19 of the 20 "failures" I first blamed on my own mid-run merge were actually this. I twice diagnosed it wrong (first "mid-merge artifact", then "self-inflicted, retest passes" — the retest only passed because it hadn't reached /visits yet). **Production is NOT affected** — verified in Cloud Run logs: 8 requests to /employee-portals/visits in the hour before, all HTTP 200, zero 5xx in 24h, because the production Turbopack build tolerates it. So it silently broke ONLY local dev. Fix: `src/lib/employee-portal/my-crm-visits-constants.ts` holds the cap, `my-crm-visits.ts` re-exports it, the client imports from the constants module. Guard added in `tests/crm-visits-self-scope.test.ts` asserting the client never value-imports the server module. **Lesson: a client component value-importing anything from a server module is a latent dev-build bomb; `import type` is the safe form. And when a route poisons the compiler, every LATER failure is collateral — bisect to the FIRST failing route, don't read the tail.**

**Verified clean:** 213 of 233 portal page loads across RM/NSM(x2)/PM/GPM/MM/TM/TA/Manager/Employee + DSM returned 200 with no error markers; the other 20 were the self-inflicted build breakage above. Approval gates all hold (cross-manager approve 403, self-approve 403, state-machine rejects `manager_approve` from `manager_returned`). 7 cross-scope Employee-360 probes all denied. No raw salary columns in any payslip payload. Full onboarding path proven end-to-end on a throwaway identity (employee `ZZ-TOUR` + `zz.tour.check`, both deleted): setup-link → weak-password reject → mismatch reject → set → **token single-use enforced** → wrong-password 401 → login → portal renders → heartbeat → logout clears session. A brand-new zero-data user renders all 11 of their pages with honest empty states.

✅ **ALL THREE FIXES SHIPPED — do not "recover" them.** PR **#1539** ("fix(portal): unbreak the dev
build, hide an always-empty approvals hub, and fix cancellation notices"), merge commit `53974081`,
merged 2026-08-01T01:19:38Z, **live on production** (ancestor of `9520c599`). On main:
`notifyManagerPlanCancelled` at `src/lib/weekly-planning/service.ts:1511`, the `showActionsTab` gate
at `src/lib/employee-portal/navigation.ts:536`, and `src/lib/employee-portal/my-crm-visits-constants.ts`
— each with its own guard test.
**The trap that made this look lost:** `codex/portal-final-polish` is absent from local AND remote, so
it reads as never-shipped. The repo sets `delete_branch_on_merge: true` — a missing branch is the
NORMAL post-merge state, not evidence of lost work. Check `gh pr list --head <branch> --state all`
before attempting any reflog/dangling-object recovery. See [[stale-checkout-verify-against-origin-main]].

**The two portal bugs, as originally found (in `codex/portal-final-polish`):**
1. **Cancelling a weekly plan told the manager it "needs manager review".** `cancelEmployeePlan` called `notifyManager()`, whose payload is hardcoded to the submission copy (`eventType: "plan_submitted"`). Added `notifyManagerPlanCancelled()` with `eventType: "plan_cancelled"`. The manager's stale bell item already auto-archives correctly (`archiveStaleApprovalNotifications` drops it once the plan leaves `awaiting`), so only the false NEW notice was broken.
2. **Plain Employees saw an "Approvals Hub" nav section.** `showActionsTab` was a denylist that let the `Employee` role through; the matrix grants that role no `approve` action anywhere and all 9 Employee-role users have 0 direct reports. **Gate on BOTH resolved portal role AND raw access role** — gating on resolved role alone silently stripped the hub from A-3 (job title "Qppv" falls back to portal role Employee but holds a real `Manager` access role). Caught only by diffing behavior against `origin/main` before/after; do that on any `resolvePortalRole` change.

**Launch-day data blockers (owner decisions, not code):**
- **Only 13 of 112 active accounts need a link** — 99 already have passwords. Every send sets `force_password_reset=true` and bumps `session_version` (= signs them out), so *Select-all would log out 99 working users*. Use the **"Setup pending" filter** (#1504) then select-all.
- **4 role/job-title mismatches, all in that 13:** PD-0006 Ahmed Nagy (job District Sales Manager, role Employee), AI-0003 Soaf Atef / CN-0005 Amira Samy / PD-0004 Aya Mohamed (job Medical Representative, role Employee). They will set a password and land in the wrong portal with wrong permissions.
- **2 people have no mailbox anywhere** (AI-0003, PD-0006) — copy-mode link only. (PHX-1 is the system account.)

**Superseded during the session by a parallel session — check before re-reporting:** #1503 (password links now resolve `employees.work_email`, sendable 2/112 → 109/112), #1501 (bulk send), #1504 (Setup-pending filter), #1481 (stop logging expected Forbidden denials as ERROR — was my finding #4). All were merged AND deployed today: prod revision `phoenix-hr-00720-xez` was built from `50a9c1ba` and serves 100% traffic. **The Resend 100/day cap is a non-issue for this rollout** — only 13 emails needed.

Related: [[bulk-setup-link-send]], [[resend-daily-100-cap-429-outage]], [[local-env-already-points-at-production]], [[local-browser-verify-gotchas]], [[prod-deploy-scheduled-not-on-push]], [[adoption-is-the-gap-not-features]].
