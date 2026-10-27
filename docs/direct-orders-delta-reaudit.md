# Direct Orders — Current-State Delta Re-Audit

**Read this alongside the previous forensic handoff, not instead of it.** That package is now
historical evidence taken at `e6955e34`. This document records what the code actually does today.

| | |
| --- | --- |
| Audit date | 2026-08-12 (Africa/Cairo) |
| Previous baseline | `e6955e34f51ec398630ce865dea7c37f417c5404` — 2026-08-11 18:58 Cairo |
| Current state audited | `76e4016b03f1c730edcda2877a3b9761be6ec9c1` — 2026-08-11 23:37 Cairo |
| Method | Read current source at `origin/main`; queried production Postgres for RLS/policy state; ran the module's 36 test files; broke one new guard to prove its assertion fires. |
| Verified against | Production `/api/healthz` → `revision: 76e4016b…` |

---

## 1. Current snapshot

| Layer | SHA | Relationship |
| --- | --- | --- |
| **CURRENT PRODUCTION** | `76e4016b` | `/api/healthz` returns this revision. Railway, `europe-west4`. |
| **CURRENT MAIN** | `76e4016b` | Merge of PR #2031 `feat/direct-orders-one-place`. **Identical to production.** |
| **CURRENT LOCAL** | `862056ad` on `codex/finance-six-module-access` | **Stale. Diverged.** Does *not* contain `e6955e34`, and does *not* contain any Direct Orders work. |

