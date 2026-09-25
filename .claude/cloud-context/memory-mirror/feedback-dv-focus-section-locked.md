---
name: feedback-dv-focus-section-locked
description: "Owner-locked — never modify the DoubleVisitFocusSection (\"Scope Focus\" + \"Probation Watchlist\") on the NSM command center."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 950d7fe4-00a5-49cd-abc5-f45bda84ec1e
  modified: 2026-07-20T16:46:04.622Z
---

The owner said "LEAVE THOSE 2 SECTIONS AS THEY ARE, DO NOT MESS" about the two Double-Visit widgets on the National Sales Manager portal landing: **Scope Focus** (coverage %, "X of Y team members haven't been double-visited", covered/neglected list, "Open Double Visit Report") and **Probation Watchlist** ("… DV pending", days-left). Both render from `src/components/employee-portal/dashboards/double-visit-focus-section.tsx` via `<DoubleVisitFocusSection focus={dvFocus} />` in `nsm-command-center.tsx`.

**Why:** They already work the way the owner wants; churn there is unwanted.

**How to apply:** When editing the NSM command center ([[portal-overview-dashboard-build]]), keep `<DoubleVisitFocusSection>` and its component file untouched — do not restyle, reorder its internals, or change its data source. The 2026-07-05 NSM command-center rebuild (PR #843) preserved it verbatim; match that. Reposition the whole block only if explicitly asked.

**2026-07-20 exception:** owner approved adding a small "{periodFrom} – {periodTo}" date-range subtitle under the Scope Focus header. Already shipped via PR #1208 (commit `2838d71c`, merged into main same day) — this is the one sanctioned tweak to the otherwise-locked component. A stray local copy of this same diff was also found sitting uncommitted on the unrelated `codex/cron-control-registry-updates` branch; confirmed identical to the merged PR #1208 content and discarded there (nothing new to commit). Still treat everything else about the widget (layout, data source, Probation Watchlist) as untouchable.
