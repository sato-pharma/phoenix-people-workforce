> **SUPERSEDED (2026-08-11).** The current authoritative spec is [direct-orders.md](./direct-orders.md).
> This file is kept for history — where it disagrees with that file, that file is correct.

# Direct Orders — UX/navigation audit and consolidation plan

Audit run 2026-08-10 against `origin/main` @ `5aea06eb`. Method: enumerate every route, component,
service export, migration and navigation entry in the module, then read the guards rather than grep
them — the module's authorization is overwhelmingly *named helpers*
(`assertPharmacyRegistryAccess`, `canSetDirectOrderSalesMonth`,
`canDecideDirectOrderPharmacyValidations`), and a grep-based sweep systematically under-reports them
(see `docs/audits/direct-orders-workflow-audit.md` §C6.3).

This document covers **information architecture only**. The workflow, approval chain, permissions
and money rules were audited separately in that file and are **not** re-litigated here. Nothing in
this plan changes any of them.

---

## 1. Current architecture map

### The root cause: the module is built twice

`resolveNavigationMode()` (`src/lib/auth/permissions.ts:1170`) routes users into one of two shells:

| Shell | Roles | Direct-order surfaces |
| --- | --- | --- |
| `admin` — `app/(admin)/` | Super Admin, SFE Manager, CEO, Finance Manager, System Admin | 13 routes |
| `employee-portal` — `app/employee-portals/` | **District / Regional / National Sales Manager, Product / Group Product Manager**, Medical Rep, Marketing Manager | 5 routes |

The roles in the second row are `DIRECT_ORDER_REQUESTER_ROLES` — **the people who actually raise
direct orders live in the other shell from the people who administer them.** Every shared surface
was therefore written twice:

| Purpose | Admin copy | Portal copy |
| --- | --- | --- |
| Submit form | `direct-order-submit-form.tsx` (565) | `direct-order-portal-submit.tsx` (570) |
| Order detail | `direct-order-request-detail.tsx` (1005) | `direct-order-portal-detail.tsx` (860) |
| Approvals queue | `direct-order-approvals-body.tsx` (156) | `direct-order-portal-approvals.tsx` (176) |
| Report | `direct-order-report-workspace.tsx` (341) | `direct-order-portal-report.tsx` (332) |

**≈2,000 lines of duplicated UI.** Each page pair is the *same* server logic — compare
`app/(admin)/admin/direct-orders/page.tsx` with `app/employee-portals/direct-orders/page.tsx`: the
two `Promise.all` blocks are identical, and each redirects to the other when the shell is wrong.

This is not hypothetical drift risk. It already happened: `"Approved"` could not be corrected to say
"awaiting Finance month" without the same edit landing in four files (spec C2), and the portal
briefly shipped without the held-order validation door that the admin copy had.

### Route inventory

**Admin shell (13)**

| Route | Purpose | Role gate |
| --- | --- | --- |
| `/sales/direct-orders-tools` | Hub of 10 cards — a menu, not a destination | `direct_orders:read` |
| `/admin/direct-orders` | Submit form + my orders | requester roles + Super Admin |
| `/admin/direct-orders/[id]` | Order detail (requester view) | scope check inside service |
| `/admin/approvals/direct-orders` | Approvals queue | `direct_orders:approve` |
| `/admin/approvals/direct-orders/[id]` | Order detail (approver view) | scope check inside service |
| `/admin/direct-orders/report` | Full report + xlsx export | `direct_orders:read`, tiered |
| `/admin/direct-orders/pharmacies` | Pharmacy registry | Super Admin, SFE Manager |
| `/admin/direct-orders/validations` | Pharmacy validation desk | Super Admin |
| `/admin/direct-orders/held` | Held desk — notify / track / expire | Super Admin |
| `/admin/direct-orders/cleanup` | Duplicate cleanup | Super Admin, SFE Manager |
| `/admin/direct-orders/caps` | Bonus & discount caps | Super Admin, SFE, CEO |
| `/admin/direct-orders/rep-counters` | Per-rep counters | Super Admin, CEO, SFE, NSM, RM, DM |
| `/admin/direct-orders/pharmacy-variances` | Geography variances | Super Admin, SFE, CEO |
| `/admin/direct-orders/reconciliation` | Manual-vs-module direct reconciliation | Super Admin, SFE, CEO |

Plus `/sales/customer-directory` (a *fifth* customer surface, under the "Customers Database" hub).