**The local checkout is not a valid audit target and was not used as one.** It sits on a branch that
forked before the baseline: `git merge-base --is-ancestor e6955e34 HEAD` → false. It is behind
`origin/main` by 26 commits and ahead by 2 unrelated Finance-navigation commits
(`9d1271d1`, `862056ad` — both already on `main` as #2010 and #2025 via separate PRs).

Its working tree is also dirty with **41 modified + 9 untracked files**, including Direct Orders
files (`src/lib/direct-orders/service.ts`, `types.ts`, `collection-rules.ts`,
`app/api/direct-orders/[id]/collection/`, `tests/direct-orders-collection.test.ts`). Those are a
**pre-merge copy of work already shipped** as #2014 (`411028e8`, "let Finance record collections
against approved orders"), which is on `main` and live. They are not new work and they are not
in production; nothing in this audit is based on them.

Everything below was read from a clean worktree at `F:/Phoenix Workforce/_wt-do-onephase`, verified
byte-identical to `origin/main` (`git diff c26ae88a 76e4016b` → empty) and therefore byte-identical
to what production is serving.

---

## 2. Executive delta

Six functional commits landed between `e6955e34` and `76e4016b`, all on 2026-08-11 between
22:40 and 23:12 Cairo, all in PR #2031. **21 files changed.** In substance:

1. **The returned-order dead end is closed.** A real same-request correction path now exists end to
   end: `reviseDirectOrder` service → `POST /api/direct-orders/:id/revise` → a prefilled
   `DirectOrderCorrectResubmit` panel on the order itself. Same id, same chain, resumes at the
   returning rung.
2. **Finance authority is centralised in one module.** `finance-authority.ts` is now the only file
   in the module naming the HR ID; a test enforces that no other Direct Orders file does. The
   restriction itself was deliberately **not** relaxed.
3. **The sales-month status guard now exists server-side.** `deriveDirectOrderSalesMonthChange`
   refuses a month on any non-approved order. This was the real hole the previous review found.
4. **`draft` was honestly retired from the user journey**, and the fake "Finish Draft" queue that
   referenced it was deleted.
5. **The IA was re-cut by task, not by permission level.** `admin-tools` and `customers` are gone;
   `Pharmacy Control` / `Reports & Monitoring` / `Commercial Controls` replace them, and `my-orders`
   + `all-orders` collapsed into one `Orders` view with a scope filter.
6. **Workspace loading became view-aware** — two of six views no longer pay for the full report read.

What did **not** change: the Finance golden rule, the Held architecture, the collection model, the
RLS posture, and server-side Orders pagination.

---

## 3. Previous findings status

| Classification | Count | Findings |
| --- | --- | --- |
| **FIXED** | 6 | 2, 3, 4*, 11, 13, 23 |
| **PARTIALLY FIXED** | 6 | 1, 9, 10, 16, 18, 22 |
| **STILL OPEN** | 7 | 6, 8, 12, 15, 17, 19, 21 |
| **DESIGN CHANGED** | 3 | 5, 14, 20 |
| **PREVIOUS FINDING INCORRECT** | 1 | 7 (the rule was correctly described — re-confirmed, not overturned; counted here as "the finding is not a defect") |
| **UNKNOWNS RESOLVED** | 4 of 5 confirmed | 24A, 24B, 24C, 24E confirmed; 24D folded into Finding 1 |

\* Finding 4 is FIXED **as stated** (the literal is no longer scattered) but the underlying model is
still person-bound by deliberate owner decision. See the row.

---

## 4. Delta table

| # | Previous state | Current state | Class | Evidence | Remaining work |
| --- | --- | --- | --- | --- | --- |
| **1 — Returned/resubmit** | Registry declared `returned → submit`, UI said "Fix and resubmit", but `submitDirectOrder` always INSERTed and hard-coded `status:"draft"` in its registry check. No endpoint, no prefill. | Real path exists. `reviseDirectOrder` **UPDATEs the same row** with a compare-and-swap on `status='returned'`, never inserts. Chain untouched; resumes at `resolveActiveStep`. Prefilled panel on the order page. | **PARTIALLY FIXED** | `service.ts:3082-3261`; `app/api/direct-orders/[id]/revise/route.ts`; `direct-order-correct-resubmit.tsx`; `tests/direct-orders-second-review-fixes.test.ts:191-213` | Only qty/deal/bonus/discount/collection-date editable. No resubmit from the Needs Action row itself — user must open the order. |
| **2 — Draft** | `draft` status existed; Needs Action offered "Finish Draft"; no save-draft path. | The fake queue is **deleted**, with the reasoning recorded in place. `draft` retained as DB default + registry status only. | **FIXED** (as **LEGACY STATE**) | `needs-action.ts:61-62, 210-224`; `DirectOrderNeedsActionKind` no longer has `finish_draft` | None. Implementing real drafts = adding write paths, not re-deriving state. |
| **3 — Sales-month guard** | `setDirectOrderSalesMonth` validated month FORMAT and caller identity only. A `draft`/`held`/`returned` row could receive a month via direct API. | Server-side status rule added. Assign requires `status='approved'`; clear allowed wherever a month is stored. | **FIXED** | `finance-authority.ts:89-120`; called at `service.ts:5290-5295`. **Proved:** removing the guard makes the test's headline assertion fire — `a sales month must be refused on a draft order`, actual `true` ≠ expected `false`. | None. |
| **4 — Finance person-hardcoded** | HR ID literal reachable from several call sites. | Exactly one file names it: `finance-authority.ts:27`. `collection-rules.ts` and `service.ts` re-export. A test asserts no other Direct Orders file contains the literal. | **FIXED** (scatter) / **unchanged by design** (model) | `finance-authority.ts`; `tests/direct-orders-second-review-fixes.test.ts:118-131` | **Access was NOT widened.** A second Finance Manager (`F-999`) is denied — asserted. Controlled by **HR ID + Super Admin**, not role/permission. |
| **5 — SFE vs Super Admin** | Docs inconsistent about who decides pharmacy validations. | Rule is unambiguous and unchanged: validation decisions are `scope==="system" \|\| role==="Super Admin"`. SFE Manager holds the first approval rung + registry + caps view, but **not** validation decisions. | **DESIGN CHANGED** (documented, not altered) | `pharmacy-validation.ts:103-111`; `service.ts:2087-2097`, `5080-5086`; `caps.ts:76-90`; `docs/specs/direct-orders.md:139-141` | None — see §6 for the full matrix. |
| **6 — Held outside chain** | Held seeds zero approval steps until release. | **Unchanged.** `submitDirectOrder` sets `chain = []` when held; steps are seeded at revival instead. | **STILL OPEN** (deliberate) | `service.ts:2904-2909, 2939-2953`; comment: "a chain built today could name yesterday's managers" | Held is now surfaced to the requester via the `verify_customer` Needs Action group and an expiry warning, so it is no longer invisible — but it is still architecturally outside the chain. |
| **7 — Finance golden rule** | CEO approval does not inject; only sales-month assignment does. | **Re-confirmed unchanged.** The decision RPC injects only `elsif v_row.sales_month is not null`. No month → no rebuild. | **CONFIRMED / not a defect** | `supabase/migrations/20260803160000_…sql:72-83`; injection call sites are exactly two: `service.ts:5312` and that RPC | None. Nothing since the baseline touched it. |
| **8 — Collection not a ledger** | ~1 paid amount, 1 payment date, 1 remaining; later calls replace values. | **Unchanged in substance.** Three columns on `direct_order_requests`; each write replaces. No payment table exists in any migration. | **STILL OPEN** | `service.ts:5358-5459`; `collection-rules.ts`; foundation migration `…140000:72-73`. Grep for `create table …payment/collection` → **zero hits**. | See §7 for the full CURRENTLY IMPLEMENTED vs NOT IMPLEMENTED split. Blocking for the Finance Manager phase. |
| **9 — One-place IA** | Eight desks in one undifferentiated "Admin Tools" grid. | Re-cut into three task-named tabs. But each tab still renders a **grid of `<Link>` cards to separate full routes** — the user still leaves the workspace. | **PARTIALLY FIXED** | `direct-orders-workspace.tsx:80-82, 94-128, 694-719`; `workspace-data.ts:43-58` | The "Direct Orders → tab → card → separate page" shape survives; only the naming and grouping improved. Four measured reasons for keeping the routes are recorded in the spec (§28). |
| **10 — Pharmacy Control** | Recommendation to consolidate 5 capabilities. | Conceptually consolidated: one tab groups `/validations`, `/held`, `/pharmacies`, `/pharmacy-variances`, `/cleanup`. Physically still five routes. | **PARTIALLY FIXED** | `PHARMACY_CONTROL_DESKS`, `direct-orders-workspace.tsx:80` | Context is **not** preserved — each card is a full navigation away. Old routes still exist and do not redirect. |
| **11 — Reports consolidation** | Report / Rep Counters / Reconciliation fragmented. | Grouped under one `Reports & Monitoring` tab. Report component is shared by both shells. | **FIXED** (grouping) | `REPORT_DESKS`, `direct-orders-workspace.tsx:81`; `direct-order-report-workspace.tsx` used by both `app/(admin)/…/report` and `app/employee-portals/…/report` | Still three routes; share links and exports unchanged and intact. |
| **12 — Caps / commercial controls** | Under generic Admin Tools. | Has its own `Commercial Controls` tab, tab gated on `scope==="all"`. | **STILL OPEN** (partially addressed) | `CONTROL_DESKS`; `caps.ts:76-95` | **Role mismatch:** the *tab* requires `scope==="all"`, but the *service* admits `Super Admin, SFE Manager, CEO` to view and only Super Admin to edit. CEO/SFE can reach `/caps` by URL but see no tab. |
| **13 — Customers tab** | A primary tab whose content explained that lookup happens in New Order. | **Deleted.** `customers` now aliases to `pharmacy-control`, and ordinary requesters never see that tab. | **FIXED** | `workspace-data.ts:88-96, 286-292` | None. |
| **14 — Admin/Portal duplication** | Consolidation claimed zero duplicated pairs. | **Holds.** Form, detail, report and workspace are each ONE component consumed by both shells; the two shells differ only by a `variant` prop. | **DESIGN CHANGED / verified** | Each of `DirectOrderSubmitForm`, `DirectOrderRequestDetail`, `DirectOrderReportWorkspace`, `DirectOrdersWorkspace` has exactly 2 page consumers + 1 definition | No duplicated business behavior reappeared. |
| **15 — Route counts** | Handoff quoted inconsistent numbers (17 / 19→13 / 5 / 2). | Clean inventory in §8. | **STILL OPEN** (as a documentation defect) | `git ls-files` counts, §8 | The previous numbers conflated categories; §8 replaces them. |
| **16 — Workspace loading** | Every workspace open ran `getDirectOrderReport()` (unbounded select over all requests). | **View-aware.** `VIEWS_NEEDING_FULL_REPORT` = overview, needs-action, orders, reports. Pharmacy Control and Commercial Controls now skip it entirely. Validation queue similarly gated to 3 views. | **PARTIALLY FIXED** | `workspace-data.ts:181-254` | **2 of 6 views improved (33%).** Overview and Needs Action still load everything — knowingly, because their counters span the whole scope and deriving from `myOrders` would under-report. Orders paging still client-side (25/page). |
| **17 — Search** | Recommended server-backed search. | **Still client-side**, over rows already in memory. Fields: requester, pharmacy name, pharmacy code, product, area, region, covering rep, order id. No debounce (it filters an in-memory array). | **STILL OPEN** | `direct-orders-workspace.tsx:323-357` | **Cannot leak out of scope** — rows only ever come from `getDirectOrderReport(access)` / `listMyDirectOrders(access)`, both of which `assertPermission` and tier by scope server-side. Client filtering only narrows. |
| **18 — Needs Action** | Five queues on five routes; a fake draft queue. | One inbox, five real kinds: `approve`, `correct`, `verify_customer`, `assign_month`, `decide_customer`. Empty groups omitted. Badge = `countDirectOrderNeedsAction`, the same sum. | **PARTIALLY FIXED** | `needs-action.ts` (pure, 317 lines) | `assign_month` is fed from the full report load (see 16). Scope is inherited from upstream services — the file enforces nothing itself, by design. |
| **19 — Order detail context** | Back always went to a generic destination. | **Unchanged.** `backHref` is a hard-coded string per shell. | **STILL OPEN** | `app/(admin)/…/[id]/page.tsx:49`; `app/employee-portals/…/[id]/page.tsx:55-56` | Entering from Needs Action, Orders, Reports or Pharmacy Control all return to the same place, losing tab and filter. **Also stale:** the admin label reads "Back to My Direct Orders" — a tab name that no longer exists. |
| **20 — New Order** | Pricing/caps/invoice concerns. | Server-authoritative pricing via `resolveDirectOrderPricing`, the **same helper** `reviseDirectOrder` calls — asserted by a test that a second copy must not exist. Sticky mobile CTA. | **DESIGN CHANGED** | `direct-order-submit-form.tsx`; `service.ts:2707` ("ONE definition, called by both"); `tests/direct-orders-approval-flow.test.ts:268-274` | **Modes are separated by component, not by a mode flag**: New Order is its own route/form; correction is a separate narrow panel on the order. Product and pharmacy are structurally absent from the correction form. |
| **21 — DB/RLS** | RLS enabled, zero policies, service-role only. | **Live production check:** 8 direct-order tables, all `relrowsecurity = true`. **6 have zero policies; 2 have exactly one** — `direct_order_pharmacy_validations` and `direct_order_report_share_links`, each a `service_role`-only `ALL` policy with `USING true`. | **STILL OPEN** (posture intact; doc drifted) | `pg_class` / `pg_policy` query, 2026-08-12 | **Not a fail-open**: the policies name `service_role` only, so `anon`/`authenticated` remain denied by default. But `docs/specs/direct-orders.md:135` says "zero policies" — now false. |
| **22 — Workflow registry** | Registry drift could make the module disappear. | Still a **runtime dependency**. `assertDirectOrderWorkflowTransition` → `assertWorkflowRegistryRuntimeTransition`, which throws `WorkflowRegistryTransitionError` on an unknown transition or a next-status mismatch. | **PARTIALLY FIXED** | `workflow.ts:61-74`; `workflow-registry/runtime.ts:7-34` | **Real improvement:** `reviseDirectOrder` passes the row's *real* status, which finally exercises the registry's long-declared `returned → submit` edge instead of the hard-coded `"draft"` literal. Failure mode is still throw-on-drift. |
| **23 — Documentation drift** | Multiple specs describing different generations. | **One authoritative spec** (`docs/specs/direct-orders.md`, 2026-08-11, 142 lines). The other two carry a `> **SUPERSEDED (2026-08-11)**` banner at line 1. | **FIXED** | The three files in `docs/specs/` | One factual error remains — the "zero policies" line (Finding 21). Correction given in §10. |

### Finding 24 — previous UNKNOWNs

| | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| **A** | `au.f_monthly_attribution` / `au.f_monthly_achievement` | **CONFIRMED** | `f_monthly_attribution` is defined in `supabase/migrations/20260713014207_au_monthly_attribution_engine.sql` (revoked from public/anon/authenticated, granted to `service_role` only). `f_monthly_achievement` is defined and successively amended across **6** migrations, latest `20260802051500_au_direct_reaches_region_dm.sql`. Achievement = attribution (SoS actuals, seat-resolved "as of" the period) rolled up rep → DM → region → line. Direct orders feed it via Branch B1. |
| **B** | Invoice-capture storage/security | **CONFIRMED** | `invoice-capture.tsx` → `POST /api/direct-orders/invoice-extract` → `invoice-extraction.ts` / `invoice-scan.ts`. JPEG-only, live-capture-only (the same rule as marketing and outstation evidence — a gallery upload arrives as another MIME type and is refused, because the claim the evidence makes is "taken at this place, at this time"). Validation evidence photos are served as **signed URLs with a TTL** — one of the four stated reasons the desks stay separate routes. |
| **C** | `buildApprovalChain` with a vacant management rung | **CONFIRMED — the rung is silently skipped.** | `service.ts:322-342`. The walk is `cursor = me?.managerHrId ?? null`, then `cursor = manager?.managerHrId ?? null`. A vacant seat yields `null`, the `while` loop ends, and the chain is simply shorter — no error, no placeholder, no vacancy detection. A requester whose manager seat is empty gets `[SFE Manager, CEO]`. Cycle guard and `CHAIN_DEPTH_CAP` are present; a vacancy check is not. |
| **D** | Returned-order prefill/resubmission | **CONFIRMED** — see Finding 1. | — |
| **E** | Registry consumed outside Direct Orders | **CONFIRMED — exactly one external consumer.** | `direct_order_pharmacies` appears in 20 files. All application code is inside `src/lib/direct-orders/`. The one cross-module consumer is `supabase/migrations/20260719152000_marketing_roi_refresh_facts_direct_branch.sql:382`, which joins it (plus `direct_order_requests` filtered to `status='approved' and reversal_of_request_id is null`) to build the **Marketing ROI** direct branch. |

---

## 5. Current Direct Orders architecture

```
Direct Orders  (ONE sidebar entry per shell)
│
├─ Overview            everyone      counters + Needs Action inline + recent orders
├─ Needs Action        everyone      5 kinds: approve · correct · verify_customer · assign_month · decide_customer
├─ Orders              everyone      one list; scope is a FILTER (Mine / All in my scope), not two tabs
│
├─ Pharmacy Control    Super Admin, or scope==="all"        ─┐
│   ├→ /validations    (separate route, full page)           │
│   ├→ /held           (separate route, full page)           │  grouped by task,
│   ├→ /pharmacies     (separate route, full page)           │  still separate routes —
│   ├→ /pharmacy-variances (separate route, full page)       │  rendered as a grid of
│   └→ /cleanup        (separate route, full page)           │  <Link> cards
│                                                            │
├─ Reports & Monitoring   scope>own, or Finance              │
│   ├→ /report         (separate route, full page)           │
│   ├→ /rep-counters   (separate route, full page)           │
│   └→ /reconciliation (separate route, full page)           │
│                                                            │
└─ Commercial Controls    scope==="all"                      │
    └→ /caps           (separate route, full page)          ─┘

Order actions live ON the order:  /admin|portal/direct-orders/[id]
    approve · reject · return · correct & resubmit · sales month · collection · cancel held
```

**Honest answer to "is it one place?"** — It is one *entry point* with one persistent shell and
role-shaped internal navigation. It is **not** one surface: eight of the module's workflows are
still full-page navigations away, now reached from three task-named tabs instead of one
permission-named grid. The spec records four measured reasons for that (server component, per-row
draft state, must-not-cache plan, signed-URL TTL).

---

## 6. Current role matrix

Rebuilt from `src/lib/auth/permissions.ts` by parsing each role block's boundaries (a naive grep
here spills into the adjacent block and produces a wrong answer).

