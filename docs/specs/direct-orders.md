# Direct Orders — current specification

**Status: AUTHORITATIVE, 2026-08-11.** Supersedes `direct-orders-v2.md` (the pre-workspace era) and
`direct-orders-workspace.md` (the first consolidation). Both are retained for history and are marked
superseded at their head; when they disagree with this file, this file is correct.

## What it is

A direct order is a company-authorised sale to a pharmacy outside the distributor channel, requiring
sequential managerial sign-off up to the CEO before it counts as company sales. The grain is **one
product per request** — no multi-line cart.

## Information architecture

**One sidebar entry per shell.** Inside it, six role-shaped views:

| View | For | Contents |
| --- | --- | --- |
| **Overview** | everyone | Summary counters, the Needs Action inbox inline, recent orders |
| **Needs Action** | everyone | Everything the viewer personally must do, grouped by kind |
| **Orders** | everyone | The viewer's permitted orders. Scope is a **filter** (Mine / All in my scope), not two tabs. An own-scope viewer sees no filter strip. |
| **Pharmacy Control** | Super Admin, `scope==="all"` | Validations · Held · Registry · Variances · Cleanup |
| **Reports & Monitoring** | wider-than-own scope, or Finance | Report · Rep Counters · Reconciliation |
| **Commercial Controls** | `scope==="all"` | Bonus/discount caps |

A view the viewer cannot use is **absent**, never present-and-empty.

### Why the desks are still their own routes

"One place" means one navigation entry, one persistent shell, one consistent internal navigation —
**not** one component holding every dataset. Four measured reasons the desks stay separate routes,
grouped by task rather than absorbed (full record in
`DIRECT_ORDERS_HANDOFF/DESK_PARITY_AND_CONSOLIDATION_PLAN.md`):

1. `rep-counters-table.tsx` is the only **server component** of the eight — absorbing it would ship
   it and its data to the browser.
2. The caps manager holds **per-row draft state**; a re-fetch on tab switch would discard a
   half-finished price edit.
3. The cleanup plan **must never be cached** — it is re-derived server-side before writing, because
   confirming a stale plan against moved data is dangerous.
4. Validation evidence photos are **signed URLs with a TTL** — a long-lived tab shows broken images.

### URL strategy

Deep links stay: `/[id]`, `/new`, `/report` and the eight desks are bookmarkable and refresh-safe.
Retired routes redirect via `next.config.ts` (true 308s — a page-level `permanentRedirect()`
degrades to HTTP 200 + meta-refresh because the layout has already begun streaming).

Old `?view=` values (`my-orders`, `all-orders`, `customers`, `admin-tools`) still resolve through
`resolveDirectOrderWorkspaceTab`; they live in bookmarks, sidebar history and the redirect table.

## Lifecycle

9 statuses: `draft` · `pending_approval` · `held` · `returned` · `approved` · `rejected` ·
`expired` · `cancelled` · `reversed`. `approved` reads two ways to the user depending on whether
`sales_month` is set.

**`draft` is a database column default, not a capability.** Nothing in the product creates, edits or
submits a draft. There is no "Finish Draft" queue; adding real drafts means adding the missing write
paths first.

**Chain**: SFE Manager (role) → the requester's live-resolved management ladder (person) → CEO
(role). Approving the SFE rung *is* the pharmacy confirmation.

**Return and correction.** An approver returns with a written reason. The requester corrects the
**same request** — same id, same chain — via `reviseDirectOrder`. The returning rung stays `pending`
(the decision RPC only writes a step for approve/reject), so `resolveActiveStep` resumes at exactly
that rung. Editable: qty, deal type, bonus/discount, collection date. **Not** editable: product and
pharmacy — changing either makes it a different order (product can change the line the chain was
built for; pharmacy re-opens the held decision). A correction note is required, mirroring the
approver's required return reason. The reason is read from `direct_order_events`, since the RPC
never stores it on the step.

**Held** is outside the approval chain entirely — no steps seeded, no approver sees it. It is not
"waiting for SFE"; the UI must keep those distinct.

## Finance

**The golden rule: CEO approval injects nothing.** Only an explicit sales-month assignment triggers
Source-of-Sales injection.

Authority resolves through **one module**, `finance-authority.ts`. The duty is bound to an HR ID,
not the Finance Manager role — a second Finance Manager does not inherit it. Reassigning it later
is a change to one function.

Assigning a sales month requires `status = 'approved'`, **enforced server-side**. Clearing stays
possible wherever a month is stored, so a month stamped before that guard existed is still
correctable.

Collections are separate from the month: recording cash never moves a period and never re-injects.

### The collection model, and exactly what it cannot represent

Documented 2026-08-12 against the code, not from memory. **Nothing here was expanded** — this
records what the model is, so the next person decides with the real shape in front of them.

**What is stored.** Three columns on `direct_order_requests`, and nothing else: `paid_amount`,
`payment_date`, `remaining_amount`. The remainder is **derived server-side** from the order value on
every write and never accepted from the client, because two sources of truth for the same money
drift the moment someone edits one.

**`paid_amount` is a RUNNING TOTAL, not a payment.** The control pre-fills with the stored figure
and a save replaces it. Recording a second instalment means entering the sum of both. This is the
single most important thing to know about the model and it is now said in every label on the
control — the arithmetic was always right, the words were not.

