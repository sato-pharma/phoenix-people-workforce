---
name: restricted-skus-are-all-head-office-line
description: "Every LA003/LA004/SS001 row sits on the Head Office line, which is ~80% of company sales value and is excluded from Monthly Closing for everyone including the CEO."
metadata: 
  node_type: memory
  type: reference
  originSessionId: ae189d07-172a-45ce-b429-270b6b1adcf8
  modified: 2026-08-10T12:29:52.888Z
---

Measured in production 2026-08-10 (`source_of_sales_import_rows`):

| Line | Value | Restricted-SKU value |
|---|---|---|
| **Head Office** | 276,753,978.51 | **276,743,520.51** (149,164 rows) |
| CNS | 47,552,757.61 | 0 |
| Pedia | 16,788,399.65 | 0 |
| Anti Infective | 5,574,488.01 | 0 |

Two consequences that are easy to get backwards:

1. **Monthly Closing is unaffected by the restricted-SKU lock.** `listMonthlyClosingLines` drops Head
   Office for *everyone including the CEO* (pinned by `tests/closing-excludes-head-office.test.ts`),
   and no restricted row exists on the three closing lines. So a role without
   `canViewRestrictedProducts` gets a workbook **identical** to the CEO's — never add a
   "confidential excluded" disclaimer to a closing export, it would be false.
2. **Source of Sales is where it bites, hard.** `getSosDashboard` drops Head Office for
   non-CEO/Super-Admin, so such a viewer's headline "Total Value" reads **≈69.9M against a real
   ≈346.7M — about 20%**. Head Office ≈ the restricted-product business.

**How to apply:** when granting `sales` to a role that lacks `canViewRestrictedProducts` (CEO +
Super Admin only), say nothing about the closing, and label the SoS total on the figure itself —
`sos-dashboard-impl.tsx` does this via `canRevealRestricted` (identical membership to
`canViewHeadOfficeLine`, so one flag covers both).

Related: [[expenses-permission-also-gates-all-marketing-requests]] · [[cns-closing-value-inflated-by-wrong-factory-prices]]