| Role | `direct_orders` grant | Sees module | Create | Needs Action kinds | Order scope | Pharmacy controls | Reports | Finance | Commercial controls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Super Admin** | all actions | ✅ | ✅ | all 5 | `all` | full: validate, registry, held, cleanup, variances resolve | ✅ | ✅ (via system-admin branch) | view + **edit** |
| **CEO** | read, approve, export | ✅ | ❌ | approve | `all` | variances **view** only; no validation decisions | ✅ | ❌ (sees month, cannot set) | view only, **no tab** (tab needs `scope==="all"`) |
| **SFE Manager** | read, export, approve | ✅ | ❌ | approve (first rung) | `all` | registry ✅, variances view ✅, **validation decisions ❌** | ✅ | ❌ | view only, **no tab** |
| **Finance Manager** | read, export | ✅ | ❌ | assign_month *(only if HR ID matches)* | `all` | ❌ | ✅ | **only B-185 specifically**, not the role | ❌ |
| **National Sales Manager** | read, create, update, approve, export | ✅ | ✅ | approve, correct, verify_customer | `line` | ❌ | ✅ | ❌ | ❌ |
| **Regional Manager** | read, create, update, approve, export | ✅ | ✅ | approve, correct, verify_customer | `hierarchy` (subtree) | ❌ | ✅ | ❌ | ❌ |
| **District Manager** | read, create, update, approve, export | ✅ | ✅ | approve, correct, verify_customer | `own` | ❌ | ❌ (no tab: `canSeeAllOrders` false) | ❌ | ❌ |
| **Product Manager** | read, create, update, export | ✅ | ✅ | correct, verify_customer | `own` | ❌ | ❌ | ❌ | ❌ |
| **Group Product Manager** | read, create, update, export | ✅ | ✅ | correct, verify_customer | `own` | ❌ | ❌ | ❌ | ❌ |
| **Medical Rep** | **none** | ❌ | ❌ | — | — | — | — | — | — |
| Employee, Manager, Training Manager, Marketing Manager, Talent Acquisition, Financial Advisor | **none** | ❌ | ❌ | — | — | — | — | — | — |

