---
name: data-portal-desktop-table-is-inert-on-admin-pages
description: "The data-portal-desktop-table attribute hides a table only under the employee-portal shell; on admin pages it is decoration, and every current admin use also carries a real md: gate."
metadata:
  type: project
---

`data-portal-desktop-table` looks like a mobile gate and is not one, outside the portal.

The media query that gives it meaning — `@media (max-width: 767px) { [data-portal-desktop-table] { display: none !important } }` — is injected by `src/components/employee-portal/enterprise-shell.tsx`. Pages under `app/(admin)/` render `AppShell` and never mount that stylesheet, so on an admin screen the attribute does nothing at all.

**Verified 2026-08-24 — nothing is broken today.** All five admin uses also carry a real `hidden … md:block` or `hidden … md:table` wrapper:

| File | Line | Real gate |
| --- | --- | --- |
| `src/components/sales/targets-workspace.tsx` | 642, 780 | `hidden … md:block` |
| `src/components/recruitment/bulk-cv-extraction-panel.tsx` | 183 | `hidden … md:block` |
| `src/components/recruitment/contact-review-view.tsx` | 230 | `hidden … md:block` |
| `src/components/recruitment/intake-health-view.tsx` | 131 | `hidden … md:table` on the table itself |

I asserted the opposite first — "those tables are still visible on a phone" — and it reached a PR body before I checked the surrounding lines. The attribute is convincing enough on its own to produce a confident wrong answer, which is the whole reason this is written down.

**Why:** the risk is forward, not current. The attribute reads like a gate, so the next admin table can be shipped with it alone and be phone-visible with nothing to signal it. `AdminTableShell` appears in 55 files, so the blast radius is the whole admin shell, not one module.

**How to apply:** never accept `data-portal-desktop-table` as proof a table is desktop-only outside `app/(portal)/` — read the wrapper. `tests/outstation-mobile-table-cards.test.ts` deliberately excludes it from its `DESKTOP_GATES` for exactly this reason, while its CRM sibling accepts it (CRM is portal-side). Before claiming an admin table is phone-visible, check ±8 lines for `hidden … md:block` / `md:table`. The clean fix, if ever asked for, is to scope that CSS to both shells or drop the attribute from admin files.

See [[the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open]] and [[crm-mobile-cards-are-module-wide-and-ci-enforced]].
