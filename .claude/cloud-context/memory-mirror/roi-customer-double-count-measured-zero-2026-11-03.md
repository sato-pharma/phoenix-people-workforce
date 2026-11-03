---
name: roi-customer-double-count-measured-zero-2026-11-03
description: "The ROI customer figure can count one sale twice, but on 3 Nov 2026 it did so for nothing - EGP 0 of 88,051.56; request_count > 1 cannot detect it, because the customer report also adds across pay months."
metadata:
  node_type: memory
  type: project
  originSessionId: 6ceef394-bac0-4789-bba3-b5c8fe4602c6
  modified: 2026-11-03T08:53:50.998Z
---

Measured on production 3 Nov 2026, about 10:50 Cairo, read only: `actuals_by_customer_dist` (in `phx_refresh_marketing_roi_facts`) inflated no customer. Every sale counted once per customer, EGP 88,051.56 on both the rebuilt hits and `marketing_roi_customer_facts`. The same query run over every status finds EGP 11,180.03 on 12 rows, all from rejected requests the rebuild leaves out, so the zero is not a blind query.

**Why:** the defect is real in the code and has two levels. The CTE adds a customer's requests inside one (pay month, customer, distributor) row, and `customer_sales` in `phx_marketing_roi_fast` then adds those rows across pay months. So `request_count > 1` on the fact table only sees the first level; two requests with different pay months and overlapping windows double with `request_count = 1` on both rows. The comment in `20261026160000` saying sales are "never summed across a customer's requests" overstates it.

**How to apply:** measure by counting one `row_id` per customer, never by `request_count`. Re-measure before quoting this, it is a point-in-time read. The first pair that can go live is هبه حبيب: one active and one pending request on the same pharmacy, product and pay month, EGP 0 of sales on both that day. Related: [[marketing-roi-three-engines-divergence]].
