# Employee Portal — Launch-Readiness Remediation Plan

> **⚠️ ARCHIVED — historical record.** This is a completed, point-in-time planning and verification artifact from 2026-05-28. It is retained for reference only and is not a current operating document. Branch names, deployment URLs, and verification notes reflect the state at that time.

> **Status:** Reviewed and corrected against the local checkout **and** live Supabase + Vercel state on 2026-05-28.
> **Nature of this document:** Planning + verification only. It changes no code, SQL, RLS, navigation, or deployment. Nothing here has been applied.
> **Evidence tags:** every claim is tagged **[repo]** (local checkout), **[github-cli]** (GitHub API via authenticated `gh` CLI), **[supabase]** (live Phoenix HR project `ozucdzovmcqvepbozvqf`), **[vercel]** (project `phoenix-workforce`), or **[unknown]** (could not verify).
> **GitHub facts** in this document were gathered via the authenticated **`gh` CLI** (account `Phoenix-HR`, scopes `repo`/`workflow`/`read:org`) and are tagged **[github-cli]**.

---

## 1. Executive Summary

| | |
|---|---|
| **Current user/product readiness** | ~7.6 / 10 |
| **Current launch readiness** | ~6.4 / 10 |
| **Target after remediation** | 8.3+ / 10 (controlled, company-wide) |
| **Launch decision** | **Conditional GO** — launch the Core 8 only, *after* the one hard blocker (below) is closed and the QA gate passes. **No-go** until then. |

**Hard blocker (must fix before any announcement):**
- **[supabase]** `public.employee_support_requests` has **RLS disabled, 0 policies** — Supabase security advisor raises a critical **ERROR** (`rls_disabled_in_public`). It is the **only** RLS-disabled portal-owned table. Closing it is Workstream 1.

**Core 8 modules to announce (all [repo]-verified to exist):**
1. **Dashboard** — `app/employee-portals/page.tsx`
2. **Sales / Performance** — `app/employee-portals/sales/page.tsx`
3. **Incentive** — `app/employee-portals/incentive/page.tsx`
4. **Payslips / Earnings** — `app/payslips/page.tsx`
5. **Expenses** — `app/employee-portals/expenses/page.tsx`, `expense-dashboard/page.tsx`, `submit-expense/page.tsx`, `app/employee/outstation/new/page.tsx`
6. **Leave** — `app/leave-management/vacation-request/page.tsx`, `vacation-report/page.tsx`
7. **Outstation** — outstation expense surfaces (above) + `app/employee-portals/team-expenses/page.tsx`
8. **Coaching / Notifications** — `app/employee-portals/coaching/page.tsx`, `training-manager/**`

**Beta / deferred (kept reachable by direct URL, gated out of launch nav):**
- Marketing Requests — `app/employee-portals/marketing-requests/page.tsx`
- HCP / PH Validation — `marketing-requests/validation/page.tsx`
- Marketing Control — `marketing-requests/control/page.tsx`
- SCP / PH Database — `marketing-requests/customer-database/page.tsx`
- **Contact HR Support** — `contact-hr-support/page.tsx` — deferred from launch **unless** support RLS *and* the HR-side resolution workflow are both ready (see Workstream 2 recommendation).

**Must be true before the company announcement:**
1. WS1 applied on the correct (production) Supabase project; advisor ERROR for `employee_support_requests` cleared; direct JWT probe returns zero foreign rows.
2. Real profile page live (no redirect stub); My Profile link already present.
3. Marketing + (per recommendation) Support gated out of the **employee-portal** navigation at the correct layer (see §6 correction).
4. WS7 role/device walkthrough passes with no cross-employee data exposure.
5. `lint + typecheck + test + build` all green; Supabase advisors show no *new* critical RLS errors; Vercel preview smoke clean; public alias verified post-promote.

---

## 2. Corrected Findings