**Medical Rep has no Direct Orders grant.** Stated plainly as requested. They are redirected by
`assertDirectOrdersPageAccess` to their own landing page.

PM and GPM go **straight to CEO** — `buildApprovalChain` skips the management ladder for those two
roles (`service.ts:319-322`).

---

## 7. Current business-critical rules

**Held.** A new order against an unverified pharmacy is inserted `status='held'`, `held_at=now()`,
and **zero approval steps**. It is in nobody's approval queue. It expires 14 days after being
raised (`expireStaleHeldDirectOrders`). The chain is built only at revival, by the same
`buildApprovalChain` submit uses. Releasing does **not** skip review — the SFE rung is still first.

**Approval.** SFE Manager (role rung) → the requester's live-resolved management ladder (person
rungs) → CEO (role rung). Approving the SFE rung *is* the pharmacy confirmation; no separate
Super Admin rung exists (removed by owner rule 2026-08-04).

**Return & correction.** The returning rung stays `pending` — the decision RPC only writes a step
row for approve/reject — so `resolveActiveStep` resumes at exactly that rung. Correction requires a
written note, mirrors the approver's required reason, and reprices from scratch through the same
helper a new order uses.

**Finance month.** Requires `status='approved'`, server-enforced. Changing a month rebuilds **both**
periods (old and new), sequentially, de-duplicated.

**Injection (the golden rule).** CEO approval injects nothing. `phx_rebuild_direct_order_sos_batch`
runs from exactly two places: `setDirectOrderSalesMonth`, and the decision RPC guarded by
`elsif v_row.sales_month is not null`. No month → no sales anywhere.

**Collection.**

| CURRENTLY IMPLEMENTED | STILL PLANNED / NOT IMPLEMENTED |
| --- | --- |
| One paid amount, one payment date, one derived remaining amount, on the request row | Multiple payment records per order |
| Approved-only; refuses draft/rejected/held/reversed | Append-only ledger |
| Remainder **derived server-side**, never accepted from the caller | A payments table (none exists in any migration) |
| Overpayment refused (rounds before comparing) | Transfer proof attached to a payment |
| Future-dated payment refused, in Cairo time | Finance verification of proof |
| Explicit clear-to-nothing state, all three columns reset together | Accurate multi-installment partial collection |
| Every write audited to `audit_logs` **and** `direct_order_events` | Correction that cannot overwrite historical financial evidence |
| Never touches `sales_month`, never re-injects — asserted by test | |

**Payment history is reconstructible only from the event/audit trail, not from the data model.** The
current amount is authoritative for outstanding balance; the *sequence* of payments is not
representable. A correction **does** overwrite the previous values in place (the prior values survive
only in `audit_logs.old_values` and the event metadata). This is the single most important
constraint for the coming Finance Manager architecture.

**Reversal.** A reversal request builds its own chain; on approval the original flips to `reversed`
and the original month is rebuilt.

---

## 8. Current route/navigation inventory

Categories kept separate deliberately — the previous handoff's conflicting numbers came from
collapsing them.

