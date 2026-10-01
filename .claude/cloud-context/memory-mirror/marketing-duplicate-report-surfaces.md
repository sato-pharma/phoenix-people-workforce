---
name: marketing-duplicate-report-surfaces
description: "Owner's 'duplicate reports' = the /admin/marketing-roi hub listing 4 ROI cards side by side; multi-shell mounts are intentional and must NOT be retired."
metadata: 
  node_type: memory
  type: project
  originSessionId: ac63cfc1-6251-4c01-afbd-b51e164335b2
  modified: 2026-10-01T00:00:00.000Z
---

**RESOLVED BY OWNER DESIGN 2026-07-28 (PR #1425 MERGED `2e08c0b5`).** Owner ruled: do NOT retire
the existing surfaces yet — build a NEW genuine one, retire the rest only once confirmed. And
split by PROVENANCE: from 2026-08-01 no more Excel imports, everything through Phoenix, and
Phoenix data is more accurate (validated at entry) so it must be reported separately.

Shipped: `marketing_requests.origin` (`'phoenix'` default | `'xlsx_import'`), all 217 existing
rows backfilled to `xlsx_import` (verified: every row created 2026-06-20 13:44–13:48, uniform
`REQ-*`; **there is not one Phoenix-submitted request in production**). Two modules:
`/admin/marketing-roi-tracker` (origin=phoenix, STARTS EMPTY) and
`/admin/archived-marketing-requests` (origin=xlsx_import, the 217). Both importers stamp
`xlsx_import` explicitly. ⚠️ `origin` is PROVENANCE — NOT the same as `status='archived'`
(81 rows = lifecycle "finished"); collapsing them corrupts both.
**LIVE IN PRODUCTION 2026-07-28**: migration `20260728124544` applied (217 → `xlsx_import`,
default `phoenix`), deploy dispatched and succeeded, both routes verified 200 on
`phoenix-hr.satopharma.com`. Also applied `20260728103222` (pharmacy reference backfill):
286 `pending` → **151 matched / 122 not_found / 14 ambiguous** — the 122 are the real worklist
(a `not_found` code has no sales 27.9% of the time vs 1.3% for `matched`). `tests/marketing-roi-tracker.test.ts` fails CI if the tracker ever adds its own
attribution engine.

---

Answer to the owner's 2026-07-27 question "why do I have duplicate reports".

**The visible cause:** `/admin/marketing-roi` is a HUB page (card grid, no data of its own).
`marketingRoiPageItems` in `src/config/system-navigation.ts` lists **four ROI cards side
by side** with non-disambiguating descriptions: "ROI Dashboard" (→ `/admin/sales-marketing-intelligence`),
"ROI Tracking" (→ `/admin/marketing-requests/roi-tracking`, **Super Admin only**),
"Marketing ROI Report" (→ `/admin/marketing-roi-report`), "Marketing Coverage Report".
Super Admin sees all four at once; CEO sees three.

**DO NOT RETIRE the multi-shell mounts.** `roi-filter-engine.tsx`,
`marketing-coverage-report-workspace.tsx`, `marketing-request-sales-view.tsx`,
`marketing-request-inbox.tsx`, `marketing-validation-workspace.tsx`,
`marketing-request-drafts.tsx` are each ONE component mounted into admin + portal (+ workspace)
so each role reaches it in their own shell. One component, one API — they cannot disagree.
Deleting them breaks roles rather than simplifying anything.

**`/workspace/**` is NOT a third shell** — it lives inside the `(admin)` route group and renders
the same sidebar. It has **zero nav entries anywhere**; 7 route files, effectively dead except
`/workspace/marketing-requests/inbox`, which is Financial Advisor's login landing
(`src/lib/auth/landing.ts:23`).

**Genuinely retirable (zero user impact):**
- `src/components/employee-portal/marketing-roi-tracking-workspace.tsx` (308 lines) — ZERO
  importers; its only fetch is a GET to a POST-only route (would 405). Kept alive only by
  `tests/marketing-roi-labeling.test.ts:114` reading it as a STRING. Plus its dead type chain
  in `types.ts:417-455` (no producer anywhere).
- `/workspace/marketing-requests/overview` — self-documents "This workspace page is retired as MM's landing".
- `/workspace/marketing-requests/roi-tracking` — no inbound link.
- `phx_sales_marketing_dashboard` RPC — zero callers repo-wide.

**How the duplicates got created — the recurring pattern:** every accidental duplicate came from
a commit whose stated purpose was something else. #497 "fix sidebar scroll-reset bounce" created
the whole `/workspace/marketing-requests/` tree; #560 "migrate Marketing Manager to portal"
resurrected the gen-1 ROI component that #375 had deleted 7 days earlier; #955 "consolidate admin
sidebar into hub pages" created `/admin/marketing-roi` and made "where is ROI?" role-dependent.
Only `/admin/marketing-roi-report` (#725) was deliberate — and it's the only one with a code
comment explaining itself.

**Label collisions:** "ROI Dashboard" names TWO unrelated pages; `/employee-portals/roi` carries
three names ("ROI", "ROI Dashboard", "ROI Intelligence"); "ROI Tracking" is one product at three
URLs. Marketing Manager's command center links roi-tracking 3×, one tile mislabeled
"validation pending".

**CEO redirect trap (live):** `roi-tracking/page.tsx:10-13` — the guard deliberately admits CEO
(`allowCompanyOversight`, comment calls CEO "the executive audience the ROI report is built for")
then immediately `redirect("/admin/marketing-roi")`. Hidden only because the nav card is
Super-Admin-only. The child `view-sales` page has NO such redirect — CEO blocked from the report
but allowed into its drill-down.

Related: [[marketing-roi-three-engines-divergence]], [[roi-tracking-filter-engine-rebuild]].
