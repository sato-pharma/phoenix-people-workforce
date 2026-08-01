# Source of Sales — decisions of record

Rulings the owner made during the 2026-07-31 → 2026-08-01 remediation. They are business decisions,
not implementation details: the code follows them, so changing the code without changing this file
means one of the two is now lying. Pinned by `tests/sos-latent-guards.test.ts`.

## 1. Confidential products (2026-07-31)

**Analytics adopts the SoS dashboard's rule: LA003 / LA004 / SS001 are hidden by default and
revealed only for CEO / Super Admin.**

`analytics.sos_fact` hard-excluded them in the view while the dashboard revealed them, so the two
surfaces disagreed by the entire confidential total — June 2026 read **9,362,810 EGP** in Analytics
against **53,894,769 EGP** on the dashboard, and the 44,531,959 delta was exactly the confidential
value in all five loaded months. Those three products are 64.7–85.5% of company value, so Analytics
was showing the minority remainder, not a filtered view.

The four `analytics_sos_by_*` RPCs now read `analytics.sos_fact_all` (which already existed, with an
identical column list) and take the exclusion as `p_exclude_codes`.

> Both surfaces must default to EXCLUDED. Revealing by default for CEOs would recreate the same
> divergence in the other direction — their Analytics figure would disagree with their own
> un-revealed dashboard.

## 2. Attribution model (2026-07-31, refined 2026-08-01)

**Sales are wired to areas, bricks and regions — not to persons. The person wired to an area
inherits its sales, using TODAY'S wiring. But a departed rep keeps the credit for months they
actually worked.**

Together those are exactly:

```
credit = coalesce( occupant of the seat TODAY , occupant of the seat AT PERIOD END )
```

Today's wiring first, so a transfer re-points history to whoever owns the area now; the fallback
means a vacant seat does not orphan a month that someone really worked.

`au.f_seat_occupant_asof` previously fell through to `effective_from asc` — the earliest occupant the
seat ever had — whenever no span covered the date. That did not fail closed, it invented an owner.
Measured over 525 (area × period) rows: it was firing on 100; under the rule above 83 resolve to the
correct person, 17 become genuinely unowned, and 17 rows change in total.

Consequence accepted by the owner: an area vacant today whose sales nobody worked has **no person**
attached. It is not lost — attribution is area-first, so the value still belongs to its area.

## 3. Direct channel in targets (2026-08-01)

**Direct counts toward achievement, because the 2026 targets were SET including Direct.**

This is a correction, not an inflation: actuals were excluding a channel the targets already
assumed. Pedia June 2026 is the largest single effect at 42.5% of the line.

*Still to implement in `au.f_monthly_achievement`.*

## 4. Fail-closed scope sequencing (2026-07-31)

**Report the bad organisational records first, correct them, and only then merge a fail-closed scope
change** — so no manager loses access as a surprise.

The premise turned out different from the audit's: there are **no** areas sitting outside their
manager's region (0 rows), and Weekly Sales already scopes by seat areas. The real gap is that
**16 of 17 District Managers have a blank `employees.region_code`** (55 of 131 active employees).
Because the seat bound is populated and correct, the fix is to use it rather than to backfill 16
region labels — so this phase needs re-scoping, not execution.

## Deliberately not fixed

| Item | Decision | Why |
|---|---|---|
| `analytics.sos_by_block` inner-joins bricks | Guard test only | No consumers. A migration to fix a report nobody reads is approval and risk spent for no one. The audit's "22.7% dropped" is not reproducible either — rows with no brick or flagged Direct are 0.1% of the fact rollup. |
| 12-period cap on rep achievement | Keep, disclose | A real performance bound (one attribution pass per period). The defect was the silence. |
| 500-mapping cap on accept-mappings | Keep, refuse explicitly | A request-size bound is legitimate; silently slicing to it was not. |
| `p_areas` on `analytics_weekly_fact` | **Blocked, not deferred** | `weekly_sales_rows.area_code` exists but is unpopulated, so adding the argument would filter every area-scoped viewer to zero — worse than the current gap. Unblocks once the branch→area map is entered. |
| `invoice_period = b.period` join in the rollup refresh | Monitor, don't guess | Removing it means deciding whether the row's or the batch's period is authoritative, and a two-month batch carries a range string that is not a valid period key. 0 rows affected today; `phx_sos_period_drift_count()` makes it observable. |
| Closing Matrix target columns | Hide, don't build | A target source in that loader is a new feature, not a bug fix. |

## Claims that failed verification

Recorded so nobody re-opens them. All checked against production:

- `analytics.weekly_fact` region fan-out inflating 5–10× — **false**. The view has *fewer* rows than
  the base table (24,927 vs 29,714) and a 0.908× value factor; a fan-out cannot reduce row count.
- `analytics.sos_by_customer` 6.77× fan-out — **false**, factor is 1.000.
- `validation_state` filter divergence — **no impact**; all 219,092 rows are `valid`.
- Discount misread as a percentage — **no impact**; all 52 non-zero discounts are 0.0–0.08.
- "25 live areas sit outside their manager's region" — **0 rows**.
- "Weekly Sales still scopes DM/RM by region label" — **already seat-based**.
- The backfill RPC caused the 1,698 stale rows — **no**; it only fills NULL bricks, never re-points.
  That backlog belongs to the reconcile path.
