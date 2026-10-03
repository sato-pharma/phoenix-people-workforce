---
name: the-pulsing-alarm-badges-cost-a-cpu-core-because-the-glow-is-a-box-shadow
description: "An idle Phoenix tab burns ~1 CPU core because `.nav-badge-alarm` / `-overdue` (app/globals.css) animate the glow with box-shadow (ep-breathe-*), which repaints every frame. Measured 3 Oct 2026, headless Edge, 3 badges: still page 14-17% of a core, today's badges 116-137%, same pulse drawn on the compositor (transform+opacity ring) 26-52%. The CONTINUOUS pulse is his decision (2 Sep) — fix HOW it is drawn, never stop it."
metadata:
  node_type: memory
  type: project
  originSessionId: c736da3e-674b-4f7e-be9d-28431270682f
  modified: 2026-10-03T13:50:37.457Z
---

Found 2026-10-03 when an idle Firefox tab on production `/employee-portals` held ~0.9 of a core
(Firefox GPU process ~70% + one tab process ~39%) while nothing was happening on it.

Not a loop: production `activity_events` (hr_id is stored lower case, `b-10`) showed no
repeated page views from any Firefox account. The `/overview` ↔ `/employee-portals` swapping seen
on the local dev server was HMR full reloads plus the Super Admin redirect, nothing more.

Cause: `.nav-badge-alarm` = `nav-badge-alarm-pump` (transform, cheap) + `ep-breathe-orange`
(box-shadow, repaints every frame), 1 s, infinite; `-overdue` is the same at 0.7 s with a red
glow. Used by the portal header Inbox badge (`employee-portal-layout.tsx`), the portal rail
"waiting on you" badge (`portal-chrome-widgets.tsx`), the admin sidebar (`layout/nav-badge.tsx`)
and the bell (`layout/in-app-notifications-bell.tsx`). `.employee-portal-nav-pending-dot` is
another box-shadow breathe. The laptop panel runs at 144 Hz, so that is 144 repaints a second.

Measurement: three badges over a 1,500-row table, headless Edge, 15 s per version, two runs
(test pages kept in that session's scratchpad `badge-test/`).

SHIPPED 2026-10-03 16:43 Cairo in roll-up #5251 (merge `3b200cdfe`, with #5248); the see-through
pill followed as PR #5252 — 🔒 OWNER CHOSE "option C" from a live A/B/C page: the dark pending pill
(`nav-badge-alarm-glass`) is painted as 20% orange-400 over EACH real ground (black sidebar,
`--phx-navrow-ground` on the top nav bars, #0d0d0d hovered row, #151311 hovered tab, #1a1209 active
tab), measured 0-4/255 from the see-through original. Option B (glow under the see-through fill)
fills the pill bright orange each pulse — rejected. If a nav row colour changes, its stand-in must too.

Originally BUILT as PR #5250 (`codex/badge-glow`, worktree `_wt-badge-glow`). The glow is the
badge's `::after` (a block 7px / 8px overdue larger than the badge, transform + opacity only),
`::before` is a copy of the fill over it (`background: inherit`) so the glow never shows inside,
and each axis starts from the badge's MEASURED size — `src/components/layout/alarm-glow.ts`,
passed as `ref={alarmGlowRef}` on all 7 badge sites. Traps found on the way:
- One shared scale is NOT the same look: a wide badge ("27", "99+") showed its glow above and
  below before the sides. Seen only by freezing old and new at 24 instants (`a.pause();
  a.currentTime = t` on `document.getAnimations()`) and diffing — reading the CSS did not show it.
- The see-through dark-rail pending pill (`bg-orange-400/20`) cannot be done this way (a fill copy
  doubles 20%, and a scaled glow cannot be kept off the badge's own area), so it keeps the
  box-shadow as `nav-badge-alarm-glass` — and ANY box-shadow glow on screen keeps the page
  repainting every frame, so admin pages showing that pill save little (167-179% -> 137-147%).
- Headless Edge composites in SOFTWARE: a page of 12 badges measured the new glow as dearer
  than the old. Measure the realistic case (the portal's 3 badges over a big page: 112-136% ->
  17-30%), and never read a headless number as the GPU cost. Firefox headless was too noisy.
- `border-radius: inherit` would trip `tests/square-edge-golden-rule.test.ts`'s inventory; not
  needed, since every alarm badge renders inside `.admin-shell` or `.employee-portal-shell`.
- The badge's Tailwind `ring-*` is a box-shadow the old animation overrode every frame, so
  `box-shadow: none` (motion on only) keeps today's look.