**Portal shell (5)**: `/employee-portals/direct-orders`, `/direct-orders/[id]`,
`/direct-orders/report`, `/approvals/direct-orders`, `/approvals/direct-orders/[id]`.

**Sidebar entries: 5** — "Direct Orders" and "D.Orders Approval" in each shell, plus "Direct Orders
Report" in the portal. Two of them carry independent badges
(`direct-orders-approvals-pending`, `direct-orders-unbooked`).

**API surface: 30 routes** under `/api/direct-orders/*`, `/api/approvals/direct-orders/*`,
`/api/cron/direct-orders-*`, `/api/share/direct-orders/*`. All thin: they resolve the access
context, call a service function, and classify errors with `isForbiddenError`. **The security
boundary is the service layer**, which is why the consolidation below can reorganize pages freely
without touching a single guard.

**Database (8 tables + 3 RPCs)**: `direct_order_requests`, `direct_order_approval_steps`,
`direct_order_events`, `direct_order_pharmacies`, `direct_order_pharmacy_distributor_codes`,
`direct_order_pharmacy_validations`, `direct_order_caps`, `direct_order_report_share_links`;
`phx_apply_direct_order_decision`, `phx_rebuild_direct_order_sos_batch`,
`phx_resolve_directory_pharmacy`. **None of these change.**

---

## 2. The real workflow (from the code, not invented)

From `approval-flow.ts` (`directOrderExpectedRoleChain`) and `service.ts`:

```
draft ──submit──► pending_approval ──► SFE Manager ──► [requester's management line] ──► CEO
   │                                                                                      │
   └──submit_held──► held ──revive_held──► pending_approval                    approve_final
                       │                                                                  ▼
                  expire_held (14d)                                                   approved
                       ▼                                                                  │
                    expired                                            setDirectOrderSalesMonth
                                                                                          ▼
                                                                    sales injected into that month
```

- Management ladder is **owner-locked**: DM → RM → NSM → CEO; RM → NSM → CEO; NSM → CEO;
  PM/GPM → CEO directly. Every chain opens with the SFE Manager rung and ends at the CEO.
- **The GOLDEN RULE**: CEO approval injects *nothing*. Sales enter a month only when Finance calls
  `setDirectOrderSalesMonth`. An order can sit `approved` for days with its value in no month's
  numbers. On 2026-08-05 two orders did exactly that and no screen said so.
- `held` sits **outside** the chain entirely — in nobody's queue, with a 14-day clock.
- 9 statuses: `draft`, `pending_approval`, `approved`, `rejected`, `returned`, `reversed`, `held`,
  `expired`, `cancelled`.

### Role-by-role journey today

| Role | To do one task, they visit |
| --- | --- |
| **District / Regional Manager** | Portal → Direct Orders (submit) → *separately* Approvals Hub → D.Orders Approval → *separately* Direct Orders Report. A returned order has **no prompt anywhere** — they must open "My orders" and notice the status themselves. |
| **SFE Manager** | Admin → Direct Orders hub → pick 1 of 10 cards → *separately* Approvals Hub → D.Orders Approval → *separately* Duplicate Cleanup, Pharmacy Registry, Caps, Variances, Reconciliation. |
| **Finance Manager** | Sees only a sidebar badge count. There is **no page** listing the orders awaiting a month — he opens the report and filters by eye. |
| **Super Admin** | All 13 admin routes, spread across two sidebar sections and one hub-of-cards. |
| **CEO** | Approvals queue → order detail. (Already close to correct — this is the one clean journey.) |

---

## 3. UX problems found

1. **The module is built twice** (§1) — the single largest source of both cost and drift.
2. **A hub-of-cards is a menu, not a workspace.** `/sales/direct-orders-tools` costs a click and
   forces the reader to know which of ten desks owns their task.
3. **Approvals are architecturally separate from orders** — different sidebar section, different
   route tree, different component. Approving is the *most common* direct-order action.
4. **Nothing tells anyone what is waiting on them.** Five queues exist (approve, correct a returned
   order, verify a held pharmacy, decide a validation, book a Finance month) across five surfaces,
   and two of them (returned, held) have no queue surface at all.
5. **Database values are shown to users.** The pill rendered `String(status).replace(/_/g, " ")` —
   so people read "held", "pending approval", "expired". `held` is the worst: it reads as "an
   approver paused this" when the truth is that *no approver has seen it*.
6. **Pages exist because statuses do.** Held Desk, Validation Desk, Cleanup and the unbooked queue
   are four surfaces that are all "orders in state X".
