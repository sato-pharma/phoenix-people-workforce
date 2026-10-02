---
name: admin-shell-design-rules
description: "Admin-shell restyle scope — sidebar, topbar/navbar and CEO identity banner are locked; everything else (tables especially) may be restyled, but NEVER with rounded corners: the square-edge golden rule (owner, 2026-09-04) binds everywhere, and globals.css's border-radius:0 sweep (RULE 1) must stay."
metadata:
  type: feedback
  originSessionId: 7a4fd344-9e8e-4a7f-8f44-4e6f52c8d8df
  modified: 2026-10-02T16:31:29.630Z
---

**SUPERSEDES the old "square corners + black/orange grid tables, never change" rule — except
the square corners, which the 2026-09-04 square-edge golden rule made binding again (below).**
On 2026-07-24 the user explicitly reopened the admin shell for restyling and narrowed
the lock to three things only:

1. `Sidebar` — `src/components/layout/sidebar.tsx`
2. `Topbar`/navbar — `src/components/layout/topbar.tsx`
3. CEO identity banner — `src/components/admin/ceo-hero-identity.tsx` (used inside
   `ceo-command-center.tsx`)

**Everything else inside `.admin-shell` may be freely restyled, tables especially — except
its corners.** Of the two previously-"PERMANENT"/"LOCKED" global CSS rules in
`app/globals.css` (search "PERMANENT ADMIN-SHELL DESIGN RULES", ~line 707–737):
RULE 1 forces `border-radius:0` on everything via `.admin-shell [class*="rounded"]` — it
**stays**: the owner's square-edge golden rule (2026-09-04, *"no round or semi-round corners,
anywhere"*, AGENTS.md §4) binds every surface, so RULE 1 is never removed or loosened, and it is
not full coverage either (a hand-written `border-radius` on a plain class name and scrollbar
thumbs escape it — see `docs/agents-owner-rules.md`, "The square-edge golden rule").
RULE 2 forces flat-black table headers + orange hairline borders on every
`.admin-shell table`/`th`/`td` — that one is still in scope to change/remove; do not treat it
as untouchable just because the CSS comment still says "LOCKED".
**Superseded 2026-10-02:** previously RULE 1 (the square-corner sweep) was also "in scope to change/remove" — the owner's square-edge golden rule of 2026-09-04 (AGENTS.md §4) made square corners binding everywhere.

**Why:** the user wants a broader visual refresh of the admin shell (component-level
redesign, possibly via a v0/shadcn tool bundle — see [[admin-shell-restyle-superseded-by-portal-primitives]]),
but wants brand continuity preserved in the three chrome elements above since those
are the constant, always-visible identity anchors across every admin page.

**How to apply:** when redesigning any admin page/table/card, the rest of the old
"Report It" recipe ([[premium-design-language]]) is a starting reference, not a rule — but its
square corners ARE a hard constraint again: no round or semi-round corner on any element, and
measure computed `border-radius` rather than trusting the `globals.css` sweep.
**Superseded 2026-10-02:** previously the whole square-corners recipe was "a starting reference, not a rule" — the square-edge golden rule of 2026-09-04 (AGENTS.md §4) restored square corners as binding.
Before touching
`sidebar.tsx`, `topbar.tsx`, or `ceo-hero-identity.tsx`, stop and confirm with the
user even if a broader restyle task seems to imply it. The employee-portal mirror
rules further down in `globals.css` (`.employee-portal-shell` RULE 1/2) were NOT
mentioned by the user and remain in force — this change is admin-shell only unless
told otherwise.
