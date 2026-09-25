---
name: coaching-analytics-shared-dashboard
description: "Coaching analytics is ONE shared component (3 surfaces); rebuilt as a corporate-report layout in PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: c3a0a8ed-bbf4-459f-ba83-956fa90454d5
---

`src/components/coaching/coaching-analytics-dashboard.tsx` is a SINGLE shared component rendered by 3 pages with an identical prop/payload contract — editing it changes all three:
- PM/GPM portal `/employee-portals/coaching-analytics` (Product Manager / Group Product Manager / Marketing Manager)
- Training-Manager portal `/employee-portals/training-manager/coaching`
- Admin `/coaching/analytics`

Only `CoachingAnalyticsDashboard` + the exported types `CoachingAnalyticsPayload` / `CoachingAnalyticsFilterOptions` are external (the 3 pages + `analytics-options.ts`). Governed by the locked `.employee-portal-shell` / `.admin-shell` CSS in `app/globals.css`: square corners (rounded-* → 0), black centered `<thead>` cells (#000000), light-orange cell grid. So never put filter inputs inside `<thead>` (they render on solid black) and never use `truncate` (see [[no-text-truncation-or-wrapping]]).

**2026-06-28 rebuild — SHIPPED TO PROD** (PR #593, squash-merge `fb526ad9` on main, live at phoenix-workforce.vercel.app): owner rated the old dashboard 1/10. Final chosen design = a **"corporate report" layout** — structured, table-led, editorial: an Executive Summary stat strip + performance-zone bar, a ranked **Coaching Skill Index** table, a hand-rolled quarterly trend (no chart lib) **aggregated by quarter**, Coverage-by-Area + Medical-Rep-Comparison tables, Parameter Detail, and a Per-Rep Detail table, each under a black-underlined section rule. It surfaces `categoryAverageScores` + `scoreItemAverageScores` + `analytics.bestScore` (computed-but-unrendered before).

GOTCHAS for future edits here:
- `tests/coaching-analytics.test.ts` greps the dashboard SOURCE for exact strings (section titles like `title="Coaching Skill Index"`, `coachingReportBase = pathname?.startsWith`, `SelectField`). Renaming a section title or KPI label BREAKS this test — update it in the same change.
- `buildQuarterTrend` MUST aggregate the quarterly summary by (year, quarter): the rows are one-per-rep-per-quarter, so mapping each row 1:1 produces a spiky chart and duplicate React keys (~500 console errors).
- Design was approved only after SHOWING mockups / rendering live — designing blind got rejected twice. Render as Super Admin on `/coaching/analytics` (real data) to verify; the portal page needs a real PM HR_ID (dev-auth PM has no coaching scope → all zeros). Headless preview is flaky on screenshots (see [[local-browser-verify-gotchas]]).

Related: [[parallel-session-swarm-hazard]] (a parallel session pushed a test commit to this same PR branch mid-task).
