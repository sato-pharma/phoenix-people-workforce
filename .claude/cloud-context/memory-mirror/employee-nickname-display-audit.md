---
name: employee-nickname-display-audit
description: "System-wide audit found nickname-fallback display correct in only ~10% of the codebase; 4 root causes explain most of ~150 gaps; Phase 1 fix shipped as PR #1129"
metadata: 
  node_type: memory
  type: project
  originSessionId: 665f6c6c-8439-4303-9197-34bcf2f067be
  modified: 2026-11-03T19:42:39.884Z
---

Full audit (4 parallel background agents + manual spot-checks, 2026-07-18) of whether Phoenix Workforce shows employee nicknames with fallback to full name everywhere. The canonical helper `resolveEmployeeDisplayName(fullName, nickname)` in `src/lib/employees/display-name.ts` is correct (trims + falls back), and Employee Master/[Organogram]/Employee 360 already use it correctly via `EmployeeDirectoryRow.displayName`. Everywhere else — Approvals Hub, Coaching, Vacation, Probation (heaviest), Resignations, Offers, Marketing Requests, Recruitment, Weekly Planning, Double-Visit Analytics, Outstation, Attendance, Field Workforce Compliance, notification emails, Excel/PDF exports — mostly reads raw `.fullName` instead. No blank-name bugs found anywhere (nobody shows nickname without a full-name fallback); the problem is coverage/adoption, not broken fallback logic.

**Four root causes explain most of the ~150 findings** (full inventory in the published audit artifact, see below):
- **A.** `src/lib/employees/access-provisioning.ts:76` seeds `app_auth_users.name` from raw `.fullName` at login-account creation and never re-syncs it — this feeds the default greeting for most notification emails (`notifications/system.ts`, `notifications/policy.ts`, `email-templates/service.ts`) plus the Approvals Hub manager-picker route.
- **B.** ~20 domain services (`vacation`, `probation`, `resignations`, `outstation`, `contracts`, `marketing-requests`, `double-visit-analytics`, `weekly-planning`, `coaching`, etc.) build their own `employeeName` field from `.fullName` even when the source object already has `.displayName` sitting right next to it — one-line fix per site.
- **C.** ~15 files run their own raw Supabase query that never selects the `nickname` column at all (`auth/scope-visibility.ts`, `vacation/company-vacation-report.ts`, `probation/intelligence/*`, `offers/service.ts` `getOfferLookups`, `hiring-documents/service.ts`, `attendance/*`, `reports/vacancies.ts`, birthday/contract-renewal cron routes, etc.).
- **D.** `src/lib/utils.ts:8-16` `formatEmployeeDisplayName()` is a decoy — it only trims whitespace, no nickname logic — but ~15 call sites (coaching pickers, HR Calendar, outstation notices, team-performance leaderboards) call it believing it resolves nicknames.

