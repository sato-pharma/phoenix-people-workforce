---
name: direct-order-request-module-build
description: "Direct Order Request — governed direct-sales capture, approval and injection, fixing the reps-get-0-of-direct-value gap. BUILT AND LIVE: src/lib/direct-orders/ + a consolidated admin workspace at app/(admin)/admin/direct-orders with approval-exceptions/caps/cleanup/held desks. Holds the LOCKED owner governance rules (approval ladder, 25% bonus cap, value = qty × factory price bonus-EXCLUDED, sales month = CEO-approval month, seat-model rep credit, separate distributor code, approvals only under the Approvals Hub) and the wiring."
metadata: 
  node_type: memory
  type: project
  originSessionId: e809b225-37bc-4db0-b13f-de36f150f936
  modified: 2026-09-26T05:38:37.228Z
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
- 🔴 **value = approvedQty × master `factory_price`, bonus IGNORED.** Discount deal type instead computes
  qty × `public_price` × (1 − disc%), no bonus. Pricing is LOCKED — [[direct-order-pricing-rule-locked]].
- **Sales month = the CEO-approval month.** Only Finance books it, so a NULL sales month is never a bug —
  [[direct-order-sales-month-is-finance-owned]].
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
assuming either way, given the age of this note.** Phase C credits value as approvedQty × factory (or
public × (1−disc) for discount rows), never bonus.
