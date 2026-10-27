---
name: double-visit-skips-the-downward-rule
description: "Double-visit analytics downward-scope rule — SHIPPED 2026-09-13 in PR #3802 after three parked attempts on 09-11. Owner decision 13 settled the totals fork: out-of-scope visitors' rows are hidden from totals too. PM/GPM/RM boards shrink by design (rank ladder); UNRANKED visitors are SHOWN on PM/GPM/RM boards by the owner's 09-13 answer (PR 3807), while coaching and doctor coverage still exclude them; DM/NSM lose only their chain. Read before touching resolveDoubleVisitAccessScope, filterEmployeesForDoubleVisitAccess, buildExecutiveReports, or buildManagerSummariesDetailed."
metadata: 
  node_type: memory
  created: 2026-09-11
  type: project
  originSessionId: 56f25729-c622-4b8f-a1e1-f16a89cce494
  modified: 2026-09-13T05:24:03.437Z
---

✅ **CLOSED 2026-09-13 — PR #3802, live 07:54 Cairo (`f6bc4212`).** The fork below was answered by
owner decision 13: out-of-scope visitors' rows are hidden from totals too, so KPI total == leaderboard
sum. `buildDownwardCut` (exported from the doctor-coverage module, ladder not duplicated) feeds
`resolveDoubleVisitAccessScope` and coaching; `filterEmployeesForDoubleVisitAccess` admits by
`allowedHrIds` only (the LINE readmission is gone); exclusions are built from the FULL directory.
The rank ladder bites only on the widening branches (PM, GPM, RM); DM/NSM lose only their own chain.
**Owner answered the 2026-09-13 workbook: UNRANKED visitors are SHOWN on PM/GPM/RM boards** (the
question named Training, SFE, Marketing Manager and CEO) — PR #3807 swapped the ladder test to
`cut.isRankedAtOrAboveViewer`. DM/NSM "Keep". Coaching and doctor coverage still EXCLUDE unranked —
that difference is deliberate, do not "align" it. CEO rows stay dropped by the feed's DV role-code
filter (no code for CEO), which the answer did not reach. Two callers still pass an active-only directory
(`app/employee-portals/coaching-analytics/page.tsx`, `src/lib/crm/portal-crm-scope.ts`). Pinned by
`tests/double-visit-downward-scope.test.ts`. The account below is the pre-fix history.

**The gap WAS real and open on `main` until 09-13.** The owner's rule of 2026-09-04 —
*"Never an employee sees his direct manager. You see yourself and your scope down"*, then
*"remove dsms rsm and peer pms too"* — was implemented in `resolveDoctorCoverageScope` that day and
**nowhere else**. `resolveDoubleVisitAccessScope` still adds every member of the line for a PM/GPM.

Measured on production 2026-09-11: Product Manager `B-155` sees his own manager `A-8 Rasha Sabry`
in the DV module while she is correctly hidden from him on every CRM board.

## 🔴 ANSWER THIS BEFORE WRITING ANY CODE — the fork that killed attempt 3

A double visit is manager → rep, so her visits are **to HIS reps**. They must keep counting toward
those reps' coverage — dropping her rows makes a covered rep look uncovered. But if her rows stay
while her name goes, **the totals cannot reconcile by construction**: the KPI band runs on rows and
the leaderboard runs on named visitors. Measured on the branch: B-155 KPI **574** vs leaderboard
**545**; B-94 172/168; B-154 223/206.

So either the page carries a visible *"excludes N visits by managers outside your scope"* line, or
she is not hidden at all. **That is a product decision. It is not answerable from the code, and a
fourth attempt that starts before it is answered will fail the same way.**

## 🔴 THERE ARE TWO NAMED-MANAGER TABLES, AND EVERY ATTEMPT HAS FOUND ONLY ONE

1. `buildManagerSummariesDetailed` → the **leaderboard**. Built from row **VISITORS**, which is why
   a row filter can never remove a name: her rows are admitted on the REP, and only
   manager→manager rows are caught by a row filter — and three other filters already drop those, so
   a test on that shape passes against entirely broken code.
