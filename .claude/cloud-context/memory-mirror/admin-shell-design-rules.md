---
name: admin-shell-design-rules
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: no round or semi-round corners, anywhere ... the globals.css square sweep must not be treated as removable (owner rule 2026-09-04) (see the module rule 'AGENTS.md section 4 - SQUARE-EDGE GOLDEN RULE (outside the 12 module files; acco'). Older text follows: Admin-shell restyle scope (updated 2026-07-24) — ONLY sidebar, topbar/navbar, and CEO identity banner are locked; everything else (especially tables) is free to restyle."
metadata:
  type: feedback
  originSessionId: 7a4fd344-9e8e-4a7f-8f44-4e6f52c8d8df
  modified: 2026-08-04T15:39:34.340Z
---

**SUPERSEDES the old "square corners + black/orange grid tables, never change" rule.**
On 2026-07-24 the user explicitly reopened the admin shell for restyling and narrowed
the lock to three things only:

1. `Sidebar` — `src/components/layout/sidebar.tsx`
2. `Topbar`/navbar — `src/components/layout/topbar.tsx`
3. CEO identity banner — `src/components/admin/ceo-hero-identity.tsx` (used inside
   `ceo-command-center.tsx`)

**Everything else inside `.admin-shell` may be freely restyled, tables especially.**
That includes the two previously-"PERMANENT"/"LOCKED" global CSS rules in
`app/globals.css` (search "PERMANENT ADMIN-SHELL DESIGN RULES", ~line 707–737):
RULE 1 forces `border-radius:0` on everything via `.admin-shell [class*="rounded"]`,
RULE 2 forces flat-black table headers + orange hairline borders on every
`.admin-shell table`/`th`/`td`. Both are now explicitly in scope to change/remove —
do not treat them as untouchable just because the CSS comment still says "LOCKED".

**Why:** the user wants a broader visual refresh of the admin shell (component-level
redesign, possibly via a v0/shadcn tool bundle — see [[admin-shell-restyle-superseded-by-portal-primitives]]),
but wants brand continuity preserved in the three chrome elements above since those
are the constant, always-visible identity anchors across every admin page.

**How to apply:** when redesigning any admin page/table/card, do NOT reuse the old
"Report It" square-corners-everywhere recipe ([[premium-design-language]]) as a hard
constraint — it's now a starting reference, not a rule. Before touching
`sidebar.tsx`, `topbar.tsx`, or `ceo-hero-identity.tsx`, stop and confirm with the
user even if a broader restyle task seems to imply it. The employee-portal mirror
rules further down in `globals.css` (`.employee-portal-shell` RULE 1/2) were NOT
mentioned by the user and remain in force — this change is admin-shell only unless
told otherwise.