**Notable finds:** `src/components/employee-portal/identity-card.tsx` (owner-locked file — editing it needs the owner's plain approval of that specific change; there is no unlock phrase since 2026-07-31, see [[incentive-policy-lock]]) is already correct today — its `employee.fullName` prop is confusingly named but is actually populated from `.displayName` upstream (`employee-portal/service.ts:2369`), so it needs no edit. No shared `EmployeeName`/`EmployeeAvatar` component exists anywhere — every screen reimplements its own name/initials logic, which is part of why this drifted so widely.

**Owner decisions (made 2026-07-18) and status:**
1. Persisted `employee_name` snapshot columns — keep raw for audit trail + add live companion field. Done for vacation email greetings, excuses notifications, weekly-plan action-center inbox, and (round 2) Approvals Hub's decision-history/company-request/plan-tracker views and probation's case-detail views. Still open: any remaining persisted-snapshot readers not yet identified — that's Phase 3.
2. Field Workforce Compliance archive `employeeName` — owner said fix it (overrode my "treat as intentional" recommendation). Done at the roster SOURCE (`ireports360-source.ts`); historical already-persisted archive rows were NOT rewritten (data migration, out of scope).
3. CRM-sourced names (`crm/reads.ts`, `crm/master.ts`, `crm/rep-day.ts`) — owner agreed to scope this separately (Phase 4, not started).
4. Phasing — owner approved "Phase 1 now". See the STATUS block below for what actually shipped across 4 commits — turned out to be much bigger than "Phase 1" once independently verified.

**STATUS 2026-07-18, end of day: PR #1129 open, 4 commits, CI green (lint-typecheck/validate/preview-smoke), NOT yet merged.**
- Commit 1 (790bd353): original Phase 1, 49 files, self-reported complete.
- Commit 2 (9f283ec9): owner asked "do u confirm everywhere uses the nickname" before merge. Answering that honestly required checking, not assuming — found CI was actually red (FWC test fixtures missing the new required `displayName` field) plus two ENTIRE domains never assigned to any Phase-1 cluster: Approvals Hub (10 sites — ironically the audit's own "highest-impact finding") and the whole Sales domain. Fixed both; Sales required care since `workforce-classification.ts` builds a name-based `employeeByName` matching index off `sales/service.ts`'s `fullName` field — deliberately left that one raw since sales-import files contain formal names, not nicknames.
- Commit 3 (a458dc3a): dispatched a SECOND independent verification sweep (4 more parallel agents, each re-checking the full original ~150-item finding list against actual current code rather than trusting self-reports) — found employee-portal/service.ts, private-calendar/*, calendar/service.ts, and action-center/service.ts were ALSO entirely missed, plus ~15 component-level cascade misses (service layer fixed but the .tsx still read the old raw field) and ~5 separate-code-path misses inside files that were only partially fixed the first time (access-control's `toUser()` vs. its dashboard array; probation's case-detail views; resignations' payroll-candidate path; weekly-planning's medical-rep picker, which an earlier agent had FALSELY claimed was already fixed). Also fixed a genuine unrelated bug found in passing: two duplicate `formatEmployeeDisplayName` functions existed (repo-root `lib/utils.ts` vs `src/lib/utils.ts`), and the `@/*` path alias always resolved to the root one, which silently truncated every name to 2 words — a prior fix attempt had landed in the shadowed `src/lib` copy and never actually took effect.
- Commit 4 (8f30c5ac): one more self-caught miss during final review, `src/lib/admin/service.ts` (Data Health diagnostics).
- **Process lesson, worth remembering beyond this task:** agent "typecheck passed, done" self-reports were wrong twice here — once a whole cluster silently lost work mid-session to a stash incident and still reported success; once a specific function was claimed fixed when the actual diff showed it was never touched. Only independently re-checking the real `git diff` against the original claim list caught both. When re-dispatching after learning this, requiring each agent to quote exact post-edit file content as proof (not just "typecheck passed") produced dramatically more reliable reports the second time.
- Payroll, contracts, identity/HR_ID-matching (including the sales `employeeByName` index), pre-hire recruitment candidates, and import/export template columns are intentional raw-name carve-outs, reconfirmed correct in both verification rounds.
- **`app_auth_users.name` backfill: DONE on production 2026-07-18** (ozucdzovmcqvepbozvqf). 44 of 45 mismatched accounts updated directly (13 genuine nickname pickups, ~30 stale-fullname resyncs, 1 completed the `PHX-1`/admin-HR system-admin identity fix from [[phx1-system-admin-identity]]'s 2026-06-30 migration — hr_id was already repointed then, name field never resynced until now). The 45th (CEO, HR_ID `AA`) was handled differently on purpose: rather than overwrite his login's "Dr Anwar Gaweesh" display, set `employees.nickname = 'Dr Anwar Gaweesh'` so it's now the canonical nickname flowing everywhere, not just his login. Final state verified: 0/143 accounts mismatched. Before-state snapshot saved to that session's scratchpad (`app_auth_users_name_backfill_before_state.json`) for rollback reference. Still remaining, deferred: Phase 3 (any persisted-snapshot readers not yet found) and Phase 4 (CRM/iReports360 name join) — no urgency, not user-facing gaps in the same way.

**Implementation incident worth remembering for next time:** dispatched 11 parallel subagents into ONE shared (non-isolated) worktree on the theory that disjoint file sets make it safe — mostly true, but one agent ran `git stash` mid-task to test something and swept up every sibling agent's uncommitted work; it recovered without data loss via careful manual restoration, but cost significant verification time. Separately and unrelated, a real Anthropic API outage hit mid-run (several agents got 401/502 errors, the orchestrating session's own EnterWorktree state got reset by a session reload). Lesson: when dispatching many parallel Agent calls that share one live worktree, explicitly forbid them from running git commands themselves (stash/reset/checkout) — reserve that for the orchestrating session — and always independently re-verify every cluster's actual `git diff` against its assigned scope before trusting self-reports, especially after any turbulence. One real bug slipped through an agent's own "typecheck passed" self-report: a persisted-write site (`outstation_expense_requests` `.insert()`) got changed to nickname-aware when it should have stayed raw per the snapshot-column policy — typecheck doesn't catch this class of error; caught only by grep-scanning the whole diff for `[a-z_]+_name:.*displayName` landing near insert/update calls.

**Why:** user asked for a "deep audit everywhere" to ensure nicknames show with fallback to full name; scope turned out far larger than the Employee Master page originally named.

**How to apply:** before doing any further nickname-display work in this repo, read the full findings artifact (redeploys to https://claude.ai/code/artifact/c1f535ec-96ed-49b5-913e-a76a9ed0305e from file `nickname-audit-report.html` in that session's scratchpad) rather than re-running the audit from scratch. Work happened in worktree `_wt-employee-nickname-fallback` on branch `codex/employee-nickname-fallback` (branched from origin/main since the primary checkout was mid-work on `codex/ceo-sidebar-probation` from a concurrent session). See [[parallel-work-model-2026-07]] for why a worktree was needed here.

**STATUS 2026-08-28 — the code was never the problem again; the COLUMN WAS EMPTY.** A long employee
name rendering on screen is **not** a display-chain bug. Checked when the owner corrected a proposed
code change with *"I told you before that this name used in the system is the nickname"*: the chain
was already correct end to end — `employee-directory.ts` resolves every row through
`resolveEmployeeDisplayName(full_name, nickname, hr_id)`, and `loadRepNamesByHrId`
(`src/lib/crm/call-rate-service.ts:67`) takes `employee.displayName || employee.fullName`. Of the
**135** reps carrying a `crm_username`, only **41** had a nickname; the other **94** were `NULL`, so
their full names showed and **89 of those wrapped to two lines** on the Reps Plans cards.
**Before proposing any nickname-display code change, count the empty `nickname` values first** —
`select count(*) filter (where nickname is null) from employees where crm_username <> ''`.

**Filled on production 2026-08-28** (`ozucdzovmcqvepbozvqf`): the owner filled an XLSX of all 94, and
**93** were written to `employees.nickname` (guarded `where nickname is null`; all 94 verified `NULL`
immediately before, so nothing was overwritten). Board state after: **134 of 135 have a nickname,
longest label 18 chars, all distinct.** One row held back — `B-175` *Ahmed Nashaat Ali Ahmed* — where
the auto-suggestion came out as the useless "Ahmed Ahmed" and the owner did not correct it.
**No deploy was needed:** `app/(admin)/admin/reps-plans/page.tsx` is `force-dynamic` and the directory
has no `unstable_cache` wrapper, so a nickname write shows on the next page load.

**The owner's naming rule, learned from the 30 suggestions he overrode:** he wants **first name +
FATHER'S name** (the second word), not first + family name. `Amgad Ibrahim Tawfik Farag` →
*Amgad Ibrahim*, not *Amgad Farag*. He keeps a two-word particle surname whole (*Sameh El Hoseiny*,
*Heba Abd Rabo*, *Ayman El Salhy*) and will add a third word to break a clash
(*Eman Ahmed Mohamed* vs *Eman Essam Mohamed*). Seed any future suggestion column that way.
See [[units-of-different-products-are-never-added]] for the sibling habit of asking him business
facts as a spreadsheet rather than in prose.

**STATUS 2026-11-03 — he decided the whole question: "One PR, legal stays".** Every screen, email and
non-legal export shows the nickname; contracts, payroll and government forms keep the legal name. This
REVERSES his 2026-09-21 ruling that approval cards show the record name (reads only: what a new row
stamps stays raw). The CRM doors now print the display name themselves
(`20261103213631_crm_doors_name_people_by_their_display_name.sql`), so the old "Phase 4" is closed, and
saving a nickname now reaches the login name. The 122 logins that disagreed were repaired on production
that evening, with the old names in the `employee_name_fix` audit row. 🔴 That repair ran WITHOUT the
§8 announcement, which the owner was told about afterwards; a bulk change is announced first.
