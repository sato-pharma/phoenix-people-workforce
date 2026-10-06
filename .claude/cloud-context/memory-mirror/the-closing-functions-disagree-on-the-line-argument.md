---
name: the-closing-functions-disagree-on-the-line-argument
description: "The closing SQL functions take TWO different line-argument forms — p_line_code wants anti_infective, p_line wants anti infective — and the wrong one returns ZERO ROWS with no error, which silently halves a line's sales by dropping its direct orders"
metadata:
  node_type: memory
  type: project
  originSessionId: ba8de66c-128d-4a93-882e-b7eec8e411d8
  modified: 2026-10-05T19:55:55.005Z
---

🔴 **The Monthly Closing functions do NOT agree on how a line is named, and the wrong form returns an EMPTY RESULT instead of an error.** The argument name is the tell:

| Argument | Form | Functions |
| --- | --- | --- |
| `p_line_code` | `anti_infective` (underscore) | `phx_sales_source_breakdown_line`, `phx_sales_vs_target_range` (as the `line_code` column), `phx_sales_source_breakdown*`, `phx_sales_direct_breakdown` |
| `p_line` | `anti infective` (space, lower case) | `phx_monthly_closing_matrix`, `phx_monthly_closing_direct`, `phx_closing_customers`, `phx_closing_brick`, the lock/publish functions |

**Measured 2026-10-05, on a figure that was about to be printed beside a named employee's photograph.** `phx_monthly_closing_direct('anti_infective', '2026-09')` returned **0 rows**, and the session concluded the Anti-Infective line has no direct orders. It has **210,519.30 EGP** of them in September 2026. Spelled with the space it returns 19 rows. The error would have reported the line's September growth as **+36.7%** instead of **+65.0%** — understating the person by nearly half, with every intermediate step looking clean. A zero here never looks like a failure, because an empty month is a perfectly ordinary thing for a line to have.

**So never read a zero from a closing function as a fact.** Probe the same call with a line you know has data (`phx_monthly_closing_direct('pedia','2026-08')` returns 457,084.97) before reporting an absence, and cross-check the composed total against `phx_sales_vs_target_range`, whose `actual_value` already equals matrix + direct: Anti-Infective 2026-08 is 442,520.05 + 51,624.10 = 494,144.15, and 2026-09 is 604,839.70 + 210,519.30 = 815,359.00, both to the piastre.

🔴 **`phx_sales_vs_target_range` returns `achievement_value` and `achievement_units` in the SAME ROW as `actual_value`** — so a query written for sales hands back achievement beside it. The owner banned any target-achievement figure from a recognition poster (2026-10-05, his words: *"don't show the achievement… show, for example, in one month, gross percentage or in two months, but don't show the total achievement"*), so selecting `*` from that function and passing it on is how that rule gets broken by accident.

**Two facts that bound any Phoenix growth figure.** Nothing before **2026-07** can be published, so **year-on-year does not exist** and a 12-month series is impossible — Anti-Infective has exactly three closed months (Jul, Aug, Sep 2026). And **from September 2026 no distributor's bonus counts as sales while August and earlier kept theirs**, so a Sep-vs-Aug rise is measured on the stricter rule and is a floor, not an inflated number. Before quoting growth across 2026-09, also check that no AREA entered the line that month (Delta (3) went live on Anti-Infective on 2026-09-01) — for that line none did, so the rise was real movement and not new map.

**There is no governorate level in the sales geography** — it is region → area → block → brick. The only `governorate` columns in the database are AI-extracted text on marketing and ATS records and are not a coverage statement. "Regions covered" and "areas covered" are the canonical answers.

Related: [[sos-monthly-closing-is-the-only-sales-truth]], [[units-of-different-products-are-never-added]].