> A review once called this a bug and proposed accumulating the input instead. That was **withdrawn
> and must stay withdrawn**: accumulating would store 700 the moment Finance corrected a typo from
> 200 to 500.

**What it therefore cannot represent:**

| Not supported | Consequence |
| --- | --- |
| An instalment ledger | Three payments of 200/300/500 are one row reading `1000` |
| Per-payment dates | `payment_date` is the date of the **most recent recorded total**, not of the first payment or of settlement |
| Per-payment transfer proof or verification | No attachment, reference or approver per payment |
| Overpayment | A total above the order value is refused, so a genuine overpayment cannot be recorded at all |
| Refunds or negative movements | The amount must be `> 0`; money going back out has nowhere to live |
| Currency other than EGP | No currency column; EGP is implicit everywhere |
| Collection against a non-approved order | Refused by design — no agreed debt exists yet |

**History IS kept, just not as a ledger.** Every write goes through
`writeRequiredAuditLog` with full `oldValues`/`newValues`, plus a `direct_order_events` row
(`collection_recorded` / `collection_cleared`). So the sequence of *totals* is reconstructable, and
individual payments can be inferred by differencing consecutive totals. What does not exist is a
payments table you can query, sum or age. Any reporting on collections today reads the current
total only.

**Clearing** sets all three columns to null together. A payment date left behind with no amount is
what would make the check below misfire.

**It reaches outside the module.** `pharmacy-probation.ts` treats *any* direct order with a non-null
`payment_date` as proof its pharmacy is real. So recording a collection can end a pharmacy's
probation, and **clearing one can un-prove a pharmacy**. A payments table would need to preserve
that signal deliberately rather than inherit it.

**Safe today, and why.** `remaining_amount` is stored rather than computed on read, which would
drift if the order value moved underneath it. It cannot: `sales_value` is written at submit, at
revise (guarded on `status = 'returned'`) and on a reversal, which creates a new request. No path
changes the value of an approved order in place.

Do not build on the assumption that any row in the table above exists.

## Performance

Loading is **view-aware**: data a view cannot show is not fetched. Pharmacy Control and Commercial
Controls no longer trigger the full report read.

**Known remaining cost, deliberately kept:** Overview and Needs Action still load the full report.
Overview's counters span the viewer's whole scope, and Needs Action's Finance queue is filtered out
of the same rows — deriving either from `myOrders` would under-report. The fix is cheap targeted
queries (aggregate COUNTs; a dedicated approved-and-unbooked read), not deleting the load.

**Orders paging is still client-side (25/page) over a server-scoped set.** Server-side pagination is
outstanding. Scope is always enforced server-side; client filtering only ever narrows, never widens.

### Why server-side pagination is not a small change (analysed 2026-08-11)

`getDirectOrderReport` selects every request with no limit, then applies the scope tier **in
JavaScript**, then decorates. Moving `.range()` into the query means moving the scope filter into
SQL first — and each tier currently compares on a NORMALISED value, not the stored one:

| Tier | Current JS comparison | Why a naive SQL translation is wrong |
| --- | --- | --- |
| `own` | `canonicalHrIdKey(row.requesterHrId) === canonicalHrIdKey(access.hrId)` | `.eq("requester_hr_id", hrId)` misses any row whose stored HR ID differs in case or padding from the session's — the canonical form exists precisely because they do differ. |
| `hierarchy` | `visible.has(canonicalHrIdKey(row.requesterHrId))` | `visible` is a Set of **canonical** keys; `.in("requester_hr_id", [...visible])` compares them against **raw** stored values. |
| `line` | `row.line.trim().toLowerCase() === viewerLine` | `.eq("line", viewerLine)` is case- and whitespace-sensitive where the JS is not. |

So the ordering is: make the comparison basis consistent (a normalised/generated column, or
canonicalise on write with a backfill), THEN push the filter down, THEN paginate. Doing it in the
other order silently returns **fewer rows than the viewer is entitled to** — a scope-limited manager
quietly loses orders, with no error and nothing on screen to indicate the list is short.

Note the tiers already fail CLOSED (an unresolvable line yields zero rows, never the whole company),
so the risk here is under-showing, not over-showing. That is still a correctness defect and it is
why this was not attempted as a quick `.range()` addition.

## Security invariants

- RLS is enabled on **all 8** direct-order tables. Six carry **zero policies**; two —
  `direct_order_pharmacy_validations` and `direct_order_report_share_links` — carry a single `ALL`
  policy naming **`service_role` only**. No direct-order table grants `anon` or `authenticated` any
  policy, so every one of them denies those roles by default: service-role-only, all authorization
  in the Next.js server layer. (Verified against production `pg_class`/`pg_policy` 2026-08-12. The
  earlier "zero policies" wording was true of most tables, not all, so a reviewer who checked the
  two exceptions would have concluded the spec was wrong rather than the code.)
- The page-level gate (`assertDirectOrdersPageAccess`) is UX polish. The **service layer** is the
  security boundary and re-asserts independently.
- Deciding a pharmacy validation is **Super-Admin-only** (`scope === "system" || "Super Admin"`).
  SFE Manager holds the first approval rung and registry/cleanup access, but **not** validation
  decisions.
- Every mutating route is CSRF-guarded and declared in `access-registry.ts`.
