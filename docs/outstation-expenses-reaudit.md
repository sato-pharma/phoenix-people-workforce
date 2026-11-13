# Outstation & Expenses — Current-State Re-Audit

**Read this alongside `OUTSTATION_EXPENSES_AUDIT.md`, not instead of it.** That document is the
from-zero forensic audit. This one exists to answer a single question an independent reviewer must
be able to answer before trusting any of it: **was the audit written against the code production is
actually running?**

| | |
| --- | --- |
| Audit date | 2026-08-12 (Africa/Cairo) |
| Forensic audit written against | `200d9ada` — local `codex/finance-six-module-access` working tree |
| Current production | `fe60edc0d2138378366d0339909a0de7ad789e8b` — Railway, `europe-west4` |
| Verified against | `GET https://phoenix-hr.satopharma.com/api/healthz` → `{"status":"ok","revision":"fe60edc0d2138378366d0339909a0de7ad789e8b","time":"2026-08-12T06:33:26.612Z"}` |
| Method | Fetched `origin`; diffed every Outstation/Expenses path between the audited tree and production; ran the module's 40 registered test suites; **broke one production guard and confirmed its own headline assertion fires**; queried production Postgres for schema, RLS, constraints and data. |
| Verdict | **The audit describes production exactly.** Every file it relies on is byte-identical to `fe60edc0`. |

---

## 1. Current snapshot

| Layer | SHA | Relationship |
| --- | --- | --- |
| **CURRENT PRODUCTION** | `fe60edc0` | `/api/healthz` returns this revision. |
| **CURRENT MAIN** | `fe60edc0` | **Identical to production.** |
| **AUDITED LOCAL** | `200d9ada` on `codex/finance-six-module-access` | **36 behind, 3 ahead** of `origin/main`; forked at `9e8e65f1`. Working tree dirty. |

The local checkout is stale **as a branch** — but that does not, by itself, invalidate the audit.
The question is narrower: *do the files the audit read differ from production?* They were diffed
explicitly, and they do not.

```
git diff --stat 200d9ada fe60edc0 -- <every Outstation/Expenses path>
  src/config/system-navigation.ts       | 64 ++++++++++-----
  src/lib/security/access-registry.ts   | 14 +++++
  …3 Direct-Orders / staging-parity migrations
  5 files changed
```

**Not one file under `src/lib/outstation/`, `src/components/outstation/`, `app/api/outstation/`,
`app/api/admin/outstation/`, any Outstation or Expenses page, any of the 46 test files, either email
template, `src/lib/auth/permissions.ts`, `src/lib/payroll/**` or `src/lib/automated-payroll/**`
differs from production.**

The two files that *do* differ were each checked line-by-line for Outstation content:

```
diff <(grep -Ei 'outstation|expense' <prod system-navigation.ts>)  <(same, local)   → IDENTICAL
diff <(grep -Ei 'outstation|expenses' <prod access-registry.ts>)   <(same, local)   → IDENTICAL
git diff fe60edc0 -- src/lib/auth/permissions.ts                                    → empty
```

Their changed hunks are Sales-Analytics navigation and Direct-Orders / excuses registry rows — the
local branch's own unrelated work. **Zero Outstation or Expenses lines changed.** Only line
*numbers* shift in `access-registry.ts`; §8 quotes production numbers.

**Working-tree dirtiness, scoped.** Of the 41 modified + 9 untracked files in this checkout, exactly
one is in the audit's evidence base — `src/lib/security/access-registry.ts` — and its Outstation
rows are identical to production, as shown above. Nothing else the audit cites is dirty.

**The module has been frozen for two days.** Last functional commit touching it:

```
553d4f2d  2026-08-10 12:23  feat(finance): unbooked direct-order queue on screen,
                            and Finance out of Outstation (#2006)
290485dc  2026-08-09 11:44  feat(outstation): the system flags an expense, it never rejects one (#1938)
```

---

## 2. Executive delta

**There is no functional delta.** Unlike the Direct Orders re-audit — which covered six commits
landing inside its audit window — nothing in this module changed between the audited tree and
production. This section therefore records what *verification* added, not what the code did.

