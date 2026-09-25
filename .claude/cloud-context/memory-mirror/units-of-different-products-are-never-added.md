---
name: units-of-different-products-are-never-added
description: "OWNER RULE 2026-08-27 — units of different products or different concentrations must never be summed; any aggregate above one product code is by VALUE only"
metadata:
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-08-26T23:01:52.102Z
---

**OWNER RULE, stated 2026-08-27:** *"If you choose units, you don't add units of different
concentration or different products to each other. You add their values."*

**A unit total is only ever valid for ONE product code.** The moment a row, a total, or a chart
covers more than one `product_code`, its unit figure is meaningless and must not be printed —
show the mark for *not applicable*, and give the aggregate in **value** instead. This holds for
every level: family, line, rep, area, region, month-over-month, company.

Why it bites here: a pack of Tebofortin drops and a pack of Tebofortine Forte 80 are not the same
thing, and neither are Lacto Advanced 1 and Lacto Advanced 2. Adding them produces a number that
looks authoritative and means nothing.

**Where this already produced wrong output** (Monthly Closing premium workbook, corrected in v5):

| Printed before | Why it was wrong |
| --- | --- |
| `123,721` tracked-line July units | sums 17 product codes across three lines |
| `243,579` Head Office July units | sums Lacto Basic 1 + Lacto Basic 2 + Satoslim + Royanoxicam |
| `243,232` Lacto Basic units | sums two concentrations, LA003 + LA004 |
| a per-rep unit column on a rep ranking | a rep sells 17 different products |

**How many concentrations each family has** (live catalogue, `source_of_sales_products`, checked
2026-08-27): Tebofortin **7** (5 sold in July), Conviban **4**, Rispadex **3**, Dopaminict **2**,
Lacto Advanced **2**, Lacto Basic **2**, Dolabactin **1**, Royafloxacin **1**, Saginko **1**,
Ivyronc **1**, Guamusin **1**, Satoslim **1**, Royanoxicam **1**. So on a **family**-grained sheet
only the single-concentration families can carry units at all.

**The same rule applies to TARGETS** — the owner asked in the same breath for targets in units *and*
values, so a target-units column is required wherever a sales-units column is valid, and is equally
forbidden where it is not.

**The presentation that was accepted:** units and values live in two separate contiguous column
blocks, each an Excel **column outline group**, so one click on the group's minus button gives a
units-only or a value-only view. Per-concentration detail sits in collapsible **row** groups under
each family row, which is where a unit figure is always legitimate.

Related: [[lacto-advanced-and-basic-share-family-and-family-code]] (the grouping key must be
`(normalized_line, family)`), [[head-office-sales-are-absent-from-phx-monthly-achievement]]
(Head Office has units but no price, so it is units-only *and* concentration-only),
[[sos-monthly-closing-is-the-only-sales-truth]].

**Weekly Sales (admin shell) — shipped 2026-09-17, PR #3923.** The dashboard hides every unit figure
unless its rows are one product's (By product always keeps units), and the Weekly BI export writes a
dash formula in each mixed-product unit cell. The rule lives in `src/lib/sales/weekly/unit-totals.ts`.
**ONE KNOWN, SETTLED EXCEPTION: the BI workbook's Week Comparison sheet still adds products' units
(Units Sold, Stock Units).** Those cells are plain numbers, so dashing them changes the
password-locked design fingerprint. The owner was asked on 2026-09-17 and chose to leave that sheet
as it is rather than change the design. **Do not re-raise it or "finish" it**; it can change only if
he asks and types the design password himself.
