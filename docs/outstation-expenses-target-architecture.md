# Outstation & Expenses — Proposed Target Architecture

**This is a proposal, not a spec.** Nothing here is built. It follows
[`outstation-expenses-audit.md`](outstation-expenses-audit.md) (the forensic audit) and
[`outstation-expenses-reaudit.md`](outstation-expenses-reaudit.md) (proof the audit describes
production `fe60edc0`). Every design choice below traces to a finding in those documents.

| | |
| --- | --- |
| Written | 2026-08-12 (Africa/Cairo) |
| Against production | `fe60edc0` |
| Closes | 30 of 33 findings outright; 2 need a business ruling first; 1 is a documentation gap this file itself fills |
| House patterns mirrored | Direct Orders — `direct_order_events`, `phx_apply_direct_order_decision(… p_expected_status …)` |

## Build status

| Phase | State | Evidence |
| --- | --- | --- |
| **0 — schema** | **APPLIED** to staging `cifwmndunmlxjhyjugxa` and production `ozucdzovmcqvepbozvqf`, 2026-08-12 | 4 tables + 3 views live; RLS on, `anon`/`authenticated` denied, `service_role` granted, verified in `pg_class`/`pg_policies`. Legacy tables untouched (39 / 360 / 38), `salary_records` unchanged at EGP 258,748.50, `imported_to_payroll_at` still 0. Public tables 303 → 307. Migration `supabase/migrations/20260812160000_expense_claims_phase0_schema.sql` |
| **1 — backfill + reconciliation** | **APPLIED**, reconciles exactly | **375 claims = 39 + 360 − 24**, as predicted. Claimed EGP **150,129.48** and approved EGP **36,403.29** both identical to legacy. Statuses 82/18/275 all match. 0 orphans, `claim_ref` unique. Migration `…20260812160100_expense_claims_phase1_backfill.sql` |
| **2 — sync + parity + flagged read** | **APPLIED** (DB) · **committed, unmerged** (code) | `phx_refresh_expense_claims()` and `v_expense_claims_parity` live on both environments. **Parity: 375 / 375 OK on production, 293 / 293 on staging — zero drift.** The phase-3 interlock was **proved by breaking it**: inserting one native claim made the refresh refuse (`P0001 … 1 claim(s) have no legacy link`), probe removed, refresh works again at 375. Migration `…20260812160200_expense_claims_phase2_sync_and_parity.sql`. Code + all three migrations in **[PR #2046](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2046)** (`codex/expense-claims-phase2`), **flag `PHOENIX_EXPENSE_CLAIMS_READ` defaults false**. **MERGED 2026-08-12 13:12 UTC as `19c52c76`** (owner-approved), all 4 required checks green (`validate` 4m20s · `lint` 2m30s · `typecheck` 1m58s · `secret-scan` 16s), +1023/−2 across 5 files.<br>⚠ **This phase was reported complete but was not.** It shipped the read *adapter* and the parity harness, but **nothing ever called the adapter** — so reads never actually switched. Found on 2026-08-12 while starting phase 3 part 2. The real switch is **[PR #2055](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2055)**, below. |
| **2b — the read switch that was missing** | **PR open, flag off** | `listUnifiedOutstationExpenses` delegates to `expense_claims` when `PHOENIX_EXPENSE_CLAIMS_READ` is set. Deliberately **not** a money path: it feeds the approvals queue, export, command centre and dashboards, so the flag changes what an approver **sees**, never what an employee is **paid**. Dynamic import avoids a module cycle; `reportId` stays on the legacy path because 36 of 38 report rows are synthetic `.workflow` artefacts the new model does not reproduce. **[PR #2055](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2055)** (`05193a45`, +29/−0, `tsc` clean). **MERGED 2026-08-12 17:38 UTC as `561155df`** (by the owner directly). **FLAG TURNED ON in Railway production 2026-08-12 18:00 UTC** — `PHOENIX_EXPENSE_CLAIMS_READ=true`, set with `railway variables --set` on an idle service after waiting out an in-flight build. The approvals queue, export, command centre and dashboards now read `expense_claims`. Both models still return **375** trips and parity is **0**; `salary_records` untouched at EGP 258,748.50 and payroll links still 0. **Rollback = unset the variable.** |
| **3 part 1 — the decision function** | **APPLIED** to staging and production 2026-08-12, **wired to nothing** | `phx_decide_expense_claim` (compare-and-swap, transactional, self-auditing), `phx_decide_expense_claims` (bulk, one round trip), `phx_resolve_expense_payout_period`. All three `SECURITY DEFINER`, `anon`/`authenticated` denied. **Every guard and every transition proved on staging** — 6 refusals fired, all 6 actions succeeded, 7-event audit trail, bulk returned 2 applied / 2 named skips; staging then restored to 0 parity breaks. **Nothing exercised on production data** (0 decision events). Migration `…20260812170000_expense_claims_phase3_decision_function.sql`, in **[PR #2049](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2049)** (`codex/expense-claims-phase3`, commit `35d07364`) — SQL only, +312/−0, pre-push gates passed first time. **CI green — all 4 required checks pass** (`validate` 4m01s · `lint` 2m34s · `typecheck` 1m59s · `secret-scan` 15s), state `CLEAN`. **Awaiting the owner's merge decision — not merged.** |
| **3 part 2 — switch the writes** | **not started — the irreversible half** | Routing the app's approve/reject paths through the function, and stopping the `.workflow` minting. Wants the phase-2 observation window first. |
| **4 — payroll link contract** | **APPLIED** to staging and production 2026-08-12, **UNARMED** | `phx_project_expense_payroll` (read-only) and `phx_link_expense_claims_to_payroll` (**dry-run by default**). Proved on staging against a disposable open batch: dry run wrote nothing · real run linked 3 claims / EGP 2,487.61 · **re-run linked 0** (UNIQUE idempotency) · the salary write was **additive** — a pre-existing 500 survived as 500 → 2,987.61, where the old RPC would have `SET` it to 2,487.61 (**F-03 proven fixed**) · closed-batch refusal fired · a linked claim refused `unapprove` (phase-3 guard) · an employee with no salary record was **reported, not dropped** (the B-175 failure mode). Fixture torn down, staging back to 0 parity breaks. **Production: 0 links, 0 `in_payroll`, `salary_records` untouched at EGP 258,748.50.** Migration `…20260812180000_expense_claims_phase4_payroll_link.sql`, in **[PR #2052](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2052)** (`codex/expense-claims-phase4`, commit `cc34b3ba`) — SQL only, +239/−0, pre-push gates passed first time |
| **4 — arming it** | **blocked, by design** | No production batch can receive a link: all seven 2026 batches are `approved`/`locked`, and no August batch exists yet. Arming waits for an open August batch **and** an explicit owner go. |
| 5–6 | not started | — |

**The reconciliation report works.** From the new model alone it reproduces the July 2026 shortfall
the audit found by hand: **B-175 EGP 1,849.00 (no July salary record at all)** and **B-74 EGP 505.00**.
That is the whole justification for phases 0–1, and it now runs as a query instead of a person.

**Two findings the backfill itself produced** (neither was known before it ran):

1. **The component/total mismatch is 7 rows, not 2.** Beyond the deferred `OUTSTATION-31` (−60) and
   `OUTSTATION-52` (−436), the flag caught **`OUTSTATION-35` (+510), `-38` (+540), `-54` (+520) and
   `-56` (+835)** — claims whose parts fall well short of the total charged, and `TRP-00285`, the
   rejected row still carrying an approver. All 7 are `data_quality_hold = true` with a reason;
   none was altered. The four new ones look like ticket amounts not reaching the component columns,
   but that is a hypothesis, not a proven cause.
2. **The import summary view corrects the legacy drift on sight.** `Jan - June Expenses.xlsx` reads
   **248 rows / EGP 87,264** in `v_expense_import_summary`, against the stored header's 277 /
   100,077 (F-14). Nothing had to be repaired — the number is computed now.

**Queue split, measured on the real backfill:** 34 claims needing a decision in an open period
(EGP 20,358.63) against **241 in closed periods (EGP 86,408.00)** — the §8 split is not theoretical.

## Decisions taken

| Date | Decision | Consequence |
| --- | --- | --- |
| **2026-08-12** | **No manager approval rung. Super Admin remains the only approver.** Owner ruling. | **No approval-chain table is built.** No `expense_claim_approvals`, no `step_order`, no per-step status. A decision is a single act by one person. See §9. |
| **2026-08-12** | **The two self-contradicting legacy rows are DEFERRED — the owner decides them on his own side.** | `claimed_total` ships as a plain column and the generated-total constraint moves to phase 6. Both rows migrate intact and flagged. **Nothing waits on this.** See §13. |
| **2026-08-12** | **The 262 undecided Jan–June rows migrate as `submitted`. Do not close them.** Owner ruling. | The queue starts at **~289 items**, and **241 of them have a payout period whose payroll batch is already closed**. That forces two design changes that were not in the first draft: **payout period is resolved at approval, not at import** (§3, §5), and the queue **defaults to what is actionable** (§8). Neither closes or hides anything. |

> **The module is live under us.** Three new claims arrived while this was being written (IDs 71–73,
> 10:17 / 11:08 / 13:16 Cairo today), taking the request table from 36 to 39. One of them —
> ID 72, B-12 Dina Fadel — carries **`claimed_total_amount = 0`**. Every count in the audit is a
> point-in-time snapshot. **This architecture depends on no count.**

---

## 1. The proposal in one page

Today the module is **three systems joined by a text string**: a claim workflow, a legacy
spreadsheet importer it secretly writes into, and a payroll module it cannot legitimately reach.

The proposal collapses that to **one claim, one status, one decision function, one payroll contract**:

1. **One table for a claim.** `expense_claims` replaces `outstation_expense_requests` +
   `outstation_expenses`. A claim entered by wizard, by an admin, or by spreadsheet import is the
   same object with a different `source`. **The fake `.workflow` upload disappears entirely.**
2. **One status column**, DB-constrained, with a real exit from every state — including the reopen,
   un-approve and return-for-correction that today only exist as hand-written SQL.
3. **One decision function** in plpgsql, with a compare-and-swap on the expected status, exactly like
   `phx_apply_direct_order_decision`. Atomic across claim + event + payroll link. Bulk decisions
   become **one round trip**, not 10–14 per row.
4. **Payroll pulls; Outstation never pushes.** A link table records which claim paid which salary
   record for how much. Amounts are **added**, never `SET` — so the EGP 19,354/month of non-outstation
   expenses can never be zeroed. "Paid" becomes a fact the employee can be shown truthfully.
5. **Nothing derived is stored.** Import counters, totals and payability become views and generated
   columns, so they cannot drift.
6. **16 routes become 4.** One page per job: the employee's, the approver's, the analyst's, the
   importer's.

**What it does not touch:** the evidence gates, the flag-never-reject rule, the allowance-day guard,
the payroll module's own schema, or the 21 pending rows you deferred.

---

## 2. Design principles

Each is the direct inverse of a root cause from the audit.

| # | Principle | Root cause it kills |
| --- | --- | --- |
| P1 | **One business object, one row.** A claim is a claim whether it was typed, imported or captured. | RC-1 — one object modelled as two, joined by `'OUTSTATION-' \|\| id` with no FK |
| P2 | **Workflow never writes through the importer.** The importer handles files. Nothing else. | RC-2 — approving mints a fake spreadsheet upload |
| P3 | **Every money mutation is one transaction, guarded by the state it expects.** | RC-3 — no transaction, no guard, no reverse gear |
| P4 | **Payroll is a pull with an additive contract, not a push that overwrites.** | RC-4 — a designed bridge that cannot run, bypassed by hand |
| P5 | **The audit trail lives on the object the money is read from.** | RC-5 — 116 audit rows on requests, 0 on the ledger |
| P6 | **If it can be computed, it is never stored.** | RC-6 — stale counters, contradictory totals, meaningless `updated_at` |

---

## 3. Target data model

```
employees(hr_id)
   │ ON DELETE RESTRICT
   ▼
expense_claims                                    ← replaces requests + ledger
   claim_ref        text UNIQUE      -- keeps TODAY's values: 'OUTSTATION-57', 'TRP-00285'
   employee_hr_id   text NOT NULL FK
   source           text NOT NULL CHECK (source IN ('wizard','admin_manual','import'))
   import_id        uuid NULL FK expense_imports   -- set ONLY when source='import'
   status           text NOT NULL CHECK (status IN (…§4…))
   trip_start_date / trip_end_date / destination / transport / distance_km
   fuel_amount · allowance_amount · ticket_go · ticket_return · meeting_amount · other_amount
   claimed_total    numeric(12,2)   -- plain column phases 1-5, backfilled from today's `total`.
                                    -- Becomes GENERATED ALWAYS AS (sum of the six) in PHASE 6,
                                    -- once 2 legacy rows are ruled on (§13). ← F-15
   data_quality_hold boolean DEFAULT false  -- components ≠ total; surfaced, not hidden
   approved_total   numeric(12,2) NULL
                    CHECK (approved_total IS NULL
                           OR (approved_total >= 0 AND approved_total <= claimed_total))  ← F-33
   decided_by_hr_id · decided_at · decision_reason
   incurred_year · incurred_month    -- WHEN the expense happened. Derived from the trip, never changes.
                                     -- This is what reporting and attribution use.
   payout_year · payout_month  NULL  -- WHICH payroll pays it. NULL until approved, then resolved
                                     -- to the earliest OPEN period (§5). Never recomputed on save. ← F-30
   evidence_gate_status · workload_gate_status   -- unchanged, existing CHECKs kept
   created_at · updated_at           -- updated_at maintained by TRIGGER  ← F-27
   │
   ├──< expense_claim_events            append-only, mirrors direct_order_events
   │      claim_id · actor_hr_id · event_type · message · metadata jsonb · created_at
   │
   └──< expense_payroll_links           the ONLY payroll contract
          claim_id UNIQUE · salary_batch_id · salary_record_id
          amount numeric(12,2) · linked_at · linked_by_hr_id

expense_imports                                   ← replaces outstation_expense_reports
   id · file_name · uploaded_by · uploaded_at
   -- NO row_count, NO approved_rows, NO total_expenses.  Those become a VIEW.  ← F-14, F-27

v_expense_import_summary   -- counts and totals, computed live
v_expense_payable          -- (payout_year, payout_month, hr_id) → amount, approved+gate-complete only
v_expense_payroll_reconciliation  -- claims vs links vs salary_records.expenses, per month
```

**Why `claim_ref` keeps today's values.** `trip_id` is already `UNIQUE` and carries `OUTSTATION-<id>`
and `TRP-000NN` across emails, audit rows, memory notes and the closing exports. Preserving it means
every existing deep link, every historical reference and every one of the audit's citations still
resolves after migration. Verified: **zero duplicate `trip_id` values in production**, so it is a
safe primary business key.

**Dead columns dropped:** `open_status` (blank on all 360), the eight `report_*` mirror columns (all
NULL/0), `geo_trip_routes` (0 rows), `outstation_policy_rules` stays but is **seeded** — it is empty
today, so every policy read silently falls back to code defaults.
**Done 2026-09-19** (migration `20260919021059_outstation_f28_drop_dead_items.sql`): `open_status`,
`report_hr_status`, `report_hr_notes` and `geo_trip_routes` are dropped, and the code that read and
wrote them is gone. The other six `report_*` columns and `outstation_policy_rules` (now seeded, and
read by the policy page) turned out to be **live**, so they stay. `imported_to_payroll_at` /
`_by` / `_batch_id` are replaced by `expense_payroll_links`.

---

## 4. Target state machine

```
                            ┌───────────── reopen (Super Admin, pre-payment) ─────────────┐
                            │                                                             │
  submitted ──── approve ──────► approved ──── link ────► in_payroll ──── batch paid ────► paid
      │  ▲                          │                          │
      │  │                          │                          └── unlink (before paid) ──┐
      │  └── resubmit ── returned ◄─┴── return                                            │
      │                     ▲                                                             │
      │                     └─────────────────── un-approve ◄───────────────────────────--┘
      │
      ├──── reject ────► rejected ──── reopen ────► submitted
      └──── cancel (employee, own claim, pre-decision) ────► cancelled
```

**Terminal states: `paid`, `cancelled`. Every other state has a supported exit.** That single change
removes the reason all four historical SQL interventions happened (F-10, §17 of the audit).

**Gates are not status.** `evidence_gate_status` and `workload_gate_status` stay orthogonal, exactly
as today: a claim can be `approved` while its photos are still missing. Approval and payment stay
separated — that separation is a deliberate owner rule and is preserved. `approved` +
both gates complete = eligible for `in_payroll`.

**One vocabulary.** `calculation_status`, `hr_status`, `open_status`, `hr_approved`,
`report_hr_status`, `approval_recommendation` and the workflow-registry aliases collapse into this
one column. `approval_recommendation` survives as advisory metadata on the event, never as state.

**Enforced by the database**, not by convention — a `CHECK` constraint, which today does not exist on
any status column in the module.

---

## 5. The payroll contract

This is the crux, and it is where the current design fails hardest.

### What is wrong today

- `phx_import_approved_expenses_to_payroll` refuses every batch status production ever reaches, so
  **0 of 360 rows have ever been imported**.
- If it *did* run, `SET expenses = coalesce(at.approved_expense, 0)` over a `LEFT JOIN` would **zero**
  every employee without an approved outstation claim — EGP 19,354 in July alone (F-03).
- Two live paths disagree about what is payable: the template takes approved rows only; the
  Automated Payroll wizard takes **pending rows too** (F-08).
- The payroll template silently **carries last month's figure forward** (F-07).
- The money therefore moves by hand, and July dropped EGP 2,354 (F-02).

### Proposed contract

**Three rules.**

1. **Outstation never writes to `salary_records`.** It exposes `v_expense_payable`. Payroll reads it.
2. **A link is the only record of payment.** `expense_payroll_links` has `UNIQUE(claim_id)` — a claim
   can be paid exactly once. Idempotent by construction.
3. **The write is additive.** `expenses = expenses + delta`, never `SET`. Non-outstation expenses
   cannot be destroyed by an outstation operation. **F-03 becomes structurally impossible.**

```sql
phx_link_expense_claims_to_payroll(p_batch_id uuid, p_actor_hr_id text)
  -- one transaction:
  --   select approved + gate-complete claims for the batch's period, not already linked
  --   insert expense_payroll_links      (UNIQUE(claim_id) makes re-running a no-op)
  --   update salary_records set expenses = expenses + delta   ← ADDITIVE
  --   update expense_claims set status = 'in_payroll'
  --   insert expense_claim_events
```

### When the payout period is already closed

**This is the gap the 2026-08-12 backlog ruling exposed, and it is not optional.**

`salary_records` carries the trigger `phx_prevent_closed_salary_detail_mutation`, which raises on
**any** insert, update or delete when the batch status is `approved` or `locked`:

```sql
if v_batch_status in ('approved', 'locked') then
  raise exception 'Payroll batch cannot be changed while status is %.', v_batch_status;
```

**All seven 2026 batches are `locked` or `approved`.** So for **241 of the 262 backlog rows —
EGP 86,408.00, payout periods 2026-02 to 2026-06 — the additive write is refused by the database.**
Approving one of them under the naive design would produce exactly the failure this whole
architecture exists to remove: a decision that can never become money.

**The rule:**

> **`payout_*` is resolved at approval to the earliest period whose batch is open or does not yet
> exist — never at import, never blindly to trip-month + 1.**

- The claim's own `incurred_year`/`incurred_month` never move, so the expense stays attributable to
  the month it happened in, for reporting and for the closing.
- If the natural period is closed, the resolved period differs, and an event
  `payout_reperiodized {from, to, reason}` records it. Nothing is silent.
- The queue says so before you decide: *"This trip's own period (2026-04) is closed — approving it
  pays in 2026-09."*

This also fixes something the current model never separated: today `payout_month` means both *when
the expense belongs* and *which payroll pays it*, which is why a re-save could silently move money
between periods. Two fields, two meanings.

**Where it is called.** At the Automated Payroll wizard's `p2_expenses` step — the moment the money
is actually decided today. Not a separate button on a separate page that nobody can make work.

**No `salary_records` schema change.** The link table is the contract; `salary_records.expenses` stays
the single total it has always been. The outstation share is derivable by join, so reconciliation
becomes a query instead of a person with a spreadsheet.

**"Paid" becomes true.** When the batch is marked paid, linked claims move to `paid`. The employee
portal stops telling every paid claimant "Not yet pulled into a payroll batch" (F-04) — the single
most visible falsehood in the module.

**Retired at the same time:** the previous-month carry-forward in the payroll template (F-07), and
the standalone "Import to payroll" button (F-01).

---

## 6. Decision architecture

Mirrors `phx_apply_direct_order_decision`, which already solves this in the neighbouring module.

```sql
phx_decide_expense_claim(
  p_claim_id        uuid,
  p_action          text,     -- approve | reject | return | reopen | unapprove | cancel
  p_expected_status text,     -- COMPARE-AND-SWAP: refuses if the row moved  ← F-09
  p_actor_hr_id     text,
  p_approved_total  numeric,  -- required on approve; always written  ← F-32
  p_reason          text,
  p_now             timestamptz
) returns jsonb
```

One transaction covers claim + event + (on approve) payout stamping. A failure rolls all of it back —
today's approve path writes the claim, then the ledger, then the report, then the audit row, with no
transaction around any of it (F-13).

**Bulk becomes one call.** `phx_decide_expense_claims(p_decisions jsonb)` — N decisions, one round
trip, one transaction. Today's bulk save is a serial `for` loop at ≈10–14 round trips per approved
row (F-23). It also matches the repo's own hard-learned rule that a heavy multi-write belongs in a
single plpgsql function, because a client timeout mid-loop still commits what it already wrote.

**Always write `approved_total`.** Today `normalizeApprovedAmount` stores NULL when the approved
figure equals the claim, making "reviewed and approved in full" indistinguishable from "nobody
touched it" (F-32). The target writes the figure every time; `decision_reason` is required only when
it differs from the claim.

**Invariants the DB enforces**, none of which exist today:
`approved_total ∈ [0, claimed_total]` · `decided_by`/`decided_at` set iff status is decided ·
a `rejected` claim cannot carry an approver (F-16 is one live row) · `payout_*` set iff approved.

---

## 7. Auditability

`expense_claim_events` is append-only and written **inside** the decision transaction — so an
unaudited state change is not possible rather than merely discouraged.

That closes the module's worst evidence gap: `audit_logs` today holds 116 rows for
`outstation_request` and **zero** for `outstation_expenses`, the table the money is actually read
from (F-06). Every one of the 70 July approvals and every amount cut is currently unattributable.

Each event records: actor, action, from→to status, from→to amount, reason, and the surface it came
from. The claim detail page renders the event list as a timeline — the same shape as the Direct
Orders order detail.

---

## 8. Target information architecture

**16 routes → 4.** One page per job, and each job completable without leaving its page.

| Route | Who | Job | Replaces |
| --- | --- | --- | --- |
| `/employee-portals/expenses` | every claimant | submit · capture evidence · see status, approved amount, payout month, paid state | `expenses` + `submit-expense` + `expense-submissions` (**3 sidebar rows → 1**) |
| `/admin/outstation/expenses` | Super Admin (+ CEO read) | the queue — decide inline, adjust amount, bulk, with the full trip in a side panel | `expense-approvals` + `expense-command?tab=queue` + the approval half of Historical Upload (**3 decision surfaces → 1**) |
| `/admin/outstation/expenses/insights` | Super Admin, CEO, managers | analytics, heatmap, leaderboards | `expense-command?tab=intelligence` + `expenses/dashboard` + `expense-dashboard` + `team-expenses` (**4 → 1**) |
| `/admin/outstation/expenses/imports` | Super Admin | genuine spreadsheet import only | the import half of Historical Upload |
| `/admin/outstation/policy` | Super Admin | rates and thresholds — **and seed it**, it is empty today | unchanged |

Retired routes get redirects, exactly as `/admin/outstation/requests` does today — the submission
email's deep link is live and must keep resolving.

### The queue, given a ~289-item backlog

The 2026-08-12 ruling keeps every undecided row open, so the queue opens with roughly **289 items on
one person**. It therefore **defaults to what is actionable**, with everything else one click away
and counted, never closed and never hidden:

| Queue view | Contents | Live size today |
| --- | --- | --- |
| **Needs a decision** *(default)* | payout period open or not yet created — the money you can still move | ~48 (21 deferred + ~27 live) |
| **Backlog — closed periods** | approved-today would pay in a future month (§5 re-period) | **241 · EGP 86,408.00** |
| Decided | approved · rejected · in payroll · paid | — |

Both counts are on screen at all times. The split is by **payability, not by age** — that is the
distinction that actually changes what you do with a row.

Triage inside the default view leans on work the module already does and currently wastes: the
flag-never-reject rule means every held claim already carries its reason, so the queue sorts
**flagged first, clean claims last**, and clean ones are the bulk-approve candidates.

### Journeys after the change

| Role | Today | Target |
| --- | --- | --- |
| **Employee (DSM — 91% of all usage)** | 3 sidebar rows; rejection email lands on a page that redirects them away | **1 row.** Every notification deep-links to the claim itself |
| **Approver** | 4 page transitions, via any of 3 pages that don't link to each other | **1 transition.** Queue is the landing page; decide without navigating |
| **Payroll** | a dead button, then transcribe by hand | the wizard's Expenses step links and reconciles; the variance is a number on screen |
| **CEO / managers** | 4 analytics pages | 1 |

**Context preservation.** Filters, month, scope and scroll move into the URL, and every decision
returns to the exact list state. There is no `returnTo` anywhere in the module today (F-21).

**Mobile.** The employee page is already the module's best surface (`MobileOutstationWizard`). The
approver queue gets the card-at-mobile / table-at-desktop split your admin-shell rule requires —
today the Historical Upload table is 20+ columns at ~2,900px with no card fallback (F-22).

---

## 9. Permissions

**Super Admin is the only approver. CEO is read-only. Finance stays 100% out.**
Owner ruling, 2026-08-12 — and it is now a design constraint, not a default.

**No approval chain is built.** An earlier draft proposed shipping an `expense_claim_approvals` table
with a single rung "in case". That is dropped. There is no `step_order`, no per-step status, no chain
resolution, and no vacant-seat handling to get wrong — the whole class of bug that
`buildApprovalChain` carries in Direct Orders (a vacant management seat silently shortens the chain)
cannot exist here. `phx_decide_expense_claim` takes no step parameter; a decision is one act by one
person, and the claim's own `status` is the complete record of it.

**The operational consequence is real and worth stating.** One approver is the module's throughput
ceiling: **27 of 39 live claims are sitting in `submitted` right now**, and three more arrived today.
Since the answer cannot be delegation, the architecture has to make one person fast. That is why the
approver page in §8 is a single queue with **inline decisions, bulk approve in one round trip, and
triage by exception** rather than a detail page you navigate into and back out of. Throughput is a
design requirement here, not a nice-to-have.

Two fixes:

- **`/api/approvals-hub/hub-data` gets scoped.** It calls `listOutstationRequests()` with no access
  argument while every sibling feed receives `viewAccess`. Contained today only because the route is
  Super-Admin-only (F-31) — a latent hazard, cheap to close.
- **Decouple `expenses:read` from marketing.** That one permission also gates the entire
  `/api/marketing-requests/**` namespace — 20 registry rows — so removing a role from Outstation
  silently kills their marketing approval rung. Marketing gets its own resource.

---

## 10. Notifications

| Event | Today | Target |
| --- | --- | --- |
| Submitted | ✔ to employee, Cc manager, Bcc Super Admin | unchanged |
| **Approved** | **nothing** | notify the employee, with the approved amount and payout month |
| Returned for correction | does not exist | notify, deep-linked to the editable claim |
| Rejected | ✔ in-app, Telegram and push — **never email** (owner, 2026-09-19); links to a page that redirects most roles away | deep-link to the claim |
| **In payroll / Paid** | **nothing** — the unused `notifyExpensesAddedToPayroll` (which would have emailed the employee) was **deleted 2026-09-19** at the owner's instruction | a new notice, built fresh — ask the owner which channels first |

Every link carries the claim id. Today only the submission email does (F-19, F-20).

---

## 11. Findings closed

| Closed outright (30) | How |
| --- | --- |
| F-01, F-03, F-08 | additive pull contract replaces the dead, destructive RPC |
| F-02 | linking replaces transcription; the variance is on screen |
| F-04 | `paid` is a real state |
| F-05, F-24 | one table, real FK, no synthetic reports, no ghosts |
| F-06 | events on the claim, inside the transaction |
| F-07 | carry-forward retired |
| F-09, F-13, F-16, F-23 | one guarded plpgsql decision; bulk = one round trip |
| F-10 | reopen / un-approve / return exist |
| F-11, F-25 | one status column, DB-constrained |
| F-12, F-32 | `approved_total` always written, on the claim itself |
| F-14, F-17, F-27 | counters become views; `updated_at` a trigger |
| F-15, F-33 | generated total + range check |
| F-18, F-21, F-22 | 4 routes, URL state, mobile split |
| F-19, F-20 | deep links + approval and paid notifications |
| F-26, F-28 | dead columns and dead code deleted |
| F-29, F-30, F-31 | strict id parsing, payout stamped once, hub feed scoped |
| **Needs your ruling first (2)** | F-15's two legacy rows (§13) · F-07's repeated figures (§13) |
| **Closed by this file (1)** | the module had no spec at all; this becomes `docs/specs/outstation-expenses.md` on approval |

---

## 12. Migration plan

Additive first, reversible at every step, and **no phase touches the 21 rows you deferred or any
locked payroll batch.**

| Phase | What | Reversible? | Risk |
| --- | --- | --- | --- |
| **0** | Create `expense_claims`, `expense_claim_events`, `expense_payroll_links`, `expense_imports`, the views. **No reads, no writes, no behaviour change.** | drop the tables | none |
| **1** | Backfill and **reconcile**: 39 requests + 327 real-import rows + 24 workflow rows with a surviving request + **9 ghost rows preserved as `source='import'` claims with their history noted**. Prove: claim count = 39 + 360 − 24 (the workflow duplicates) and total EGP matches to the pound. Read-only comparison report, nothing switched. **The 262 undecided rows migrate as `submitted` per the ruling, carrying `incurred_*` from their existing `payout_*` and leaving `payout_*` NULL** — so no closed period is baked in, and each one is re-periodized honestly if and when it is approved. | truncate and re-run | none — old tables untouched |
| **2** | Reads switch to `expense_claims` behind a flag. Writes still go to the old tables; a sync keeps the new one current. Compare the two for a full week. | flip the flag back | low |
| **3** | Writes switch to `phx_decide_expense_claim`. **The `.workflow` minting stops here.** Old tables become read-only. | flip back within the week | medium — the real cutover |
| **4** | Payroll link contract goes live in the wizard's Expenses step. First run is **dry-run only**: show what it *would* link against what the operator typed. Compare, then arm it. | do not arm | medium |
| **5** | IA collapse: 4 routes + redirects. | redirects stay either way | low |
| **6** | Drop the dead columns and the old tables, after a full payroll cycle on the new path. **Also converts `claimed_total` to `GENERATED` and adds its check** — the only step that needs the deferred two-row ruling (§13), and it is a two-row `UPDATE` by then. **`legacy_request_id`/`legacy_expense_id` need a real provenance column FIRST** — they are load-bearing for RLS, not just traceability (§15). | restore from backup | low |

**Order matters:** phases 0–2 are safe at any time. **Phase 3 should not land mid-payroll-assembly**
(≈the 10th). Phase 4 wants a fresh month.

**The 21 deferred rows** migrate as `submitted` claims carrying their history in
`expense_claim_events`, with the 2026-08-08 revert and the 2026-08-12 correction both recorded as
events. Their payability is unchanged. Your deferral stands.

---

## 13. Business decisions

**All three are settled or parked. Nothing in this proposal is waiting on an answer.**

1. ~~**Does a manager approve?**~~ **ANSWERED 2026-08-12: no. Super Admin only.** The approval-chain
   table is dropped from the design; §9 records what that removes and what it costs.
2. ~~**Two legacy rows contradict themselves**~~ **DEFERRED 2026-08-12 — the owner is deciding these
   on his own side. Do not chase it.** `OUTSTATION-31` (total 240 vs allowance 300) and
   `OUTSTATION-52` (364 vs 800). **This no longer blocks anything** — see the handling below.
3. ~~**The 262 undecided Jan–June rows**~~ **ANSWERED 2026-08-12: migrate as `submitted`, do not
   close them.** Handled by the payout re-period rule (§5) and the queue split (§8). Measured
   precisely: **262 rows — 241 in closed periods (EGP 86,408.00, 2026-02…2026-06) and 21 in open
   periods (EGP 13,435.44, the deferred set)**. The audit's "~EGP 99,000" was the two combined;
   the split is what matters, because only the second group can be paid in its own month.

### How decision 2 stays parked without blocking

The only thing that ever needed that ruling was the `claimed_total` **generated** column, because a
generated total cannot coexist with two rows whose components disagree with their total. So the
constraint moves to the end of the plan instead of the front:

- **Phases 1–5:** `claimed_total` is a **plain stored column**, backfilled from `total` — the figure
  the money actually followed. Both rows migrate intact; **nothing is invented and nothing is lost**.
- The original components are written to `expense_claim_events` at backfill, so the discrepancy is
  preserved in full and is queryable, not buried.
- Both rows carry a `data_quality_hold` flag, so they are visible in the queue as "components do not
  match the total" rather than looking clean.
- **Phase 6** converts `claimed_total` to `GENERATED` and adds the check — gated on the ruling, by
  which time it is a two-row `UPDATE`, not a migration blocker.

Net effect: **F-15 is contained immediately (the rows are flagged) and closed structurally later
(the constraint).** The build proceeds either way.

*Also still unanswered from the audit, and equally non-blocking:* B-82 / PD-0001 / B-7's repeated
figures (fixed allowance, or carry-forward artefact?), and B-175's EGP 1,849 with no July salary
record. Phase 1's reconciliation report is what will answer both without anyone having to remember
them.

---

## 14. What deliberately does not change

- **Super Admin is the only approver.** Ruled 2026-08-12. No manager rung, now or later, unless that
  ruling is revisited — and revisiting it would be a new table, not a config flag.
- **The evidence gates.** Two photos + CRM workload, and the separation of acceptance from payment.
- **"The system flags, it never rejects."** Every automated check keeps holding rather than refusing.
- **One allowance per employee per calendar day.**
- **Finance stays 100% out of Outstation.**
- **The CEO is on no outstation email, in any slot.**
- **The payroll module's own schema.** No new columns on `salary_records`.
- **`claim_ref` values.** `OUTSTATION-57` and `TRP-00285` keep meaning what they mean.

---

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| A backfill that loses or duplicates money | Phase 1 is read-only and must reconcile to the pound before phase 2; `trip_id` is already unique, so the business key is safe |
| Cutover lands mid-payroll | Phase 3 is scheduled away from batch assembly (~the 10th); phase 4's first run is dry-run |
| The additive payroll write double-pays on a re-run | `UNIQUE(claim_id)` on the link table makes re-running a no-op |
| Scope creep into the payroll module | The contract is one view + one function; `salary_records` gains no columns |
| Doing it all at once | Phases 0–2 deliver the reconciliation report — real value — before any write path changes |
| **241 backlog claims approved into a closed period** | Impossible by construction: `payout_*` is resolved at approval to an open period, and the `salary_records` trigger would refuse the write regardless. The re-period is recorded as an event and shown before you decide |
| **A 289-item queue buries the live claims** | The queue defaults to the payable set (~48) with the backlog counted beside it, not merged into it (§8) |
| **Phase 6 drops `legacy_request_id`/`legacy_expense_id` and silently widens who reads the ledger** | `expense_claims_select_access` ([PR #2065](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2065), live on staging and production since 2026-08-12) keys its admin arm on those two columns to keep `phx_can_manage_payroll()` (ledger-derived rows) apart from `phx_can_manage_outstation()` (request-derived rows) — the two guards are disjoint; neither role list contains the other. The policy's own fallback arm, written for rows with neither legacy id, is `phx_can_manage_payroll() OR phx_can_manage_outstation()`. Drop the columns with nothing to replace them and every claim falls into that fallback — a District/Regional/National Sales Manager gains the full ledger, not just their own requests. **Phase 6 needs a real provenance column landed and backfilled before the drop, not in the same migration.** Verified live on staging 2026-08-12: a District-Manager session and a Finance-Manager session each see exactly what their respective legacy guard predicts (24/24 and 293/293), which is the behavior this column split is protecting. |

---

## 16. Suggested sequence

Phases 0–1 first, on their own. They change no behaviour and produce the thing you most lack today:
**a reconciliation report that shows, per month, what the module approved against what payroll
actually paid.** That alone would have caught B-175's EGP 1,849 and B-74's EGP 505 in July.

If the report is right, the rest of the plan is credible. If it is wrong, we learn that before
anything is switched.

---

*Proposal only. No code, schema, data, branch or deployment has been changed.*