| Category | Count | Detail |
| --- | --- | --- |
| **Maintained page files** | **17** | 12 admin (`/`, `/[id]`, `/new`, `/report`, `/caps`, `/cleanup`, `/held`, `/pharmacies`, `/pharmacy-variances`, `/reconciliation`, `/rep-counters`, `/validations`) + 4 portal (`/`, `/[id]`, `/new`, `/report`) + 1 public share (`/share/direct-orders/[token]`) |
| **User-visible destinations** | **13** admin / **4** portal | Every page file above is reachable; the admin desks are reached from the three authority tabs |
| **Deep-link routes** | **17** | All bookmarkable and refresh-safe; plus `?view=` on the two workspace roots |
| **Legacy redirect rules** | **5** | In `next.config.ts:187-194` — `/sales/direct-orders-tools` → `?view=pharmacy-control`; both `/…/approvals/direct-orders` → `?view=needs-action`; both `/…/approvals/direct-orders/:id` → `/…/direct-orders/:id`. True 308s. |
| **Legacy `?view=` aliases** | **4** | `my-orders`→`orders`, `all-orders`→`orders`, `customers`→`pharmacy-control`, `admin-tools`→`pharmacy-control` |
| **Public share routes** | **1 page + 3 API** | `/share/direct-orders/[token]` + `feed`, `file`, `live` |
| **API routes** | **36 total** | 29 core `/api/direct-orders/**` · 3 `/api/share/direct-orders/**` · 3 `/api/cron/direct-orders-*` · 1 `/api/approvals/direct-orders/pending-count` |
| **Sidebar entries** | **2** | one per shell (`/admin/direct-orders`, `/employee-portals/direct-orders`), both `direct_orders:read`, both badged `direct-orders-needs-action` |
| **Internal workspace views/tabs** | **6** | overview · needs-action · orders · pharmacy-control · reports · controls (a tab the viewer cannot use is absent, not disabled) |

---

## 9. Current performance architecture

| View | Full report read? | Validation queue read? | Always runs |
| --- | --- | --- | --- |
| **Overview** | **YES** (if `canSeeAllOrders \|\| canAssignFinanceMonth`) | YES (count only) | `getDirectOrderWorkspaceData` + `listMyDirectOrders` |
| **Needs Action** | **YES** | YES (count only) | same |
| **Orders** | **YES** | no | same |
| **Reports** | **YES** | no | same |
| **Pharmacy Control** | **NO** ← improved | YES (list) | same |
| **Commercial Controls** | **NO** ← improved | no | same |

**Quantified:** the expensive read (`getDirectOrderReport`, an unbounded select over
`direct_order_requests` decorated in JS) previously ran on **6 of 6** workspace views. It now runs on
**4 of 6** — a 33% reduction in views paying for it, and the two removed are precisely the ones a
Super Admin opens to do pharmacy work. The per-query cost of the remaining four is unchanged.

Two reads always run regardless of view: `getDirectOrderWorkspaceData` and `listMyDirectOrders`.
Four reads issue concurrently via `Promise.all`, each optional one short-circuiting to a constant.

**Orders pagination is still client-side, 25 rows/page, over a server-scoped set.** The spec records
why a `.range()` addition would be wrong: all three scope tiers currently compare on a *normalised*
value in JS (`canonicalHrIdKey`, `line.trim().toLowerCase()`) against *raw* stored values, so
pushing the filter into SQL first requires making the comparison basis consistent. Doing it in the
wrong order silently returns **fewer** rows than the viewer is entitled to. The tiers fail closed,
so the risk is under-showing, not over-showing.

---

## 10. Current security findings

**Protection stack (verified end to end):**

```
Browser
  → Next.js route / server action
      ├ assertSameOriginMutation      (CSRF, every mutating route)
      └ assertDirectOrdersPageAccess  (UX bounce only — NOT the boundary)
  → domain service
      ├ assertPermission(ctx, "direct_orders", action)
      ├ named capability helper (canSetDirectOrderSalesMonth, canDecide…, canManage…)
      └ ownership / status precondition
  → getSupabaseAdmin()  (service-role)
  → Postgres: RLS enabled, no anon/authenticated policy → denied by default
```

**No critical operation's only protection is frontend visibility.** Each of the five capability
gates was read in the service, not inferred from page visibility. `canCorrectAndResubmit` returned
to the client is explicitly documented as mirroring the server guard, and the server refuses
independently.

**Open items:**

