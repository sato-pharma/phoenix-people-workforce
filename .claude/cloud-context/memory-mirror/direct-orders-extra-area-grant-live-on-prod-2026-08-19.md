---
name: direct-orders-extra-area-grant-live-on-prod-2026-08-19
description: "Salim Gomaa (B-76) can raise a Direct Order in Alex-BHR via a code-level grant, NOT the seat map — live on prod since #2204; moving it into the seat map would strip Sara Samir's district."
metadata:
  type: project
---

`src/lib/direct-orders/extra-area-grants.ts` hand-lists extra AREA codes per HR id, read in exactly
one place — `listDirectOrderAreaAndBrickOptions` in `src/lib/direct-orders/service.ts`. Today it
holds one entry: **B-76 (Salim Gomaa) → AB1–AB5 (Alex-BHR)**. Live on prod since #2204, merged
2026-08-19, revision `9c7a3ca078b6580bdc4988310d6e87a37471bb18`. Verified against prod data: B-76
resolves **10 areas / 207 bricks**, B-156 (Sara Samir) still **5 / 118** — unchanged.

**Why:** `au.line_area_map` has unique index `line_area_map_current` on `(line_code, area_code)
WHERE effective_to IS NULL` — exactly ONE district-manager seat per area per line. So re-pointing
AB1–AB5 at Salim's seat `SEAT-AIF-DM-D2` would have TAKEN Alex-BHR off Sara Samir's seat
`SEAT-AIF-DM-AB` and moved her sales attribution, targets, incentive scope and approval chain with
it. The owner's instruction was "don't change any other thing", so the grant lives outside the seat
map. See [[au-seat-drift-view-is-the-org-truth-check]].

**How to apply:** do NOT "clean this up" into the organogram or `au.line_area_map`. Do NOT let a
second module import the grant — `tests/direct-orders-extra-area-grants.test.ts` fails the build if
anything but the Direct Orders service reads it, and that lock IS the owner's rule, not style. It
only ever WIDENS: an HR id with no entry behaves exactly as before. Bricks are derived from the
granted areas, so a new brick needs no edit. Sales dashboards, targets, incentives, the org chart and
the approval chain all still read the seat map alone — this changes Direct Orders only.
