---
name: direct-order-request-module-build
description: "Direct Order Request — governed direct-sales capture, approval and injection, fixing the reps-get-0-of-direct-value gap. BUILT AND LIVE: src/lib/direct-orders/ + admin workspace app/(admin)/admin/direct-orders (exceptions/caps/cleanup/held desks). Holds the LOCKED owner rules — approval ladder, 25% bonus cap, value = qty × public × (1−disc%) or bonus qty × PHARMACY price (factory price BANNED from the module), sales month chosen by Finance ONLY (never the approval month), seat-model rep credit, separate distributor code, approvals only under the Approvals Hub — and the wiring."
metadata: 
  node_type: memory
  type: project
  originSessionId: e809b225-37bc-4db0-b13f-de36f150f936
  modified: 2026-10-02T16:40:50.312Z
---

A money-critical module: a governed replacement/parallel for the free-text `Direct Orders (4).xlsx`, fixing
the [[direct-orders-region-only-no-rep-attribution]] gap (reps got 0 of ~25% Anti / ~30% Pedia direct value).
BUILT AND LIVE: `src/lib/direct-orders/` plus a consolidated admin workspace `app/(admin)/admin/direct-orders/`
with dedicated desks `(desks)/{approval-exceptions,caps,cleanup,held}`.

## Locked owner governance rules

- **Single-line requests.** Approval ladder = the requester's ACTUAL managers up the sales line to CEO
  (DSM→RM→NSM→CEO, RM→NSM→CEO, NSM→CEO; **PM/GPM go straight to CEO**). Chain resolved by walking
  `getEmployeeDirectory` `managerHrId` → `ceoHrIds()`, with cycle + depth guards.
- **Bonus cap = 25% of qty (Ivyronc / IV001 = 30%)** — hard block, with a **CEO override that requires a
  reason**. Caps are UI-editable in `direct_order_caps` (`__GLOBAL__` sentinel + per-product overrides; Super
  Admin edits, SFE + CEO view) — the Ivyronc special lives in data, not code.
- 🔴 **value has exactly two formulas: Discount deal = qty × PUBLIC price × (1 − disc%); Bonus deal = qty ×
  PHARMACY price (bonus units never add value).** 🔴 **The factory price is NEVER used in the Direct Orders
  module — for anything** (not a basis, not a fallback, not a column, export, email, dropdown or caps screen);
  a bonus product with no pharmacy price is refused. Pricing is LOCKED and test-enforced —
  [[direct-order-pricing-rule-locked]].
  **Superseded 2026-10-02:** previously "value = approvedQty × master `factory_price`, bonus IGNORED" — the
  owner's 2026-08-04 lock in [[direct-order-pricing-rule-locked]] banned factory price from the module.
- 🔴 **The sales month is chosen by Finance ONLY (Ahmed El Maraghy, gated on his HR_ID) — never derived from
  the approval date, and CEO approval NEVER injects sales.** An approved order with no month is in no month by
  construction (the money has not been collected yet), so a NULL sales month is never a bug, and an agent never
  books or offers to book one — [[direct-order-sales-month-is-finance-owned]].
  **Superseded 2026-10-02:** previously "sales month = the CEO-approval month" — the owner's 2026-08-03/04
  decision (golden rule, restated 2026-08-29) in [[direct-order-sales-month-is-finance-owned]] replaced it.
- **Achievement is credited to the rep owning the pharmacy's AREA (seat model).**
- **Runs PARALLEL with the manual Excel under a SEPARATE distributor code (`DirectReq`, never `'Direct'`)** →
  a double-count risk covered by a reconciliation view. Reversal = a reversing entry + re-approval.
- **Each direct-order pharmacy gets an auto-generated Phoenix code** (reusable registry
  `direct_order_pharmacies`, sequence `DOP-000001`; the requester reuses a previous one or codes a new one).
  A pharmacy MUST carry ≥1 distributor + that distributor's customer code, with brick/area/region resolved
  from `source_of_sales_customer_map`. `collection_date` ("Money collection date / تاريخ التحصيل") is REQUIRED
  at submit; `pharmacy_address` optional.
- **Report access is tiered by scope:** see-all = Super Admin / CEO / SFE Manager / NSM; RM = hierarchy
  subtree (managerHrId BFS); DSM / PM = own. The report shows brick/area/region as BOTH name and code
  (owner: "i need both names and codes").
- **Notifications fire on EVERY transition** (in-app + email + telegram) to requester + next approver, with
  SFE Manager + Super Admin CC'd every step.
- 🔴 **Approvals happen ONLY on the "Direct Orders Approvals" tab UNDER the Approvals Hub** — the SOLE gate.
  NO Action Center approve path and NO one-click email/Telegram approvals; notifications deep-link to
  `/admin/approvals/direct-orders/{id}` only. Mirrors vacation's approvals-hub body + `decision-actions.tsx`.

## Permission model and wiring

- **`direct_orders` permission resource:** DSM/RM/NSM = [read,create,update,approve,export]; PM/GPM =
  [read,create,update,export]; SFE = [read,export]; Finance = [read,update,export]; CEO = [read,approve,export]
  (separation of duties); Super Admin = all. (The submit gate also allows Super Admin explicitly.)
- **Workflow:** `moduleKey direct_orders` (`src/lib/direct-orders/workflow.ts`) + a `workflow_registry_modules`
  row with actions submit/approve_intermediate/approve_final/reject/return/reverse; decisions apply through
  the **`phx_apply_direct_order_decision` CAS RPC** (a concurrent decision fires `40001`; `return` skips the
  step update). Mirrors: approval-flow ← vacation; the CEO role-step ← offers `computeRequiredApprovers`.
- **Data:** `direct_order_{pharmacies,requests,approval_steps,events}` + `direct_order_pharmacy_distributor_codes`
  + `direct_order_caps`, all RLS-enabled with NO policies (service-role-only). Geo-variance (submitter brick vs
  customer-map brick) is non-blocking → an admin Pharmacy Geography Variances desk (keep | apply-mapping).
- **Action Center + Approvals Hub need EXPLICIT wiring** — there is no auto-discovery.

## Standing rules that now outrank the original plan

Pricing is LOCKED; only Finance books a sales month (a NULL is never a bug); `includedInClosing` means "feeds
the distributor matrix" and must NEVER be flipped; and a shared distributor customer code CANNOT prove two
venues are the same.

**Injection status:** Phases A/B/B2 (capture, approval surface, tiered report, multi-distributor codes,
deal-type, editable caps, geo-variance) are built and live (the consolidation shipped as one workspace).
🔴 **Phase C — the money injection (the `decide()` inject hook → a SoS `DirectReq` distributor-code batch +
weekly `sales_type='Direct'`, idempotent per request and reversible, with invariant tests) — and Phase D
(marketing direct-sales linkage) were the outstanding money-critical work as of mid-2026-07; verify their
live state against production (`phx_closing_distributor_product` + `phx_monthly_closing_direct`) before
assuming either way, given the age of this note.** Phase C credits the order's own value by the module's two
formulas — public × (1−disc) for discount rows, qty × pharmacy price for bonus rows — never factory price, and
only once Finance has chosen the order's sales month.
**Superseded 2026-10-02:** previously "Phase C credits value as approvedQty × factory" — banned by the
2026-08-04 pricing lock ([[direct-order-pricing-rule-locked]]); injection waits on Finance's month
([[direct-order-sales-month-is-finance-owned]]).