1. ~~**Doc-vs-reality drift (low, but it is a security doc).**~~ **FIXED AND LIVE — PR
   [#2032](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2032), merged as `6cfc1aab`,
   serving in production (`/api/healthz` confirmed 2026-08-12 00:32 Cairo).**
   `docs/specs/direct-orders.md:135` claimed RLS was enabled with "**zero
   policies**" on the direct-order tables. Production has **two** `service_role`-only policies
   (`direct_order_pharmacy_validations`, `direct_order_report_share_links`). Never a fail-open — no
   direct-order table grants `anon` or `authenticated` any policy — but the sentence a reviewer
   would rely on was false, and checking it would have led them to suspect the code rather than the
   spec. Corrected on branch `codex/direct-orders-rls-policy-doc` (`cdcb946f`), docs-only, with the
   full eight-row `pg_class`/`pg_policy` result in the commit message.
2. **Caps tab/service role mismatch** (Finding 12): CEO and SFE Manager may `listDirectOrderCaps`
   but get no Commercial Controls tab. Reachable by direct URL only. Not a leak — the service is the
   gate and permits them — but the UI and the service disagree about who this page is for.
3. **Vacant management seat silently shortens the approval chain** (Unknown C). Not exploitable, but
   an order can skip a rung with nothing on screen saying so.

---

## 11. Tests / verification

**Ran:** all 36 Direct Orders test files, via a generated runner invoking each module's exported
entrypoint with the repo's own loader (`--experimental-strip-types` + `tests/alias-loader.mjs`).

```
modules passed: 36
modules failed: 0
EXIT_CODE=0
```

**Not run, and why:** the full `pnpm run test` suite, `lint`, `typecheck` and `build`. Free RAM was
**1.45 GB** with 10 Claude Code sessions live on a 16 GB machine, and repo policy is to validate only
on the owner's word. CI re-runs the identical content on any PR head commit. The 36 modules above
were run because this task explicitly asked for the regression coverage.

**Proof the new guard is real** (not just "the suite went green"). The Finding 3 rule was copied,
mutated to delete the approved-status refusal, and the test's own assertion replayed against it:

```
PROVEN — the headline assertion fired when the guard was removed.
  assertion message : a sales month must be refused on a draft order — only an approved order can be booked
  actual            : true
  expected          : false
```

**Coverage by flow:**

| Flow | Test file | Proves | Result |
| --- | --- | --- | --- |
| Returned / resubmit | `direct-orders-second-review-fixes.test.ts` | `reviseDirectOrder` UPDATEs the same row, never inserts, never rebuilds the chain | PASS |
| Approval flow | `direct-orders-approval-flow.test.ts` | chain shape; correction reprices through the same helper, no second copy | PASS |
| Held | `direct-orders-held-lane.test.ts`, `direct-orders-hold-release.test.ts`, `direct-orders-cancel-held.test.ts` | hold decision, release, cancel | PASS |
| Validation permissions | `direct-orders-pharmacy-validation.test.ts`, `direct-orders-validation-registry-gate.test.ts`, `direct-orders-validation-capture-reachable.test.ts` | Super-Admin-only decisions; capture reachability | PASS |
| Finance month | `direct-orders-second-review-fixes.test.ts`, `direct-orders-finance-month-badge.test.ts`, `direct-orders-unbooked-queue.test.ts` | status guard, identity gate, badge gating | PASS |
| Collection | `direct-orders-collection.test.ts` | authority, guards, and that it never calls the SoS rebuild | PASS |
| Sales injection | `direct-orders-approval-detail-names.test.ts:515` | the setter body actually runs the rebuild | PASS |
| Reversal | `direct-orders-reverse-authorization.test.ts` | reversal authorization | PASS |
| Role scope / page access | `direct-orders-page-access.test.ts`, `direct-orders-registry-chain-grants.test.ts` | every page calls the shared gate | PASS |
| Reporting | `direct-orders-report-columns.test.ts`, `direct-orders-share-link-controls.test.ts` | columns, share-link controls | PASS |
| Search | `direct-orders-arabic-search.test.ts` | Arabic orthographic folding | PASS |
| Workspace vocabulary | `direct-orders-workspace-vocabulary.test.ts` | status naming consistency | PASS |
| Badge performance | `direct-orders-badge-fast-path.test.ts` | the 30s poll does not load the workspace | PASS |

**Flows with no automated coverage today:**

- The `/revise` **HTTP route** (the service beneath it is covered; the route wrapper is not).
- `next.config.ts` **redirect rules** — no test asserts the 5 legacy routes still 308.
- **Back-navigation / context preservation** (Finding 19) — untested because unimplemented.
- **Client-side search and pagination behavior** in the workspace component.
- **`buildApprovalChain` with a vacant seat** — the silent-skip behavior is unasserted either way.

**Live verification:** read-only only. `/api/healthz` confirmed the running revision. Production
Postgres was queried for RLS/policy state and role grants. **No browser session, role sweep or
production transaction was performed** — dev-auth role sweeps need a running dev server, which the
memory ceiling forbids right now, and the module's live surfaces mutate real approvals and real
money.

---

## 12. Remaining open issues (today, not historically)

**Blocking for the Finance Manager phase**

1. **Collection is not a ledger.** No payment table, no installment history, no per-payment proof, no
   verification history; a correction overwrites the previous figures in place.

**Correctness / trust**

2. **Overview and Needs Action still load the full report** — the fix is targeted aggregate queries.
3. **Orders pagination is client-side**, blocked behind a scope-comparison normalisation fix.
4. **Vacant management seat silently shortens the approval chain.**

**Accuracy**

5. ~~The spec's "zero policies" line is false~~ — **fixed, merged and live** as `6cfc1aab` (§10).
6. **The admin detail back-link says "Back to My Direct Orders"** — a tab that no longer exists.

**UX**

7. **Order Detail loses the caller's context** — one `backHref` per shell.
8. **Eight desks are still full-page navigations** out of the workspace.
9. **Search is client-side** (safe, but does not scale past what is loaded).
10. **Caps: tab gate and service gate disagree** about CEO and SFE Manager.

**Hygiene (outside the module, found while establishing the baseline)**

11. **The local checkout is 26 commits behind on an unrelated branch, with a dirty tree containing a
    pre-merge duplicate of already-shipped collection work.** Worth reconciling before the next
    Direct Orders change is made locally, or that work will be re-done or re-conflicted.

---

## 13. Changes since the previous handoff

All six are in PR **#2031** (`feat/direct-orders-one-place`), merged as `76e4016b`. Formatting-only
commits excluded; there were none.

| SHA | Purpose | Files materially changed | Addresses | New risk |
| --- | --- | --- | --- | --- |
| `fa28fd26` | Correct four defects the second review found | `+finance-authority.ts`, `+api/…/revise/route.ts`, `service.ts` (+429), `needs-action.ts`, `collection-rules.ts`, `access-registry.ts`, `+tests/…second-review-fixes.test.ts` (+263) | **1, 2, 3, 4** | `service.ts` grew to 6,109 lines — the module's single largest file and its main comprehension cost. |
| `284d2eb2` | Correct & Resubmit UI closes the returned-order dead end | `+direct-order-correct-resubmit.tsx` (+219), `direct-order-request-detail.tsx`, `service.ts`, `types.ts` | **1** | `canCorrectAndResubmit` is a second expression of `reviseDirectOrder`'s guard; if they drift, a button appears that the server refuses. Mitigated by an explicit comment + test. |
| `f58da284` | Role-shaped IA — Orders, Pharmacy Control, Reports, Controls | `direct-orders-workspace.tsx` (+200/−73), `workspace-data.ts` (+108), both `page.tsx`, `next.config.ts` | **9, 10, 11, 12, 13** | Tab names changed; mitigated by `LEGACY_TAB_ALIASES` for all four old `?view=` values. |
| `ccfe4d82` | Load only what the open view can show | `workspace-data.ts` (+64), both `page.tsx`, tests (+77) | **16** | A view added to the tab list without being added to `VIEWS_NEEDING_FULL_REPORT` would silently render empty. |
| `2eec0278` | One authoritative spec, two eras marked superseded | `+docs/specs/direct-orders.md` (+121), banners on the other two | **23** | Contains the "zero policies" inaccuracy (§10). |
| `c26ae88a` | Record why server-side Orders pagination is blocked | `docs/specs/direct-orders.md` (+21) | **16** | None. |

---

## 14. Delta documentation path

`DIRECT_ORDERS_DELTA_REAUDIT.md` (this file), at the repo root.

Authoritative module spec remains `docs/specs/direct-orders.md`, and it is now **accurate as
written**. Its one factual error (the RLS "zero policies" line) was corrected in PR
[#2032](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2032), merged as `6cfc1aab` and
live. A reviewer reading that file on `main` today sees the corrected text.

**Note for the reviewer:** the audit body above was written against `76e4016b`. `main` has moved on
since (this repo runs ~30 commits/day), but the **only Direct Orders file** that differs is this one
doc — verified with `git diff --name-only 76e4016b origin/main` scoped to every Direct Orders path.
No Direct Orders source, test or migration changed, so the delta ZIP in §15 (cut at `76e4016b`)
remains a faithful source snapshot.

**One follow-on, raised directly by this audit's Finding 21 and now merged:** PR
[#2033](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2033) (`7f39011e`, live) fixes
**migration-ledger drift, not a production exposure**. The ledger contains no
`enable row level security` for `direct_order_pharmacy_validations` — the table was created
2026-08-05, four days before `20260809130000` removed the public-schema default, and it was missed by
the revoke sweep in `20260809170000` that lists the module's other six tables. Production is
unaffected and has been service-role-only throughout: re-verified against live `pg_class`/`pg_policy`
three times during this audit — `rls_enabled = true`, one `service_role`-named policy, and
`relacl = {postgres, service_role}` with `has_table_privilege('anon', …, 'SELECT') = false`. **anon
and authenticated are absent from that table's ACL entirely.** What is broken is schema-as-code:
**any environment rebuilt from migrations — staging, or a future clone — creates that table without
RLS.** It also adds `tests/direct-orders-rls-coverage.test.ts`, which *discovers* every
`direct_order_*` table from migration DDL and asserts each has RLS, rather than naming tables by
hand — the reason this drifted unnoticed for a week is that the previous test asserted one hardcoded
table.

> **Reviewer note on that PR.** Its first draft asserted, in the migration file and the test
> docblock, that the table had been "readable AND writable with the public anon key" and that rep
> GPS coordinates and HR IDs "were readable". That claim is false and was retracted — commit
> `6d8e8fb5` corrects the committed artifacts, not just the PR description, so the permanent record
> does not assert a breach that never happened. Prose only; no SQL statement and no assertion logic
> changed. It is a **no-op against production** and was NOT applied there (verified after the deploy:
> the table still carries its original 2026-08-05 comment).
>
> **Applied to staging (`cifwmndunmlxjhyjugxa`) 2026-08-12** — and it turned out to be a near-no-op
> there too. Staging already had `rls_enabled = true` on that table and `relacl = {postgres}` with no
> anon entry, so both the `enable row level security` and the two `revoke` statements were no-ops;
> only the table comment changed. **The migration's premise does not describe staging either.**
>
> **What the staging check actually found — a larger, separate gap.** Six other `direct_order_*`
> tables on staging still carry live `anon=arwdDxtm` and `authenticated=arwdDxtm` grants that
> production has revoked: `direct_order_approval_steps`, `direct_order_caps`, `direct_order_events`,
> `direct_order_pharmacies`, `direct_order_pharmacy_distributor_codes`, `direct_order_requests`.
> All six had RLS enabled with zero policies, so the grants were **inert** — anon read no rows — but
> they are exactly what `20260809170000_revoke_inert_anon_grants.sql` exists to remove, and neither
> that migration nor `20260809130000_public_default_privileges_revoke_anon.sql` was in staging's
> ledger. Production had both since 2026-08-09 (`20260809091234`, `20260809104101`); staging never
> received them. **Both were applied to staging 2026-08-12 on the owner's instruction, and the drift
> is now closed:**
>
> | Metric (public schema) | Staging before | Staging after | Production |
> | --- | --- | --- | --- |
> | Tables | 301 | 301 | 303 |
> | RLS enabled | 301 | 301 | 303 |
> | `anon` can SELECT | 81 | **31** | **31** |
> | `authenticated` can SELECT | 138 | **85** | **85** |
> | `service_role` can SELECT | 299 | **299** (unchanged) | 303 |
>
> Staging's anon/authenticated posture now matches production exactly. `service_role` was untouched,
> as designed — both migrations revoke from `anon`/`authenticated` by name and never from `PUBLIC`,
> so the default-ACL trap that strips `service_role` does not apply. All 8 `direct_order_*` tables on
> staging now read `anon_select = false, auth_select = false`.
>
> **`service_role` parity, also repaired 2026-08-12.** Two staging tables carried no `service_role`
> privilege at all — `direct_order_pharmacy_validations` (`relacl = {postgres}`) and
> `monthly_closing_locks` (`relacl = NULL`) — against production, where both read
> `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`. The app connects as `service_role`,
> which has `rolbypassrls = true` on both databases, so RLS was never the blocker; the missing table
> privilege was. Fixed by `staging_restore_service_role_grants_parity`, recorded in the ledger rather
> than run as ad-hoc SQL, because an unrecorded out-of-band change is what produced this drift in the
> first place. Staging now reads **`service_role` SELECT on 301 of 301** tables, and both ACLs match
> production exactly.
>
> **ROOT CAUSE, still open and systemic — this will recur.** `pg_default_acl` for `public`/tables:
>
> | | Production | Staging |
> | --- | --- | --- |
> | grantor `postgres` | `{postgres=arwdDxtm, service_role=arwdDxtm}` | **(no entry)** |
> | grantor `supabase_admin` | `{postgres, anon, authenticated, service_role}` | **(no entry)** |
>
> Production grants `service_role` **by default**, which is why all 303 of its tables have it.
> Staging has **no default ACL entry at all**, so every table created there is owner-only — which is
> exactly why the only two tables lacking `service_role` were the two created since the clone
> (2026-08-05 and 2026-08-10). Without a fix, every future table created on staging would have been
> unreachable to the application until someone granted it by hand. **Repaired 2026-08-12** by
> `staging_default_privileges_grant_service_role` — `alter default privileges for role postgres in
> schema public grant all on tables to service_role`. `service_role` only; `anon` and
> `authenticated` deliberately not re-granted, so it cannot undo `20260809130000`.
>
> **Proved with a live probe, not just the metadata.** A throwaway table was created in staging's
> `public`, its ACL read, then dropped:
>
> ```
> zz_tmp_acl_probe_20260812
>   acl         = {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}   <- matches production
>   svc_select  = true     svc_insert  = true      <- the new default works
>   anon_select = false    auth_select = false     <- the 20260809130000 revoke works
>   rls         = false
> ```
>
> The `rls = false` line is the important one: this is a table with **no RLS at all** — the exact
> `zz_backup_*` shape that motivated `20260809130000` — and `anon` still cannot read it. Staging is
> now safe by construction rather than by remembering, which is what that migration set out to
> achieve. Probe dropped; staging back to 301 tables, `service_role` SELECT on **301 of 301**,
> `anon` SELECT on 31, RLS on 301.
>
> **Both staging repairs are now schema-as-code.** Of the five migrations applied to staging on
> 2026-08-12, **three already existed as repo files** — `20260812090000_direct_order_pharmacy_
> validations_rls.sql`, `20260809130000_public_default_privileges_revoke_anon.sql` and
> `20260809170000_revoke_inert_anon_grants.sql`. Staging had simply never received them; nothing new
> was needed. The **two** that existed only in staging's ledger were written up as repo migrations:
>
> | File | What it fixes | Against production |
> | --- | --- | --- |
> | `20260812100000_service_role_table_grants_parity.sql` | grants `service_role` on the two tables that never received it; `to_regclass`-guarded so a partial rebuild skips a missing table | **no-op** |
> | `20260812100100_public_default_privileges_grant_service_role.sql` | the root cause — adds the `public`/tables default that makes new tables usable by `service_role` | **no-op** |
>
> `service_role` only in both; `anon`/`authenticated` are never re-granted, because that would
> silently undo `20260809130000`. `check:migrations` passes and neither timestamp collides with any
> migration on any ref (246 files after merge).
>
> **Second-order finding, production side — investigated 2026-08-12, closed as DORMANT and
> UNFIXABLE-FROM-HERE.** Production's `supabase_admin` default ACL does still grant `anon` and
> `authenticated` (`{postgres, anon, authenticated, service_role}`), because `20260809130000` wraps
> that leg in a `do` block that swallows `insufficient_privilege` and the swallow fired. Two facts
> settle what it is worth:
>
> 1. **It cannot be changed from any client this project has.** Attempted directly against
>    production: `ERROR: 42501: permission denied to change default privileges`. The session runs as
>    `postgres`, which is `rolsuper = false` and holds **no membership in `supabase_admin`**
>    (`pg_has_role(... 'MEMBER') = false`). `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin`
>    requires one or the other, and a managed Supabase project grants neither. The migration's
>    guarded block was right to give up, and its `raise notice` says exactly this.
> 2. **A default ACL only applies to objects created BY that grantor, and nothing creates tables as
>    `supabase_admin`.** Measured on production: **all 303 public tables are owned by `postgres`,
>    zero by `supabase_admin`.** Migrations, the MCP and the dashboard SQL editor all connect as
>    `postgres`, whose default was already corrected by `20260809130000`.
>
> So the exposure is latent, not live: it would require something to create a table in `public` as
> `supabase_admin`, which nothing in this system does. **An earlier draft of this document framed it
> as an open risk; that overstated it** — the ACL reading was right, but the ownership check that
> decides whether it matters had not been run. Recorded here rather than fixed, because it cannot be
> fixed from this side. Production state re-verified unchanged after the failed attempt: 303 tables,
> `anon` SELECT on 31, RLS on 303.
>
> **Ledger-version caveat.** MCP `apply_migration` stamps its own clock, not the filename: staging's
> three new rows read `20260811215457`, `20260811215833`, `20260811215849` against repo filenames
> `20260812090000`, `20260809130000`, `20260809170000`. The migration NAMES match. This is systemic
> on this project — every post-2026-08-09 staging entry is clock-stamped the same way — so a
> filename-vs-ledger drift check will flag many rows, not just these three.

## 15. Delta source ZIP path

`DIRECT_ORDERS_DELTA_SOURCE.zip` (254 KB) at the repo root; the unzipped tree at
`F:/Phoenix Workforce/DIRECT_ORDERS_DELTA_SOURCE/` — **deliberately OUTSIDE the repo.**

It originally sat at the repo root and that broke the checkout: `tsconfig` excludes only
`_wt-*` / `.codex-worktrees` / `.claude/worktrees` patterns, so `tsc` walked the package and its
copied `tests/run-tests.ts` — which imports ~700 test files the 21-file package does not contain —
produced **762 `TS2307` errors**. That failed the pre-push hook's typecheck and would have blocked
**any** push from this checkout, not just mine. Moved out 2026-08-12; the `.zip` is a deliverable and
harmless where it is. Anything unzipped from it must not be unpacked inside the repo.

Contains **exactly the 21 files that changed between `e6955e34` and `76e4016b`**, at their
`origin/main` (= production) content, with original relative paths preserved. No migrations changed
in this window, so none are included.

**Secret scan:** `gitleaks` is not on this machine's PATH, so a pattern-based fallback was run
instead over the whole package — JWT-shaped strings, Supabase `sb*_` keys, `sk-`/`ghp_`/`xox*`/`AKIA`
tokens, Postgres connection strings, PEM private-key headers, and quoted assignments to
`SERVICE_ROLE|ANON_KEY|SECRET|API_KEY|PASSWORD|TOKEN`. **Zero matches.** No `.env*`, `node_modules`,
`.next`, `*.pem`, `*.key`, `*.xlsx` or `*.csv` present.

## 16. Top files to send the independent reviewer

Ranked by how much of the new current state they carry:

1. `src/lib/direct-orders/finance-authority.ts` — **new**. The whole of Findings 3 and 4.
2. `src/lib/direct-orders/service.ts` — `reviseDirectOrder` (3082), `setDirectOrderSalesMonth` (5266), `recordDirectOrderCollection` (5358), `buildApprovalChain` (296), `getDirectOrderApprovalDetail` (4587).
3. `src/lib/direct-orders/workspace-data.ts` — the IA definition and the view-aware loading gate.
4. `src/lib/direct-orders/needs-action.ts` — the inbox, and the recorded reasoning for deleting the draft queue.
5. `src/components/direct-orders/workspace/direct-orders-workspace.tsx` — the tabs, the desk grouping, and the client-side search/pagination.
6. `app/api/direct-orders/[id]/revise/route.ts` — **new**.
7. `src/components/direct-orders/direct-order-correct-resubmit.tsx` — **new**.
8. `tests/direct-orders-second-review-fixes.test.ts` — **new**. What is actually locked.
9. `docs/specs/direct-orders.md` — **new**. The authoritative spec (with the §10 correction pending).
10. `src/lib/direct-orders/collection-rules.ts` — the current collection model, and its ceiling.
11. `next.config.ts` (redirects block, lines 184-195) — the 5 legacy redirects.
12. `src/lib/security/access-registry.ts` — the one added row for `/revise`.