1. **Production identity proven, not assumed.** 231 files extracted at `fe60edc0` and hashed against
   the production tree — **231 of 231 byte-identical**, `git hash-object` vs `git rev-parse`.
2. **The module's tests were run and pass — 40 of 40 suites.** The full `pnpm run test` could not be
   used (§11); the slice was driven directly instead.
3. **One production guard was deliberately broken to prove the suite is not decorative.** Detail in
   §11.
4. **Three counts in the forensic audit are corrected** by exact `git ls-tree` measurement. §3.
5. **Two claims are downgraded** from what the forensic audit implied. §3.
6. **Everything material is unchanged.** All 33 findings (F-01 … F-33) stand as written, at the
   severities assigned.

---

## 3. Corrections to the forensic audit

Small and stated plainly, because a reviewer will re-count.

| # | Audit said | Correct at `fe60edc0` | Why it differed |
| --- | --- | --- | --- |
| C-1 | "`src/components/outstation/` — 39 files, 15,079 lines" | **46 files, 15,552 lines** | The audit counted `*.tsx` only; the directory also holds 7 `.ts` files (`evidence-watermark.ts`, `expense-shared/formatters.ts`, `types.ts`, `use-expense-saved-views.ts`, …) |
| C-2 | "37 API routes" | **36 route handlers** — 35 under `/api/outstation/**` + `/api/admin/outstation/**`, plus `/api/payroll/copilot/:runId/deductions/expenses` | The audit counted `app/api/outstation/request-body.ts`, which is a shared body parser, not a route |
| C-3 | "42 outstation/expense test files exist and are wired into `tests/run-tests.ts`" | **46 test files: 40 unit/integration (all 40 wired, zero unwired — verified per file) + 6 Playwright e2e/synthetic (separate runner, not in `run-tests.ts`)** | The audit conflated the two runners |
| C-4 | §13.3 reported the July hand-carry shortfall as EGP 2,354.00 across 2 employees | **Unchanged and re-confirmed** — but note this differs from the EGP 2,594 in the memory note `outstation-payroll-import-is-locked-out-by-batch-status`. The earlier figure included "A-12 240", which is an **April** payout row (`OUTSTATION-31`), not July. **EGP 2,354.00 is correct for July** | The memory note mixed two payout periods |

All four corrections are now applied to `OUTSTATION_EXPENSES_AUDIT.md` itself, so the two documents
agree. **Nothing in C-1…C-4 changes a finding, a severity, or a monetary total.**

*(A fifth candidate was investigated and dropped: `expenses-review-workspace.tsx:50` `.slice(0, 260)`
is an error-message truncation, not a row cap. The forensic audit never claimed otherwise, so there
was nothing to correct.)*

---

## 4. Findings status

All 33 findings were re-checked against production content and live production data. None moved.

| Class | Count | Findings |
| --- | --- | --- |
| **CONFIRMED IN PRODUCTION** | 19 | F-01, F-02, F-04, F-05, F-06, F-07(mechanism), F-08, F-10, F-11, F-14, F-15, F-16, F-17, F-24, F-25, F-27, F-28, plus the two ghost-artefact counts |
| **ARMED BUT NOT OBSERVED** | 4 | F-03, F-12, F-30, F-33 |
| **CODE DEFECT — DATA IMPACT UNKNOWN** | 5 | F-09, F-13, F-23, F-26, F-29, F-31, F-32 |
| **UX/RUNTIME CONFIRMED (static)** | 5 | F-18, F-19, F-20, F-21, F-22 |
| **Requires business confirmation** | 1 | F-07 (whether any repeated figure is unintended) |

The single highest-severity item is unchanged and re-verified live this session:

```sql
-- every 2026 payroll batch, live
2026-01 locked · 2026-02 approved · 2026-03 locked · 2026-04 locked
2026-05 locked · 2026-06 locked   · 2026-07 approved

-- what the import RPC will accept
part1_paid | adjustments_open | part2_ready | under_review | rejected

-- rows ever imported, all time
select count(*) from outstation_expenses where imported_to_payroll_at is not null;  -->  0
```

---

## 5. Current architecture

