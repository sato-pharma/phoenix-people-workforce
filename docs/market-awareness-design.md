# Market Awareness — design, from the owner's 47 answers

Source of every decision below: `xlsx/market-awareness-questions-2026-09-06.xlsx`, answered in full
(47 of 47, 7 notes) on 2026-09-06. Where a note contradicts the dropdown, the note wins and the row
says so. Nothing here is built yet.

**Scope in one line.** A separate module where the Group Product Manager, the Product Managers and
the Marketing Manager raise an awareness activity — round table, symposium, workshop, speaker
program, sponsorship, ad board, conference — against targeted products in one brick, get it approved
by their manager and then the CEO, and then watch that brick's and that area's sales for those
products over a window they set.

It is **not** a marketing request. `marketing_requests.customer_id` is `NOT NULL`, so every request
there is anchored to exactly one validated customer; an awareness activity is anchored to a place
and a product set. The live marketing chain also runs an SFE validation step that exists only
because the requester is field force, and these requesters are not.

## 1. The reconciliation rule — verified, not proposed

This was the one part that could have sunk the Tracking tab, and it is now settled.

**`public.source_of_sales_fact_rollup` is the single source for both halves at brick × product.**
It carries `period, distributor_code, official_line, region_code, area_code, brick_id, product_code,
is_direct, effective_units, total_qty, direct_value, client_code, batch_id`.

Measured on production (`ozucdzovmcqvepbozvqf`) for `2026-08`:

| Line | Closing rollup units | `fact_rollup` where `not is_direct` | Difference |
| --- | --- | --- | --- |
| Anti Infective | 4,811 | 4,811 | **0** |
| CNS | 21,891 | 21,891 | **0** |
| Pedia | 10,290 | 10,290 | **0** |
| Head Office | 5 | 272,776 | −272,771 |

`eff_units` agreed to zero on the same three lines. Head Office is the only divergence and it is
**out of scope by the owner's own answer** (question 29: Head Office products are not offered in the
product picker at all), so it cannot reach this module.

So the rule is:

```
indirect half   fact_rollup, validated batch, not is_direct
                → equals what phx_closing_distributor_product publishes, exactly
value           effective_units × source_of_sales_products.factory_price
                (the closing revalues at factory price; it does not use the invoiced value)

direct half     fact_rollup, validated batch, is_direct,
                product_code not in ('LA003','LA004','SS001')
                → this is literally what phx_monthly_closing_direct already reads
value           direct_value

brick figure    the same two aggregates with brick_id added to the GROUP BY
```

**Adding `brick_id` to the group-by of the same aggregate reconciles by construction** — the bricks
of an area sum to that area's published figure because it is the same rows grouped one level finer.
That is the whole reason this is safe, and it is why the module must read `fact_rollup` rather than
re-deriving anything from `source_of_sales_import_rows`.

Three things to carry into the build:

- **Both halves, always.** Quoting the distributor half alone understates the month; flipping
  `not is_direct` double-counts. The two are added, never substituted.
- **Validated batches only** — `join source_of_sales_import_batches b on b.id = f.batch_id and
  b.status = 'validated'`. Without it a pending batch leaks into a published-looking number.
- **`2026-07` direct rows are special.** `phx_monthly_closing_direct` blanks `area_code` for that
  period and defers to an owner overlay. A tracking window that reaches back into July 2026 must
  reuse the closing's own rule rather than reading the row's area. Windows from August 2026 forward
  are unaffected.

The tracking tab shows the reconciliation check on screen: bricks-sum versus the published area
figure, for the same period and product set. If it ever disagrees, the screen says so rather than
printing a number that quietly contradicts the Monthly Closing.

## 2. What the owner decided

Deviations from what was recommended are marked **changed**; everything else was accepted as
recommended.

### Access