| # | Finding | Original plan statement | Verified truth | Source | Correction | Priority |
|---|---|---|---|---|---|---|
| F1 | `employee_support_requests` RLS | "Enable RLS + policy" | RLS **disabled**, **0** policies; advisor **ERROR** `rls_disabled_in_public`. Sole RLS-disabled portal table. Service access is **service-role only** (`src/lib/support-requests/service.ts:96,135` use `getSupabaseAdmin()`). | **[supabase]** + **[repo]** | Confirmed hard blocker. Fix = enable RLS + **deny-by-default service-role policy** (mirrors `job_offers`), not a self-scoped policy. | **P0 blocker** |
| F2 | Other 4 "missing RLS" tables | "Enable RLS on all five tables" | **All four already have RLS enabled.** `employee_compensation` (7 policies); `payroll_expenses` (4 scoped); `payroll_expense_reports` (4 scoped); `job_offers` (RLS **FORCEd**, 1 service-role policy = deny-by-default). | **[supabase]** | **Do not** re-enable or rewrite. Audit-only at the §10 gate. | P3 verify-only |
| F3 | Profile route | "Replace redirect stub" | `app/employee-portals/profile/page.tsx` was a `redirect(...)` stub; building blocks (`getEmployeePortalShellData`, `IdentityCard`, `EmployeePortalPageShell`) all exist. | **[repo]** | Build real read-only page. | P1 |
| F4 | **Navigation source** | "Source is `system-navigation.ts` consumed by `sidebar.tsx`" | **WRONG for the portal.** The employee portal renders via `app/employee-portals/layout.tsx` → `EmployeePortalServerShell` → `EmployeePortalChrome` (`employee-portal-layout.tsx`), whose menu is built by **`buildEmployeePortalSections()`** from visibility flags in **`src/lib/employee-portal/navigation.ts`** (`resolveEmployeePortalNavVisibility`). `system-navigation.ts` + `sidebar.tsx` is the **admin** surface and does **not** drive `/employee-portals/*`. | **[repo]** | **Gate at `navigation.ts` / `buildEmployeePortalSections()`.** (The user's "known correction" was right.) | **P1 (correctness)** |
| F5 | My Profile link | "Must be added to nav" | **Already exists** — `employee-portal-layout.tsx:534-542`, user dropdown → `/employee-portals/profile` (`UserCog`). | **[repo]** | Keep the link; only the route target needs to become real (F3). No nav-add work. | P3 (none) |
| F6 | `portal-top-nav.tsx` | Referenced by original plan | **Does not exist.** | **[repo]** | Do not reference it. | n/a |
| F7 | NSM role check | "Use `.includes(...)`" pattern | 3 portal pages use `access.role.toLowerCase().includes("national sales manager")`. `normalizeRole()` exists in `permissions.ts`. | **[repo]** | Add `isNationalSalesManager()` helper; fix only the 3 launch-critical pages. | P2 |
| F8 | Silent empty states | "Add logging" | Multiple portal catch sites swallow errors → generic empty state with no log. **Most important:** `EmployeePortalServerShell` (`employee-portal-server-shell.tsx:27-29`) catches and renders "Portal Unavailable" with no log — this is the shell every portal page passes through. | **[repo]** | Add a **PII-safe** structured log at each catch site. | P2 |
| F9 | Scope labels | "Add scope chip" | `access.scope` resolved but never surfaced; no `ScopeBadge` exists in repo at the verified path until added. | **[repo]** | Add reusable `ScopeBadge`; apply to scoped pages. | P2 |
| F10 | Contact HR Support launch conflict | "Keep CTA to support" | Support is **deferred** Beta; the "Support" section in `buildEmployeePortalSections` (`employee-portal-layout.tsx:180-184`) is **always shown** (no visibility flag). Profile CTA currently deep-links into it. | **[repo]** | Resolve via Workstream 2 Option A vs B (recommendation below). | P1 |
| F11 | Marketing Requests beta status | "Gate via `launchStatus`" | Portal Marketing visibility is controlled by `showMarketingRequestsTab` / `showMarketingControlTab` / `showMarketingCustomerDatabaseTab` flags in `navigation.ts`, **not** `launchStatus`. **[supabase]**: 11 `marketing_*` tables have RLS enabled but **no policies** (deny-by-default; module data layer unfinished). | **[repo]** + **[supabase]** | Gate via the visibility flags; keep Marketing Beta. | P1 |
| F12 | Workload/expense-dashboard "admin leak" | "Blocker" | **False.** `expense-dashboard/page.tsx` passes `adminKeyCards={null}`; rendered conditionally. | **[repo]** | Removed from scope. | none |
| F13 | Vercel deployment readiness | (not in original) | All 14 recent deployments `READY`; prod = `main@3ab7d4ec`; preview = working branch `@da83e067` ("Close employee portal launch security gaps"); preview wired to **read-only production data**. | **[vercel]** | Use preview (read-only data) for WS7 QA; verify public alias post-promote. | info |
| F14 | Extra advisor ERROR | (not in original) | `public.v_unified_audit_logs` is a `SECURITY DEFINER` view (advisor **ERROR**, non-portal). ~15 `current_access_*` definer functions are RPC-callable by `authenticated` (WARN). | **[supabase]** | Out of portal scope; track separately so the §10 "zero critical errors" gate isn't surprised. | P3 (separate) |

---

## 2a. Verification Log (read-only, 2026-05-28)

No migrations, DDL, deployments, or data mutations were performed.

**Connectivity:** **[supabase]** verified (two projects in org: `Phoenix HR`=`ozucdzovmcqvepbozvqf` used here, and `sato.hr2@hotmail.com`=`oaifhavixhdtwmseshff`). **[vercel]** verified (`phoenix-workforce`, repo `Phoenix-HR/phoenix-people-workforce`). **GitHub facts via authenticated `gh` CLI [github-cli].**

**GitHub (via `gh` [github-cli]):** repo `Phoenix-HR/phoenix-people-workforce` (PRIVATE, default branch `main`). Only **one open PR**: #14 (dependabot `tmp` bump → `main`) — **no employee-portal launch PR exists yet**. **CI is green on the preview branch HEAD:** the latest `CI` run on `codex/work-from-production@da83e067` ("Close employee portal launch security gaps") concluded **success** (along with the preceding 5 commits). One older run failed (`e7ee39e`, e2e stabilization) and one was cancelled, both superseded by later green runs.

**Supabase — RLS of the 5 audited tables (live):**

| Table | RLS | Forced | Policies | Verdict |
|---|---|---|---|---|
| `employee_support_requests` | **off** | off | **0** | **Blocker** (advisor ERROR). WS1. |
| `employee_compensation` | on | off | 7 | Safe — no change. |
| `payroll_expenses` | on | off | 4 (scoped) | Safe — no change. |
| `payroll_expense_reports` | on | off | 4 (scoped) | Safe — no change. |
| `job_offers` | on | **on** | 1 (service-role) | Safe — deny-by-default. |

**Supabase advisors (additional):** ERROR `security_definer_view` on `v_unified_audit_logs`; INFO `rls_enabled_no_policy` on 11 `marketing_*` tables (deny-by-default, unfinished — corroborates Marketing=Beta); WARN ~15 `current_access_*` SECURITY DEFINER functions RPC-callable by `authenticated`; WARN Supabase-Auth leaked-password protection off (**low relevance** — Phoenix uses app-managed auth, not Supabase Auth).

**[unknown]:** which Supabase project the production app binds to (`NEXT_PUBLIC_SUPABASE_URL` is a secret) — **must confirm before applying WS1**; public-alias→deployment mapping (verify post-promote).

---

## 2b. Status of already-applied working-tree changes (must read before execution)

During an earlier session, edits were applied to the working tree (uncommitted) and a separate Sentry/observability change set was split out into `git stash@{0}`. Relative to **this** verified plan:

- ✅ **Correct & keep:** `permissions.ts` (`isNationalSalesManager` + `support_requests` resource), the 3 NSM page fixes, `scope-badge.tsx`, the real `profile/page.tsx`, and `contact-hr-support/page.tsx` permission tightening to `support_requests:read`.
- ⚠️ **Wrong layer — needs redo:** the nav-gating edit to `src/config/system-navigation.ts` + `src/components/layout/sidebar.tsx` gates the **admin** sidebar, **not** the employee portal (F4). It will **not** hide Marketing/Support in the portal. The real gating belongs in `src/lib/employee-portal/navigation.ts` / `buildEmployeePortalSections()`. Recommend reverting those two files and re-doing per Workstream 4.
- ⚠️ **Depends on decision:** `profile/page.tsx` ships a **clickable** "Request an HR update" CTA into Contact HR Support. If Workstream 2 **Option A** is chosen (recommended), this should become a **non-clickable** note until Support launches.

---

## 3. Workstream 1 — Portal RLS & Support Security Closure

> **Status (2026-05-28): DRAFTED, NOT APPLIED.** Migration file created in the repo at
> `supabase/migrations/20260528093000_employee_support_requests_rls.sql`. Re-verified read-only against the `Phoenix HR` project (`ozucdzovmcqvepbozvqf`): `employee_support_requests` RLS **off**, **0** policies, advisor **ERROR** `rls_disabled_in_public` present. **Not applied to any project; no production data mutated; not committed; not deployed.** Apply on a Supabase branch/preview only after confirming the production project binding via `NEXT_PUBLIC_SUPABASE_URL`.

**Goal:** close the single hard blocker without weakening any boundary. **No production SQL is executed by this plan** — it drafts the migration and prescribes branch/preview testing.

### Design (surgical)

- **[supabase]-confirmed** `employee_support_requests` RLS is off with 0 policies; **[repo]-confirmed** the service uses `getSupabaseAdmin()` only. Therefore the correct fix is **enable RLS + a service-role-only policy (deny-by-default)** — mirrors `job_offers`. This closes the anon-key exposure with **zero functional risk** to the app.
- **Do not** build a self-scoped (`hr_id = current user`) read policy: the production `private.phx_*` helpers resolve identity from `auth.uid()` (Supabase Auth), but Phoenix uses **app-managed auth**, so anon/authenticated requests carry no `auth.uid()`. A self-scoped policy would not function. Only add authenticated-client policies if/when support reads are intentionally moved off the service-role path **with a working identity source** (out of launch scope).
- **Audit-only** for `employee_compensation`, `payroll_expenses`, `payroll_expense_reports`, `job_offers` — **[supabase]** shows RLS already on with policies. Review policy/grant adequacy; **do not** rewrite.

### Draft migration (review-only; do not apply from here)

`supabase/migrations/<YYYYMMDDHHMMSS>_employee_support_requests_rls.sql`:

```sql
alter table public.employee_support_requests enable row level security;

drop policy if exists phx_employee_support_requests_service_role
  on public.employee_support_requests;

create policy phx_employee_support_requests_service_role
  on public.employee_support_requests
  for all to service_role
  using (true) with check (true);
```

Idempotent and reversible (`drop policy` + `disable row level security`).

### Permission tightening (already applied; keep)

`contact-hr-support/page.tsx` enforces `support_requests:read` (resource added to `permissions.ts`). Additive only.

### Acceptance criteria

- `employee_support_requests`: RLS enabled; advisor ERROR cleared.
- App support flows still work via service-role (open/list ticket) — no regression.
- The 4 audited tables remain unchanged and clean in advisors.

### Verification commands

- **[supabase] pre-flight:** confirm production project ref via `NEXT_PUBLIC_SUPABASE_URL` before applying.
- Apply on a **Supabase branch/preview**, then:
  - `select relname, relrowsecurity from pg_class where relname='employee_support_requests';` → `t`.
  - Direct JWT probe (non-service-role): `select * from public.employee_support_requests where hr_id <> '<self>';` → **0 rows**.
  - Re-run security advisors → ERROR gone.

---

## 4. Workstream 2 — Real Employee Profile Page

Replace the redirect stub with a read-only page. **Reuse [repo]-verified building blocks:** `getEmployeePortalShellData()` (`service.ts`), `IdentityCard` (`identity-card.tsx`), `EmployeePortalPageShell`/`EmployeePortalEmptyState` (`enterprise-shell.tsx`), `ScopeBadge` (WS6).

**Sections:** identity • HR ID • job title • role • manager • line • area • department • hire date • contract signed • renewal date (+ days) • probation status • payroll eligibility • service duration • residence/contact *if present in shell data* • **data-completeness note** for any "Not available" fields. All read-only.

**Guards:** `force-dynamic`; non-portal mode → `/overview`; `assertPermission(access,"employee_profile","read")`; the data-load `catch` **logs** (WS5) before the empty state.

### Contact HR Support conflict — Option A vs B

- **Option A (recommended for launch):** Gate Contact HR Support **out** of the portal nav and render a **non-clickable** "Contact HR to update this information" note on the profile. **Why:** Support is Beta — WS1 closes its RLS hole, but the HR-side resolution **workflow** is not part of this launch. Shipping a live CTA into a half-ready workflow risks unanswered tickets. Lowest-risk, fully launchable now.
- **Option B:** Keep the "Request an HR update" CTA live. **Only choose** once *both* WS1 RLS **and** the HR resolution workflow are confirmed ready. Flip A→B is a one-line change later.

**Recommendation: Option A** for the controlled launch; revisit B when Support graduates from Beta.

---

## 5. Workstream 3 — Strict Role Helpers

- Add **`isNationalSalesManager(role)`** to `permissions.ts` (`normalizeRole(value) === "National Sales Manager"`). *(Already applied — keep.)*
- Optional **only if they remove real duplication without a broad refactor:** `isDistrictManager(role)`, `isTrainingManager(role)`. Do not add speculatively.
- Fix only the 3 launch-critical pages (already applied — keep): `team-expenses`, `med-reps-performance`, `dsms-performance`.
- **Do not** sweep the ~16 other `.includes()` files in this launch.
- **Tests:** truth table for `isNationalSalesManager` (canonical + `nsm`/`NSM` aliases → true; all else → false), wired into `tests/run-tests.ts`.

---

## 6. Workstream 4 — Launch Navigation Gating (corrected source)

**Verified source [repo]:** the employee portal menu is built by `buildEmployeePortalSections()` in `src/components/employee-portal/employee-portal-layout.tsx`, from visibility flags returned by `resolveEmployeePortalNavVisibility()` in `src/lib/employee-portal/navigation.ts`. **`system-navigation.ts`/`sidebar.tsx` is the admin layer — do not gate the portal there.**

**Gate for launch (at the correct layer):**
- **Marketing (all 4 items):** force `showMarketingRequestsTab`, `showMarketingControlTab`, `showMarketingCustomerDatabaseTab` to `false` for launch — simplest is a single launch flag in `navigation.ts` (e.g. `PHOENIX_PORTAL_SHOW_BETA_NAV`) OR'd into those flags. They are already role-gated; the launch flag forces them off regardless of role until ready.
- **Contact HR Support (Option A):** the "Support" section in `buildEmployeePortalSections` is currently unconditional (`employee-portal-layout.tsx:180-184`); gate it behind the same launch flag.

**Approach guidance:** prefer a **simple launch/beta flag + flag-driven visibility** over introducing a `launchStatus` enum — it fits the existing flag-based structure. Pages stay reachable by direct URL (each is independently permission-guarded server-side). **Revert** the earlier `system-navigation.ts`/`sidebar.tsx` edit (wrong layer, §2b).

### Beta navigation flag — `PHOENIX_PORTAL_SHOW_BETA_NAV` (implemented)

The launch flag is **server-side** and read at call time by `isEmployeePortalBetaNavEnabled()` in `src/lib/employee-portal/navigation.ts`. It is the single switch that controls whether Beta modules appear in the Employee Portal navigation.

```bash
# Preview / staging only — when testing Beta modules:
PHOENIX_PORTAL_SHOW_BETA_NAV=true

# Production (Core 8 launch) — leave UNSET (equivalent to false):
# PHOENIX_PORTAL_SHOW_BETA_NAV   (not set)
```

**Operating rules:**
- **Leave it unset/`false` in production** for the Core 8 launch.
- **Use `true` only in preview/staging** when testing Beta modules.
- It controls **Employee Portal navigation visibility only** — it changes which links render in the portal menu, nothing else.
- It **does not remove pages.** Every Beta page stays reachable by its direct URL.
- It **does not weaken page-level guards.** Each page keeps its own server-side guard (e.g. `contact-hr-support` → `assertPermission(access, "support_requests", "read")`; Marketing → `assertEmployeePortalMarketingPageAccess`).
- It **does not grant unauthorized access.** The flag is AND-ed with the existing role checks, so enabling it never surfaces a module to a role that was not already authorized for it (e.g. Training Manager still sees no Marketing).
- **By default (flag off), Marketing (Marketing Requests, HCP / PH Validation, Marketing Control, SCP / PH Database) and Contact HR Support remain hidden** from the portal navigation.

**Behavior matrix:**

| Module | Flag unset/`false` (production) | Flag `true` (preview/staging) |
|---|---|---|
| Marketing Requests / HCP·PH Validation | hidden | visible to authorized roles only |
| Marketing Control | hidden | visible to authorized roles only |
| SCP / PH Database | hidden | visible to authorized roles only |
| Contact HR Support | hidden | visible (Option A note stays non-clickable on profile) |
| Core 8 modules | visible to correct roles | visible to correct roles (unaffected) |

> **Status:** Implemented and covered by tests in `tests/employee-portal-navigation.test.ts` (Beta hidden by default; Core 8 visible; Beta visible only when the flag is on; page-level guards unchanged).

---

## 7. Workstream 5 — Diagnostic Logging for Silent Empty States

Add a **PII-safe** structured log at each catch site that currently swallows errors and renders a generic empty state. **Never log:** salary amounts, tokens, raw payloads, or sensitive personal data. **Safe to log:** route, module, role, `hrId` (safe actor id), error name/message/classification.

**Logger:** search `src/lib/observability/` & `src/lib/logging/` first; if none suitable, add a small helper `logPortalFailure({ route, module, role, hrId, error })`. *(Note: a `src/lib/observability/sentry.ts` exists only inside `git stash@{0}` from the split-out Sentry effort — not on the working tree; do not assume it's present.)*

**Catch sites to instrument [repo]-verified:** `employee-portal-server-shell.tsx:27` (highest value — the shared shell), `app/employee-portals/page.tsx`, `sales/page.tsx`, `incentive/page.tsx`, `coaching/page.tsx`, `team-performance/page.tsx`, `excuses/page.tsx`, `contact-hr-support/page.tsx`, `profile/page.tsx`, plus any other portal page with a broad `catch {}`. **User-facing UX unchanged.**

---

## 8. Workstream 6 — Scope Badge

Reusable `src/components/employee-portal/scope-badge.tsx` (already created — keep). Labels: `self`=My data, `team`=My team, `hierarchy`=My hierarchy, `line`=My line, `company`=Company, `none`=No scope. **Never render "Company" unless `access.scope === "company"`.**

Apply to scoped pages: Team Performance, Team Expenses, Medical Reps Performance, DSMs Performance, Probation Tracker, Vacancies, Organogram, and Expense Dashboard **only if it shows beyond self**. Label derives purely from `access.scope` — adds no data access.

---

## 9. Workstream 7 — Mobile & Role Walkthrough QA Gate (checklist, no code)

Drive via dev-auth (`GET /api/dev-auth?role=...`, `NODE_ENV=development`). Use the Vercel preview (read-only production data — **[vercel]**) for realism without write risk.

| Role | Devices |
|---|---|
| Medical Rep | iPhone SE + Android mid-size |
| District Manager | tablet + phone |
| National Sales Manager | desktop + tablet |
| Training Manager | desktop + tablet |
| Head Office employee | desktop |

**Per role confirm:** no cross-employee payslip visibility • no salary leakage • no unauthorized sales/expenses/probation/support data • mobile tables/cards don't break • scope badge correct • profile renders • hidden Beta modules (Marketing, Support per Option A) absent from nav • all Core 8 work.

---

## 10. Workstream 8 — Operational Gate

- **[supabase]** advisors: zero **new** critical RLS errors; `employee_support_requests` ERROR cleared. (Pre-existing `v_unified_audit_logs` ERROR tracked separately — F14.)
- Direct JWT probes pass (WS1).
- **[github-cli]** GitHub CI: green on the working-branch HEAD today; re-confirm `gh run list --branch <working-branch>` is `success` on the commit that carries the launch changes before promote.
- `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`. **[repo]** `npm run check:harden` exists (lint+typecheck+test+build) — run it; if it were missing, define it as that chain.
- **[vercel]** preview smoke (all recent builds `READY`); if a build fails, pull Vercel build logs.
- Production alias smoke **only after promotion** — verify `https://phoenix-workforce.vercel.app` directly.

---

## 11. Implementation Order

- **Phase A — Verification-only inventory** (GitHub/Supabase/Vercel). *Use authenticated `gh` CLI [github-cli] for PR/CI; local repo for files.* Confirm production Supabase project binding.
- **Phase B — RLS / Support closure** (WS1) on a Supabase branch/preview; JWT probes.
- **Phase C — Profile + Navigation + Role helpers** (WS2, WS4, WS3) — incl. reverting the wrong-layer nav edit.
- **Phase D — Logging + Scope badges** (WS5, WS6).
- **Phase E — Mobile / role QA** (WS7).
- **Phase F — Release gate** (WS8) → announce.

---

## 12. Acceptance Criteria

**Security acceptance**
- `employee_support_requests` RLS on; advisor ERROR cleared; foreign-row JWT probe = 0.
- No permission/RLS/payroll-visibility/service-role/isolation boundary weakened. The 4 audited tables untouched.

**UX acceptance**
- Real profile renders for every role; My Profile link works.
- Scope badge correct (never "Company" unless truly company).
- Beta modules (Marketing; Support per Option A) absent from portal nav; reachable by URL only.

**Business acceptance**
- Core 8 fully usable across the 5 roles on mobile + desktop.
- Contact HR Support decision (Option A) signed off; profile note non-clickable until Support launches.

**Technical acceptance**
- Nav gating implemented at the **verified** layer (`navigation.ts`/`buildEmployeePortalSections`), not `system-navigation.ts`.
- `isNationalSalesManager` test + nav-gating test green, wired into `tests/run-tests.ts`.
- `check:harden` green; Vercel preview clean; public alias verified post-promote.

---

## 13. Final Execution Prompts (use after approval)

> All prompts: no commit/deploy without explicit approval; verify files via repo before editing; Supabase changes via branch/preview + read-only checks first; Vercel read-only unless told to deploy.

1. **RLS / Support closure — engineering (Supabase, branch/read-only first):** "Confirm the production Supabase project via `NEXT_PUBLIC_SUPABASE_URL`. Draft `supabase/migrations/<ts>_employee_support_requests_rls.sql` enabling RLS + a single `service_role` deny-by-default policy (mirror `job_offers`). Apply on a Supabase branch only; run RLS + foreign-row JWT probe; re-run advisors. Show me before applying to production."
2. **Profile page — engineering (repo):** "Replace the `profile/page.tsx` stub with a read-only page reusing `getEmployeePortalShellData`, `IdentityCard`, `EmployeePortalPageShell`, `ScopeBadge`. Implement Option A: non-clickable 'Contact HR to update' note. Log failures via the WS5 helper."
3. **Navigation gating — engineering (repo):** "Gate Marketing (3 flags) and the Support section behind a launch/beta flag in `src/lib/employee-portal/navigation.ts` / `buildEmployeePortalSections()`. Revert the wrong-layer edits in `system-navigation.ts` + `sidebar.tsx`. Add a test asserting Beta items are absent at launch and present when the flag is on."
4. **Scope badge — engineering (repo):** "Apply `ScopeBadge` to the 7 scoped pages; ensure 'Company' shows only for `company` scope."
5. **Logging — engineering (repo):** "Add the PII-safe `logPortalFailure` helper and instrument the verified catch sites starting with `employee-portal-server-shell.tsx:27`. No salary/token/payload logging."
6. **Role helper cleanup — engineering (repo):** "Keep `isNationalSalesManager`; add `isDistrictManager`/`isTrainingManager` only if they remove real duplication. Add the helper truth-table test."
7. **QA smoke — engineering (Vercel):** "Generate a dev-auth role/device smoke checklist; run against the read-only-data preview; capture cross-employee-exposure results."
8. **Release gate — engineering (Supabase / Vercel, GitHub via CLI):** "Run `check:harden`; re-run Supabase advisors; check GitHub CI; preview smoke; verify public alias only after an approved promote."

---

## Appendix — Out of scope (deferred)

- `v_unified_audit_logs` SECURITY DEFINER view + `current_access_*` RPC-exposed definer functions (separate hardening — F14).
- Full RLS audit of non-portal tables.
- NSM `.includes()` sweep across the other ~16 files.
- Marketing Requests / Contact HR Support feature-readiness (own plans).
- Editable profile fields; self-scoped support RLS with a real identity source.
- Sub-daily notification crons (Vercel Hobby 2-cron limit holds).