```
Outstation & Expenses  —  THREE systems, one string join, no foreign key
│
├─ 1. CLAIM WORKFLOW            outstation_expense_requests            36 rows
│     wizard → GPS + arrival photo + departure photo + CRM workload
│     status ALWAYS 'submitted' on create (owner rule, 2026-08-08)
│     approval: Super Admin ONLY
│
│        approving MANUFACTURES a fake spreadsheet upload  ─────────┐
│                                                                   ▼
├─ 2. HISTORICAL LEDGER         outstation_expenses                360 rows
│     outstation_expense_reports  38 rows — 36 of them `.workflow` synthetics
│     joined to (1) only by the STRING 'OUTSTATION-' || id
│     hr_approved · status · hr_status · open_status(dead) · approved_amount
│     payout_month = trip month + 1
│     imported_to_payroll_at  → NULL on all 360 rows, structurally unreachable
│
│        designed bridge: phx_import_approved_expenses_to_payroll()  ✗ DEAD
│        actual bridges:  payroll template pre-fill · automated-payroll wizard · manual
│                                                                   ▼
└─ 3. PHOENIX PAYROLL           salary_records.expenses     EGP 258,748.50 Jan–Jul
      salary_batches — every 2026 batch locked or approved
      trigger phx_prevent_closed_salary_records_mutation
```

Unchanged from the forensic audit. Re-derived from production schema this session.

---

## 6. Current role matrix