7. **The customer registry is a mandatory detour.** A requester who cannot find a pharmacy has to
   understand the registry / validation / held model to get unstuck.
8. **No cross-cutting search.** To find an order you must first know which page owns it.
9. **Performance**: `getDirectOrderWorkspaceData` does `select("*")` over **every**
   `pending_approval` row company-wide, then over every `held`/`expired` row, then filters in
   Node. `countDirectOrderAwaiting` calls the whole thing just to read `.length`.

---

## 4. Target architecture

**One workspace per shell, same component.**

```
Direct Orders
├── Overview        + New Order · 4 counters · Needs Action · Recent orders
├── Needs Action    the operational inbox — every queue, deep-linked to the record
├── My Orders       search + 5 filters (All / Needs Action / In Progress / Returned / Completed)
├── All Orders      same list, wider scope — permission-gated, hidden for "own"-scope viewers
├── Customers       lookup happens inside the order; registry link for those who administer it
└── Admin Tools     the specialist desks, only for roles whose services admit them
```

Rules that make it hold:

- **The workspace owns no permission rule.** Tabs and capabilities come from
  `loadDirectOrderWorkspaceView`, which composes the existing services and their existing guards.
- **A tab the viewer cannot use is not rendered** — not rendered-and-empty.
- **Filters replace pages.** Buckets map to *stages* from the shared vocabulary, never to a
  hand-written list of statuses, so a new status lands in a bucket instead of vanishing.
- **Status labels are a projection.** Database values never change and never leave the server layer
  as user-facing text.

---

## 5. Keep / merge / deprecate