- Creators: GPM, Product Managers, **Marketing Manager and Super Admin** (question 2's dropdown said
  "GPM and Product Managers only" but its note said "also marketing manager and systemn admin" — the
  note wins, and question 35 confirms it by asking where the Marketing Manager's own request goes).
- A PM sees his own activities only. GPM and Marketing Manager see all. Super Admin sees all.
- Tracking tab: the same people plus CEO, NSM, SFE and Super Admin.
- **changed** — the module lives in **both shells**, on separate links: an admin route and an
  employee-portal route. Recommendation had been portal only.

### The activity

- The seven types as listed, held in a table Super Admin can edit — same pattern as
  `marketing_request_types`.
- `conference` is **deactivated** in `marketing_request_types` once this ships. The one existing
  conference request there stays readable; deactivating a type does not orphan it.
- **changed** — several **lines** allowed per activity (see the open question in §6).
- **changed** — one **main brick plus optional others**.
- **changed** — title optional, not required.
- Venue, city, expected attendee count and speaker names: all four, all optional.
- Start date required, end date optional.

### Cost

- One total plus an optional itemised breakdown. EGP only.
- **No budget envelope** — skipped entirely in version one. Nothing to build, no new table.
- **changed** — Finance is informed **plus carries a paid / not-paid mark**. Not the full marketing
  invoice obligation (no finance hold, no overdue nudge), just a two-state flag Finance sets.
- Actual cost optional at closure, recorded by the requesting Product Manager.

### Tracking

- Duration in months, 1 to 12. Baseline 3 months before the activity.
- Value always; units as well when exactly one product is targeted. Never units across products.
- Brick figure from the reconciled rollup in §1. Both halves of the closing included.
- Expected uplift percentage optional. **The PM writes the verdict — nothing is scored
  automatically.**
- Head Office products never appear in the product picker.

### Geography

- **changed** — non-territory areas (`other_permanent`, `other_line_specific` — Office, Main Store
  and similar, 37 of 147 area-line rows) are **shown greyed out**, not hidden. Read as: visible,
  not selectable, with the reason stated. Hiding them was the recommendation; showing them disabled
  is what was chosen.
- A vacant area is selectable and labelled **"Vacant — will hire"** (41 of 147 rows).
- **changed** — **every DM in the region** is informed, for the chosen line — not the single DM of
  the chosen area.
- **changed** — the rep and DM shown are **today's holders**, but the note asks that a change be
  visible: "show todays but highlight and mention that the original rep resigned and this replaced
  him". So the seat holder at approval is still **stored**, and the screen compares the two and
  flags a replacement. Display is live; the record is frozen.

### Workflow

```
draft → manager → CEO → approved → executed → closed
                ↑ return with comment (restarts from manager)
```

- Manager step resolves from the reporting line. Rasha (GPM, A-8) → Hossam (Marketing Manager, A-9).
  Ahmed SharafEldeen (PM, B-155) → Rasha. Nahed (PM, A-10) → Hossam.
- The Marketing Manager's own request **skips the manager step and goes straight to the CEO** — he
  reports to the CEO, so there is no step underneath.
- No cost threshold: the CEO sees every one.
- The CEO may **approve at an amended amount**, recorded as his decision. Standing rule: nobody ever
  approves *for* the CEO — the amended amount is his action, taken by him.
- Return with comment sends it back to the PM and **restarts from the manager step**.
- The PM may withdraw before the CEO decides. After approval the activity is **locked**; changing it
  means withdrawing and raising a new one.
- 2 days per step, matching marketing requests. SLA drives the overdue marker only, never a decision.

### Conversation and notifications

- Any participant can open a conversation. This plugs into `src/lib/conversations/notify.ts` — the
  owner's own 2026-09-03 rule: **email to the submitter, CC the sender and every participant**,
  in-app and Telegram to everyone except the author. Nothing new is built for this.
- On CEO approval: every DM in the region for the chosen line, the NSM, the SFE Manager, the area's
  Medical Rep, and Finance. Channel: **in-app + Telegram + email**.
- Those informed people can **comment but never approve**.

### Closure

- The PM marks it executed with the real date.
- Optional photos and an optional attendance sheet.
- Outcome note optional.

## 3. Tables

All under `public`, prefix `market_awareness_`. Timestamps `timestamptz`, HR ids stored through
`hrIdForStorage` and compared through `canonicalHrIdKey` — HR ids are mixed case and a raw `.eq`
silently under-returns.

| Table | Holds |
| --- | --- |
| `market_awareness_activity_types` | The seven types. `code`, `name`, `sort_order`, `active`. Admin-editable, mirrors `marketing_request_types`. |
| `market_awareness_activities` | The activity itself: code, requester, status, type, title, venue, city, dates, attendee count, speakers, region, area, brick, estimated cost, amended cost, actual cost, duration months, baseline months, expected uplift, finance paid flag, executed date, outcome note, and the seat holders frozen at approval. |
| `market_awareness_activity_lines` | One row per targeted line. Exists because several lines are allowed. |
| `market_awareness_activity_products` | One row per targeted product (`product_code`), with its line. |
| `market_awareness_activity_bricks` | The main brick plus the optional others; `is_primary` marks the main one. |
| `market_awareness_cost_items` | Optional breakdown — label and amount. |
| `market_awareness_workflow_steps` | Configurable chain, same shape as `marketing_workflow_steps`. |
| `market_awareness_decisions` | Append-only decision trail: step, actor, action, comment, amended amount. |
| `market_awareness_evidence` | Closure photos and the attendance sheet, via the existing evidence-photo storage pattern. |

The tracking figures are **not stored**. They are read live from `fact_rollup` through one service
function, so a closing correction or a price fix flows through rather than freezing a stale number
into the activity. That matches how a price fix already restates every published closing.

## 4. Code layout

Domain-first: business logic in `src/lib/market-awareness/`, pages and routes call it.

```
src/lib/market-awareness/
  types.ts              statuses, actions, the activity record
  service.ts            create, submit, decide, withdraw, execute, close
  workflow.ts           registry module key + transition assertions
  scope.ts              who may see and do what
  geography.ts          region → area → brick cascade, rep and DM resolution
  tracking.ts           the reconciled brick and area figures, baseline vs window
  notifications.ts      the informed set on approval
```

Routes under `app/api/market-awareness/**`, every handler calling
`assertPermission(ctx, resource, action)` before any mutation — `system-navigation.ts` hiding a link
is UX only.

Screens: `app/employee-portals/market-awareness/**` and `app/(admin)/admin/market-awareness/**`,
one page with two tabs — Request and Tracking.

🔴 **The portal builds its OWN sidebar — an entry in `system-navigation.ts` does not put a link
there.** This was found by opening the page rather than by reading the code: the route rendered
perfectly and no link to it existed anywhere, which is the "ships green, deploys cleanly, reachable
by nobody" shape, and zero usage looks exactly like no adoption. The portal link needs all three of:

1. `showMarketAwarenessTab` on `EmployeePortalNavVisibility`, set in `resolveEmployeePortalNavVisibility`
   (`src/lib/employee-portal/navigation.ts`),
2. the entry in `src/components/employee-portal/employee-portal-layout.tsx`, and
3. the entry in `src/components/employee-portal/employee-portal-nav-registry.ts`.

The admin shell is the one that `system-navigation.ts` actually drives.

Golden rules that bind the UI: no horizontal scroll at desktop **or** 375px (measured, not
eyeballed), square corners everywhere, no text truncated with an ellipsis, human-readable names
never raw codes, every time in Africa/Cairo.

## 5. Permissions

A new resource, `market_awareness`, rather than borrowing `expenses` — that key already gates the
whole `/api/marketing-requests/**` namespace and widening it would hand this module to everyone who
holds it.

| Role | Read | Create | Decide |
| --- | --- | --- | --- |
| Product Manager | own | ✅ | — |
| Group Product Manager | all | ✅ | manager step |
| Marketing Manager | all | ✅ | manager step |
| CEO | all | — | CEO step |
| Super Admin | all | ✅ | both |
| NSM · SFE Manager · District Manager · Finance | tracking + informed | — | — |

Role sweep before merge, denial paths included: a Medical Rep and a District Manager must be refused
create and decide, and must reach only what the informed set allows.

## 6. The one open question

**Question 9 allows several lines; question 32 says "the dm of the region in the line chosen",
singular.** These pull against each other, because the region map is per line — Anti-Infective spans
9 regions, CNS and Pedia 7 each, over the same 49 areas. So one area can sit in a different region
depending on the line, and with two lines chosen there is no single region list to cascade from.

**Proposed resolution, pending the owner's word:** the products chosen imply the lines; the PM
nominates one of them as the **primary line**, and that is what drives the region → area cascade he
described. The other lines ride along for measurement, and the Tracking tab reports each line
separately — never summed, because units of different products are never added and the two lines'
geography differs. DM notification then resolves per line: for each chosen line, every DM in the
region that line puts the chosen area in.

This preserves the flow exactly as described and needs one word to confirm.

## 7. Deliberately not built

- **No budget envelope** — answer 16.
- **No automatic success scoring** — answer 28; the PM writes the verdict.
- **No SFE validation step** — that step exists in marketing requests because the requester is field
  force. Product managers are trusted more than field force, which is the reason this module exists.
- **No customer validation, no ROI coverage machinery, no finance hold.** Finance gets a paid flag.
- **No stored tracking figures** — read live, so corrections flow through.