| Role | `outstation` | `expenses` | Approve? |
| --- | --- | --- | --- |
| **Super Admin** | all | all | **YES — the only approver** |
| CEO | read, export | read, export | No — `executionOnlyOutstationRoles` |
| Finance Manager | *(key deleted 2026-08-10, #2006)* | read *(marketing-requests only)* | No |
| District / Regional / National Sales Manager | read, create, export | read, export | No |
| Product / Group Product / Training / SFE / Marketing Manager | read, create | read, export | No |
| Medical Rep | read, create | read, export | No |
| Financial Advisor | read, create | read, export | No |

`src/lib/outstation/admin-access.ts` → `adminOutstationRoles = new Set(["Super Admin"])`. One entry.
**There is no manager approval rung anywhere in the module** — a District Manager receives a Cc on
the submission email and has no decision surface.

`permissions.ts` is byte-identical to production, so this matrix is production's.

---

## 7. Current business-critical rules

| Rule | Where it lives | State |
| --- | --- | --- |
| **The system FLAGS, it never REJECTS** (owner, 2026-08-09) | `service.ts:1646-1683` — every failed check appends to `reviewHoldReasons`; `rejected_by_system` unreachable from the submit path | Live, `#1938` |
| **A claim waits for a person** (owner, 2026-08-08) | `service.ts:1681` — `workflowStatus = "submitted"`, unconditional | Live, `#1916` |
| **Two-photo + workload gate** (owner, 2026-08-04) | `resolveOutstationGateState`; acceptance and payment separated — a held claim is accepted but withheld from payroll | Live |
| **One allowance per employee per calendar day** | `allowance-day-guard.ts`, across every write path | Live, `#1906` |
| **Arrival photo required for every transport type** | `service.ts:1551-1560` — throws without it | Live |
| **Ticket mandatory for train/bus when online**; offline is held, not refused | `service.ts:1590-1603` | Live |
| **HR's cut is stored beside the claim, never over it** | `approved_amount` column + `payableExpenseAmount()` | Live |
| **`approved + deduction === claimed`, clamped to `[0, claimed]`** | `payable.ts:37-53` | Live |
| **Only an explicit `Rejected` is dropped from payroll; PENDING pays** | `payoutExpenseRowIsPayable`, `recommend.ts:403` | Live — **and this is F-08** |
| **Finance is 100% out of Outstation** (owner, 2026-08-10) | nav row, hub `OUTSTATION_EXPENSES_ROLES`, matrix key deleted | Live, `#2006` |
| **CEO is on no outstation email, in any slot** (owner, 2026-08-08) | `resolveOutstationSubmitRouting` | Live, `#1891` |

---

## 8. Current route / navigation inventory

Counted with `git ls-tree -r fe60edc0`, not estimated.

| Category | Count | Detail |
| --- | --- | --- |
| Admin pages | **10** | hub · expense-command · expense-approvals · expenses (Historical Upload) · expenses/dashboard · policy · + 2 redirects (`requests`, `heatmaps`) · + 2 `/workspace/*` wrappers |
| Portal pages | **6** | expenses · submit-expense · expense-submissions · expense-dashboard · team-expenses · `/employee/outstation/new` (4-way redirect) |
| API route handlers | **36** | 35 under `/api/outstation/**` + `/api/admin/outstation/**`; 1 payroll-copilot expenses route |
| `src/lib/outstation/` | **39 files, 12,948 lines** | `service.ts` alone is 4,737 lines / 33 exports |
| `src/components/outstation/` | **46 files, 15,552 lines** | 5 files over 800 lines; largest is `mobile-outstation-wizard.tsx` at 2,168 |
| Registry rows (production line numbers) | | `285` `/api/admin/outstation/expense-command/export` · `286` `/api/admin/outstation/**` wildcard · `469-476` `/api/outstation/**` and the `expenses/*` set · `489-490` payroll copilot · `748-749` page rows |
| **`expenses:read` also gates** | **20 rows** | the whole `/api/marketing-requests/**` namespace, production lines `336-445`. Removing `expenses` from a role silently 403s their marketing approval rung. |

Three admin destinations expose the **same decision on the same trip**; four routes reach it. Every
admin task is 4 page transitions from the sidebar; the submission email's deep link
(`?tab=queue&requestId=<id>`) is 1 and is the only well-formed deep link in the module.

---

## 9. Current performance architecture

| Behaviour | Location | Assessment |
| --- | --- | --- |
| Queue tab loads **every** request + a signed URL each, unfiltered, uncapped | `expense-command/page.tsx:73` | Fine at 36 rows; unbounded by design |
| `listOutstationRequestExpenses` loads all requests, filters period **in memory** | `expenses.ts:647-682` | No period predicate in the query |
| Bulk decisions **serial**, ≈10–14 round trips per approved row | `service.ts:3546` | `for` loop with `await`; the ledger half of the same Save is one batched upsert |
| Dashboard fans out to full directory + full ledger + full request list per load | `expenses.ts:787-794` | |
| Report list `.in()` batched at 100 ids to dodge a 16 KB URL header limit | `expenses.ts:583-600` | Workaround correct; the one-report-per-approval design is what forces it |
| Ledger read paginates at 1,000 | `recommend.ts:380` | Correct |

**Row caps, corrected (see C-4):**

| Location | Cap | True count shown beside it? |
| --- | --- | --- |
| `expense-report.tsx:1339` | **250 rows** | **Yes — `{records.length} rows` badge at `:1208`.** The 277-row upload displays "277" and renders 250. No pagination, no indicator |
| `expense-report.tsx:1010` | 12 reports | No |
| `expenses-dashboard.tsx:332` | 50 rows | Adjacent panel prints the full count |
| `nsm-team-expenses-dashboard-impl.tsx:444, 512` | 20 each | No |

---

## 10. Current security findings

Re-queried live this session.

| Item | Production state |
| --- | --- |
| RLS | **Enabled on all 4 tables.** `outstation_expense_requests` 5 policies · `outstation_expenses` 5 · `outstation_expense_reports` 5 · `outstation_policy_rules` 1 (`service_role` only) |
| Policy quality | Well-formed — `private.phx_can_manage_outstation()`, `phx_can_manage_payroll()`, `phx_visible_hr_ids()`, resigned-employee exclusion |
| **Operative boundary** | **Not RLS.** Every application path uses the service-role client, so application code is the boundary. RLS is defence-in-depth |
| `authenticated` grants | `arwdDxtm` on `outstation_expense_requests` / `outstation_policy_rules`; `arwd` on `outstation_expenses` / `outstation_expense_reports`. Broad, but constrained by the policies above |
| Server authorization | Sound. `assertOutstationAdminAccess` or `assertSystemAdministratorWorkspaceAccess` on every admin route; `assertPermission` on every employee route; `assertSameOriginMutation` (CSRF) on every mutating route |
| Status columns | **No CHECK constraint** on `requests.status`, `requests.calculation_status`, `expenses.status`, `expenses.hr_status`, `expenses.open_status` — all free text |
| Triggers | **None on any outstation table.** `updated_at` is app-maintained; counters never re-derive |
| Unscoped read | `/api/approvals-hub/hub-data` calls `listOutstationRequests()` with **no access argument** while every sibling feed receives `viewAccess` (`hub-data/route.ts:99`). **Contained** — the route is gated `ALLOWED_VIEW_AS_ROLES = new Set(["Super Admin"])`. Latent, not live (F-31) |
| Audit coverage | `audit_logs`: **116** rows for `outstation_request`, **0** for `outstation_expenses` (F-06) |

**No secret, key or credential appears anywhere in the module's source.** §12.

---

## 11. Tests / verification

### What was run

**`pnpm run test` could not complete in this checkout, and the reason is local, not production.**
The runner's own wiring guard is the 6th test and it aborts the process:

```
FAIL test wiring is complete (no test file imported-but-uninvoked, none orphaned)
AssertionError: these test files are NOT imported by tests/run-tests.ts, so they never execute
  actual: [ 'direct-orders-collection.test.ts […]', 'early-birds-line-stars.test.ts […]' ]
EXIT=1
```

Both are untracked files from this branch's own in-progress work. `direct-orders-collection.test.ts`
**exists at production and is registered there** — it landed on `main` while this branch sat 36
commits behind, so the local `run-tests.ts` does not yet import it. `early-birds-line-stars.test.ts`
is new local work. **Neither is an Outstation file, and no Outstation test executed before the
abort.** Nothing in the owner's working tree was modified to work around this.

*(Note: the background-task notification reported exit 0. That was the wrapper's code, not the
run's. The log's own `EXIT=1` is authoritative.)*

The module's slice was therefore driven directly, from a script outside the repo, using the same
loader and flags:

```
SLICE RESULT  pass=40  fail=0  total=40      REAL_EXIT=0
```

All **40** registered Outstation/Expenses suites pass. The 6 Playwright e2e/synthetic specs
(`tests/e2e/*`, `tests/synthetic/*`) belong to a separate runner and were not executed.

### Proving the suite is not decorative

A green suite proves nothing on its own. One production guard was broken and the test's own
headline assertion confirmed to fire — the guard behind finding F-08:

```ts
// src/lib/automated-payroll/recommend.ts:403 — DELIBERATE TEMPORARY BREAK
- return expenseApprovalState({ hrApproved: row.hr_approved, status: row.status }) !== "rejected";
+ return true;
```

```
HEADLINE ASSERTION FIRED:
  a trip HR rejected must not be reimbursed: Ahmed Hekal's two 427 duplicates were rejected,
  so the sheet must carry 1,953 and not the 2,807 that summing every row produces
  2807 !== 1953
```

**Restored immediately and verified byte-identical**: `git hash-object` before and after both read
`2831861464dd40ab74dd21706f80364d9cabc78e`, which equals `git rev-parse fe60edc0:src/lib/automated-payroll/recommend.ts`.
`git status --porcelain` on that file is empty. The working tree is exactly as it was.

### What the tests do NOT cover

Every one of the following was found by production data or schema, and no test would have caught it:
the import RPC being unable to run · report counter drift (25 of 38 wrong) · ghost ledger rows
outliving deleted requests · ghost reports · `hr_status` divergence on 70 rows · `total` vs
components · the 250-row render cap against the displayed true count · concurrency on
approve/reject · any end-to-end path from request to `salary_records` · `paidAt` being structurally
unreachable.

### Still not verified

**No runtime browser verification.** No dev server was running; `.claude/launch.json` is attach-only
(`preview_start` cannot spawn from this `F:\` path); free RAM was 2.75–3.71 GB across 7–10 live
sessions, and `.env.local` points at production. §20 of the forensic audit (mobile) and its click
counts are derived from component source and route resolution, not a rendered page. Everything
labelled `CONFIRMED IN PRODUCTION` is database evidence and is unaffected.

---

## 12. Delta source ZIP path

`OUTSTATION_EXPENSES_SOURCE.zip` — **796,031 bytes (777.4 KB)** at the repo root; the unzipped tree
at `F:/Phoenix Workforce/OUTSTATION_EXPENSES_SOURCE/` — **deliberately OUTSIDE the repo.**

> **Do not unpack it inside the repo.** `tsconfig` excludes only `_wt-*`, `.codex-worktrees` and
> `.claude/worktrees` patterns, so `tsc` would walk the package and its copy of `tests/run-tests.ts`
> — which imports ~700 test files the package does not contain — and emit hundreds of `TS2307`
> errors. That fails the pre-push hook's typecheck and blocks **any** push from this checkout, not
> just yours. This is exactly what happened with `DIRECT_ORDERS_DELTA_SOURCE`. The `.zip` itself at
> the repo root is inert and harmless.

**Contents: 231 files** (257 zip entries including directories), single root folder
`OUTSTATION_EXPENSES_SOURCE\`, original relative paths preserved, **all at `fe60edc0` (= production)
content**:

| Area | Files |
| --- | --- |
| `src/lib/outstation/` | 39 |
| `src/components/outstation/` | 46 |
| `app/api/outstation/**`, `app/api/admin/outstation/**` | 37 |
| Admin + portal pages | 23 |
| `tests/` (40 unit + 6 e2e/synthetic) | 46 |
| Payroll boundary (`payroll/`, `automated-payroll/`, template route) | 15 |
| Permissions, navigation, access registry, workflow registry | 6 |
| SQL (`supabase/*.sql` + 6 migrations) | 10 |
| Other (`fixture-hygiene`, approvals-hub, emails, employee-portal expense components) | 9 |

**Integrity, verified per file:** `git hash-object <staged>` compared to `git rev-parse fe60edc0:<path>`
for all 231 → **0 mismatches.** Every byte in the package is what production is running.

**Secret scan.** `gitleaks` is not on this machine's PATH, so a pattern-based fallback was run over
the whole package — JWT-shaped strings, Supabase `sb*_` keys, `sk-` / `gh[pousr]_` / `xox*` / `AKIA`
tokens, `AIza` Google keys, Postgres connection strings, PEM private-key headers, and quoted
assignments to `SERVICE_ROLE|ANON_KEY|SECRET|API_KEY|PASSWORD|TOKEN`. **Zero matches across all ten
patterns.** No `.env*`, `node_modules`, `.next`, `*.pem`, `*.key`, `*.p12`, `*.xlsx`, `*.csv`,
`*.pdf` or `.git` present — file-type census is exactly **147 `.ts`, 74 `.tsx`, 10 `.sql`**.

---

## 13. Documentation path

| File | What it is |
| --- | --- |
| `OUTSTATION_EXPENSES_AUDIT.md` | The from-zero forensic audit — 27 sections, 33 findings, month-by-month production reconciliation. **Read this first.** |
| `OUTSTATION_EXPENSES_REAUDIT.md` | This file. Proves the audit describes production, and records the corrections in §3. |
| `OUTSTATION_EXPENSES_SOURCE.zip` | The source needed to check every claim. |

There is **no authoritative module spec** for Outstation/Expenses — no `docs/specs/outstation*.md`
exists. That is itself a finding: Direct Orders has one (`docs/specs/direct-orders.md`), this module
does not, and the only written description of its behaviour is now these two documents.

---

## 14. Top files to send the independent reviewer

Ranked by how much of the current state they carry.

1. **`src/lib/outstation/service.ts`** — 4,737 lines, 33 exports. `submitOutstationRequest` (1504),
   `approveOutstationRequestForPayroll` (2573), `pushAcceptedOutstationExpenseToPayroll` (2539),
   `rejectOutstationRequestAsAdmin` (3347), `applyOutstationRequestExpenseDecisions` (3539),
   `deleteOutstationRequestAsAdmin` (3627), `getOwnOutstationSubmissionDecisions` (4399).
2. **`src/lib/outstation/expenses.ts`** — `savePayrollExpenseApprovals` (927) is the **only** writer
   of the ledger and the thing that mints a report per approval. Also `listUnifiedOutstationExpenses`
   (734), the union/dedup of the two data models.
3. **`src/lib/outstation/payroll-expense-mapping.ts`** — 215 lines and the whole of the amount
   lifecycle. Hardcodes `status:"Approved"`, `hr:"Approved"`, `hrApproved:true` (102-119);
   `nextPayrollPeriod` UTC bug (33); the `report_hr_status → employee name` fallback (166).
4. **`supabase/scripts/20260512_payroll_engine_hardening.sql`** — `phx_import_approved_expenses_to_payroll`.
   The status precondition that makes it unrunnable, and the `SET expenses = coalesce(…, 0)` that
   would zero everyone else (F-01, F-03).
5. **`src/lib/automated-payroll/recommend.ts`** — `payoutExpenseRowIsPayable` (403). Why **pending**
   rows reach payroll (F-08). This is the guard broken in §11.
6. **`app/api/payroll/template/route.ts`** (1438-1450) + **`src/lib/payroll/service.ts`** (734) —
   `getLatestSalaryExpenseTotalsBefore`, the previous-month carry-forward (F-07).
7. **`src/lib/outstation/payable.ts`** — `payableExpenseAmount`, `normalizeApprovedAmount` (the
   equals-claimed → NULL behaviour, F-32).
8. **`src/lib/outstation/approval-state.ts`** — the 3-state model the whole module hinges on.
9. **`src/components/outstation/my-expense-submissions.tsx`** (109, 199-205) — where the employee is
   shown a permanently false payment status (F-04).
10. **`src/components/outstation/expense-report.tsx`** (1208 vs 1339) — the true-count badge beside
    the 250-row render cap (F-17); and 119-138, the 2,900px mobile table (F-22).
11. **`src/lib/outstation/admin-access.ts`** — 50 lines. Proves Super Admin is the only approver.
12. **`tests/automated-payroll-rejected-expenses.test.ts`** — the one whose assertion was proven to
    fire.
13. **`tests/run-tests.ts`** — proves all 40 module tests are wired. *(Do not unpack inside the repo
    — see §12.)*

---

## 15. Remaining open issues (today, not historically)

Unchanged from the forensic audit's register. Ranked by money at risk.

| | Item | Amount / scale |
| --- | --- | --- |
| 1 | July hand-carry shortfall — B-175 (no July salary record), B-74 (one trip dropped) | **EGP 2,354.00**, 2 employees |
| 2 | August payroll recommendation pre-fills unapproved rows | **EGP 6,052.17** of 8,156.11, 5 employees |
| 3 | September, same mechanism | **EGP 7,383.27**, 100% unapproved, 7 employees |
| 4 | Ghost ledger rows, approved and payable, source request deleted | **EGP 4,272.35**, 9 rows |
| 5 | Undecided Jan–June ledger rows — abandoned or owed? | **~EGP 99,000**, 262 rows |
| 6 | `Jan - June Expenses.xlsx` header vs contents | out by 29 rows / **EGP 12,813** |
| 7 | Every employee sees a false "not yet in payroll" status | all claimants, permanently |
| 8 | Ledger mutations leave no audit record | 70 July approvals + every amount cut |

---

## 16. Changes since the forensic audit

**None to the module.** Production `fe60edc0` is the same Outstation code the audit was written
against; the module's last functional commit is `553d4f2d` (2026-08-10).

What changed is only the evidence base:

- Production identity established (`/api/healthz` → `fe60edc0`) and every audited file diffed
  against it.
- 231 files extracted and hash-verified at production content.
- 40 of 40 test suites run and passing; one guard broken and restored to prove the suite bites.
- Five counting/reading corrections recorded in §3.
- `OUTSTATION_EXPENSES_SOURCE.zip` built and secret-scanned.

**No application behaviour, production data, schema, branch, migration or deployment was modified at
any point.** The one temporary source edit in §11 was reverted and hash-verified within the same
command.

---

*Re-audit performed 2026-08-12 against production revision `fe60edc0`. Read-only.*