| Verdict | Routes |
| --- | --- |
| **Keep as-is** | `/[id]` order detail (both shells) — already order-centric and correct; `/report` — genuinely needs its own view + export; the 30 API routes; all 8 tables |
| **Merge into the workspace** | `/sales/direct-orders-tools` (hub → Admin Tools tab); `/admin/approvals/direct-orders` + portal twin (→ Needs Action); `/admin/direct-orders` list half (→ My Orders); the unbooked Finance queue (badge-only today → Needs Action) |
| **Deprecate once equivalent** | `/sales/direct-orders-tools`; `/employee-portals/direct-orders/report` (fold into the workspace's report link) |
| **Keep, but demote out of the main flow** | `/pharmacies`, `/validations`, `/held`, `/cleanup`, `/caps`, `/rep-counters`, `/pharmacy-variances`, `/reconciliation` — all real administrative desks; they belong behind Admin Tools, not in anyone's daily path |

**Nothing is deleted in this change.** Old URLs must keep resolving until the workspace is confirmed
equivalent — they are in the sidebar, in bookmarks, and in the approved-order email.

---

## 6. What was implemented (Phases B, C and D)

### Route map — BEFORE 19, AFTER 13 (6 retired to 308 redirects)

| Before | Verdict | After |
| --- | --- | --- |
| `/sales/direct-orders-tools` | **RETIRE** | 308 -> `/admin/direct-orders?view=admin-tools` |
| `/admin/approvals/direct-orders` | **RETIRE** | 308 -> `/admin/direct-orders?view=needs-action` |
| `/admin/approvals/direct-orders/[id]` | **RETIRE** | 308 -> `/admin/direct-orders/[id]` |
| `/employee-portals/approvals/direct-orders` | **RETIRE** | 308 -> `/employee-portals/direct-orders?view=needs-action` |
| `/employee-portals/approvals/direct-orders/[id]` | **RETIRE** | 308 -> `/employee-portals/direct-orders/[id]` |
| `/admin/direct-orders` (was the submit form) | **MERGE** | now the workspace; submit moved to `/new` |
| `/employee-portals/direct-orders` (was the submit form) | **MERGE** | now the workspace; submit moved to `/new` |
| `/{shell}/direct-orders/[id]` | **KEEP** | order-centric already; both shells now share ONE component |
| `/{shell}/direct-orders/report` | **KEEP** | genuine export + share-link surface; both shells share ONE component, reached from inside the workspace |
| the 8 admin desks | **KEEP, demoted** | behind the Admin Tools tab, out of the daily path |

Both `[id]` approval routes were a strict SUBSET of their order-detail counterpart — they rendered
the detail component and nothing else, while `/direct-orders/[id]` renders it PLUS the
pharmacy-validation capture and the cancel-held control. Redirecting gives an approver two controls
they did not have. Approve / Reject / Return survive because they never came from the route: they
come from `detail.availableActions`, computed per viewer from the approval chain.

### Sidebar — BEFORE 5 entries, AFTER 2 (one per shell)

Retired: "D.Orders Approval" (both shells), "Direct Orders Report" (portal). The surviving row
points at the workspace and carries a combined badge, `direct-orders-needs-action`.

That badge is new because a row carries ONE badge and collapsing five rows into one left two
competing: the approval queue and Finance's unbooked queue. Their audiences barely overlap — the
Finance Manager holds no approval rung, no approver can book a month — so keeping either alone would
have silently dropped the other group's only ambient chaser. The sets are provably disjoint, so the
sum is exact, and it is DERIVED in the batched route from two values already computed there: zero
extra queries.

### Duplicate implementations — 5 components deleted, ~2,100 lines

| Deleted | Lines | Replaced by |
| --- | --- | --- |
| `direct-order-portal-detail.tsx` | 860 | `direct-order-request-detail.tsx` (the superset — and the one the mobile approval-window hardening was done on) |
| `direct-order-portal-submit.tsx` | 570 | `direct-order-submit-form.tsx` |
| `direct-order-portal-report.tsx` | 332 | `direct-order-report-workspace.tsx` |
| `direct-order-portal-approvals.tsx` | 176 | the workspace's Needs Action tab |
| `direct-order-approvals-body.tsx` | 156 | the workspace's Needs Action tab |

### Capabilities preserved, not dropped

- **Pharmacy code + covering rep on the queue card.** The retired portal approvals card carried both
  so an approver on a phone could tell two same-named pharmacies apart. Both now ride
  `DirectOrderQueueRow`, and the test that protected them was re-pointed at their new home.
- **The portal report must not open on the unbooked filter.** Enforced by the portal PAGE declining
  to pass `initialUnbookedOnly`, since the component is now the same one Finance uses WITH the chip.
- **"Only a person-rung approver sees anything to approve."** Moved DOWN from a nav flag
  (`showDirectOrdersApprovalsTab`, retired) to the service gate `viewerCanActOnStep` — a stronger
  home, since a nav flag only ever hid a link.
- **The CNS exclusion** on Direct Orders is untouched and still asserted.

### Status vocabulary (mapped from the real statuses)

| Database | Shown to the user |
| --- | --- |
| `draft` | Draft |
| `held` | **Customer Verification Required** |
| `pending_approval` | **In Approval** |
| `returned` | **Needs Your Correction** |
| `approved` + no `sales_month` | **Waiting for Finance** |
| `approved` + `sales_month` | **Completed** |
| `rejected` | Rejected |
| `expired` | Expired |
| `cancelled` | **Withdrawn** |
| `reversed` | Reversed |

`draft` / `rejected` / `expired` / `reversed` keep their names deliberately — they already say
exactly what happened.

---

## 7. Remaining work

1. **The two `[id]` detail routes still differ by shell wrapper only.** They now render the same
   component; folding the last two page files into one is cosmetic and was not worth the churn.
2. **Search by customer code and MR name.** Not on `DirectOrderQueueRow` today, so deliberately NOT
   advertised in the search placeholder rather than silently unsearchable.
3. **Server-side filtering and pagination.** `getDirectOrderWorkspaceData` still `select("*")`s every
   pending row company-wide, and `countDirectOrderAwaiting` calls the whole thing for a `.length` on
   a 30s badge poll. The workspace paginates at 25 client-side, which bounds render cost but not
   query cost. **This is the largest known performance debt in the module.**
4. **Quick actions from the inbox** — approve/return without opening the order.
5. **Browser verification at desktop and mobile widths has NOT been done** (see section 8).

## 8. Risks to protect against

- **NOT BROWSER-VERIFIED.** Every check here is static: typecheck, lint, and 717 test files, none of
  which render a page. The consolidation moved five components and six routes, so the first person to
  open the workspace should check both shells at desktop and mobile width before this ships.
- **Scope regressions.** Every list the workspace renders was scoped by the service that produced
  it. Any future direct Supabase query in `workspace-data.ts` would be a second copy of a visibility
  rule — the precise mechanism behind audit finding F5.
- **The portal has no Admin Tools tab** because those services refuse portal roles. If a desk's gate
  is ever widened, the tab list must be widened with it.
- **Test fixtures that NAME a module rot.** `modules-control.test.ts` has now been broken twice by
  unrelated retirements (Sales Queue 2026-08-02, D.Orders Approval 2026-08-10). It now discovers a
  qualifying module instead of naming one.