2. `buildExecutiveReports` → the **By Manager tab** and its sidebar, profile panel and export
   sheets. Fed `scopedEmployees`.

**And `scopedEmployees` readmits her.** `filterEmployeesForDoubleVisitAccess` accepts an employee on
`allowedLines` as well as `allowedHrIds`, so cutting her from `allowedHrIds` changes nothing there —
measured 52 on both sides. `allowedLines` exists for ROWS with no mapped employee; it is doing
double duty on EMPLOYEES, and that is the actual root cause.

**Third emitter to check: `idleManagers`** (in `buildExecutiveSummary`) = in `scopedEmployees` + has
a DV role + has no summary row. 🔴 Attempt 3 removed her summary WITHOUT removing her from
`scopedEmployees`, so she fell into the idle bucket and the page printed **"4 Managers Did Zero
Double Visits"** naming her — in a month she did **29 visits**. A false zero about a real person's
performance is worse than the leak being fixed.

## Regressions the three attempts introduced — do not repeat them

1. **Never rank on `positionTitle` first.** A shared ranking helper reaches the LOCKED
   doctor-coverage module in the exposure-increasing direction, and its tests cannot see it (their
   fixtures set `jobTitle` only). If both titles are read, take the **more senior** rank
   (`Math.max`). Best avoided entirely: attempt 3 shipped no ladder at all.
2. **An EXCLUSION must never be derived from a SCOPE** (`managerHrIdKeys`, built from
   `scopedEmployees` at 2 of 4 sites). ⚠ Currently **inert only because the ancestor is still in
   scope** — it re-arms the moment the readmission above is fixed.
3. **`filterRowsByAllowedDoubleVisitor` fails OPEN** (`if (!employee) return true`). Same story:
   inert only while she stays in `scopedEmployeesByHrId`.
4. **Do not gate the line-label fallback on directory membership** — it drops a DSM's visit to a
   vacant territory, and that reaches the weekly digest **email**.
5. **Measure MORE THAN PM/GPM.** Attempt 3 measured only those and missed that DSMs lose their own
   RSM/NSM from the leaderboard.
6. **Company-wide viewers (`scope.all`: CEO, SFE, Training, Marketing) must keep full oversight.** A
   chain computed unconditionally narrows a board built to show everything. Costs nothing today
   (neither the Marketing Manager nor the CEO records a DV) — latent, so pin it.

## Two test traps measured on this file

- **The key-domain assertion never executes.** `canonicalHrIdKey("A-8")` is `a-8`; the ACCESS domain
  (`normalizeHrIdForAccess`) strips the hyphen to `a8`. A guard written as
  `canonical !== hrId.toLowerCase()` is therefore always false and the block is skipped — the one
  assertion written for the exact trap the file warns about asserts nothing.
- **A test that builds its own chain helper cannot see the service's own construction.** That is why
  attempt 3's test was green while the service used raw `chain.has()` instead of `isAboveViewer`,
  and while the idle-bucket defect shipped.

## Where the work is

Branches `codex/dv-downward-scope` (attempts 1–2, tip `f08100e06`) and `codex/dv-downward-scope-2`
(attempt 3, tip `9f5b73b41`) on origin. **Closed** PRs
[#3672](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/3672) and
[#3704](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/3704), whose closing comments
carry all three reviews.

**Sound and worth salvaging from attempt 3:** the chain-only module
`src/lib/workforce/downward-scope.ts` (no ladder duplicated — the ladder stays in the locked
doctor-coverage module), and the company-wide exemption.

**Any change here is permission-sensitive** (AGENTS.md §7): it needs a role sweep and an independent
risk review, not just green CI. **All three attempts passed all four required checks while carrying
regressions.**

Related: [[scope-runs-downward-only-never-your-own-manager]] ·
[[the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer]]
