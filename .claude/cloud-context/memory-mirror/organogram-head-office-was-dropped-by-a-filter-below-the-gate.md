---
name: organogram-head-office-was-dropped-by-a-filter-below-the-gate
description: "The portal Organogram has its OWN line picker; its unconditional office-line filter discarded Head Office AFTER the permission gate had allowed it"
metadata:
  type: project
---

The employee portal builds **its own line picker**, not just its own sidebar (see
[[portal-sidebar-real-source]]). `employee-organogram-dashboard.tsx` ran
`if (isOfficeLine(r)) continue;` **unconditionally**, so Head Office rows arrived in the
browser — past `canAccess`, past `canAccessHeadOffice`, past the company-mode strip in
`getOrganogramReport` — and were then thrown away by the **last** filter in the chain, one
that knows nothing about entitlement. No error, no empty state: the branch simply had no
button, and a chart cannot draw a line that was never offered. Fixed 2026-08-26 in #2427
(`buildLinePickerOptions(rows, { includeHeadOffice })`, set server-side from
`isCompanyScoped && canAccessHeadOffice(access)`).

The **admin** surface never had it — `lineOptions` in `organogram-report.tsx` *adds* office
rows instead of skipping them. So "it works in the admin account" was true and proved nothing
about the portal.

**Why:** it cost three rounds on one request. #2408 built the branch and granted her the role
([[organogram-head-office-branch-built-in-app-layer]]); #2410 then edited
`system-navigation.ts`, which does not build the portal sidebar, to fix a menu that was never
missing — `showOrganogramTab` in `src/lib/employee-portal/navigation.ts` had included
`isTalentAcquisition` all along. Two PRs shipped to production without touching the cause.

**How to apply:** when a viewer is *granted* something and still cannot see it, do not re-verify
the grant, the deploy, or CI — they will all be green. Walk the chain **downstream** of the gate
to the last thing that drops a row, and check every presentational filter on the way: a picker,
a tab list, a default selection, a sort that hides. Prove it by running the real report for that
person's `hrId` and printing what the final filter returns, not what the gate returns. And render
the page as them (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`, `x-phoenix-role` + `x-phoenix-hr-id`,
curl the HTML and grep for `aria-pressed`) — the rendered page is the only thing that answers
"can she see it".
