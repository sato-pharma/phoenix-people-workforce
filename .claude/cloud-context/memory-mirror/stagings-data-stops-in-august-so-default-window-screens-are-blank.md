---
name: stagings-data-stops-in-august-so-default-window-screens-are-blank
description: "staging's operational data stops around 2026-08-26 while the calendar runs on, so every 'last 30 days' or 'current period' screen renders EMPTY — the portal attendance page hard-codes 30 days and takes no searchParams, while the admin fingerprint report and Early Birds read the window from the URL. Check each page's default window before promising a screenshot or a demo"
metadata:
  node_type: memory
  type: project
  originSessionId: d633e730-6670-4001-a5e4-27b0a4fd99f4
  modified: 2026-10-06T05:51:38.736Z
---

Found 6 Oct 2026 while specifying the Time & Leave film for the *Inside Phoenix* series, on
staging `cifwmndunmlxjhyjugxa`. Related:
[[filming-a-phoenix-screen-money-and-role-gates-cut-it-first]] — this is the THIRD gate that cuts
a screen, after money and role scoping.

**The shape:** staging was seeded to a point in time and the clock kept going. Measured that day:
`attendance_raw_punches` runs 2026-01-01 .. **2026-08-26**; `v2_vacation_requests` 2026-01-01 ..
2026-09-03; Early Birds has snapshots for `2026-07-H1`, `2026-07-H2`, `2026-08-H1` and nothing
since. Today was 2026-10-06, so anything defaulting to "the last 30 days" or "the current period"
had **no rows at all** — not an error, not an empty state worth filming, just blank.

**And the remedy is per page, which is the part that bites:**

| Screen | Window | Filmable? |
| --- | --- | --- |
| `app/employee-portals/attendance/page.tsx` | `dateTo = today`, `dateFrom = today - 30`, **no searchParams** | **No** — cannot be pointed at August |
| `/attendance/fingerprint-report` | `dateFrom`/`dateTo` read from searchParams | Yes, with `?dateFrom=2026-08-01&dateTo=2026-08-26` |
| `/admin/early-birds` | `?period=`, defaulting to the live period | Yes, with `?period=2026-08-H1` |

**How to apply:** before promising any screenshot, demo or smoke check against staging, open the
page file and find where its date range comes from. A page that takes the window from the URL can
be aimed at the data; one that computes it from `today` cannot, and no amount of clicking will
fill it. The same applies to a staging walkthrough for a person — they will see empty screens and
conclude the module is broken.
