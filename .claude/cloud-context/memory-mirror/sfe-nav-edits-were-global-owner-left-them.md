---
name: sfe-nav-edits-were-global-owner-left-them
description: "PR #1625's \"SFE sidebar\" changes altered every admin role's sidebar; the owner reopened it 2026-08-08 and the fix is now role-scoped via flatSidebarRoles — the SFE Manager's flat look is deliberate, everyone else's headings are deliberate too"
metadata:
  node_type: memory
  type: project
  originSessionId: 76295fe4-b670-48b6-9ffa-a761ec132a4c
  modified: 2026-08-08T17:30:55.472Z
---

**RESOLVED 2026-08-08 — this is no longer a "leave it alone" note. Both looks are now intentional
and enforced by a test.** (Superseded the 2026-08-04 decision to leave the damage in place.)

PR #1625 (`fix(sfe): rebuild the SFE Manager overview`, 2026-08-02) was an SFE-only brief that
edited **shared** admin nav: it blanked four section headings (`label: ""` on `command-center`,
`my-requests`, `workspace-marketing-requests`, `people-management`), deleted the `standalone`
hub-button treatment from `sidebar.tsx`, and folded five modules into hub pages. In the SFE session
each of those sections held exactly one button, so the heading only repeated the button. On Super
Admin and CEO they hold several rows, so it left loose unlabelled buttons — and because the label
doubles as the collapse key, those sections could not be collapsed either.

The owner raised it 2026-08-04, called the fix off, then **reopened it 2026-08-08**: *"leave SFE
Manager sidebar as it is and recover the Super Admin and CEO sidebars as they were."*

**The mechanism now: `flatSidebarRoles` / `usesFlatSidebar` in `src/lib/navigation/active-path.ts`.**
It lists the roles that keep the flat look (currently just `SFE Manager`). `getSections` blanks
section labels for those roles; `sidebar.tsx` passes `standalone={!flatSidebar}` for the hub styling.
Section labels stay REAL in `system-navigation.ts` — they are also the Modules Control catalog's
`sectionLabel`, the sidebar search key and the drag-handle aria text, so they must never be `""`
at the source. It lives in `active-path.ts`, not the nav config, to keep that module free of the
lucide icon graph.

Five modules were also restored as their own rows for non-SFE roles, with the hub copy kept for the
SFE Manager: `/probation` (+ dashboard/analytics/settings), `/admin/field-workforce-compliance`,
`/admin/pm-products`, `/admin/marketing-roi-tracker`, `/admin/crm`.

**The trap that bites: `excludedRoles` is the ONLY lever that works on Super Admin.** The
system-administrator workspace (`access.scope === "system" || access.role === "Super Admin"`)
bypasses `roles` and `permissions` but still honours `excludedRoles`. So the hub copies carry
`excludedRoles: ["Super Admin"]` — without it he sees the hub button AND the expanded rows it
duplicates. Putting `roles: ["SFE Manager"]` on a hub is not enough by itself.

**Why:** the config still reads like a bug in both directions — a future `/code-review` or cleanup
pass could "fix" the SFE Manager's blank headings back, or strip the seemingly-redundant
`excludedRoles`. Either one silently re-breaks a sidebar the owner is happy with.

**How to apply:** to change who gets the flat look, edit `flatSidebarRoles` — nothing else.
`tests/sidebar-role-scoped-headings.test.ts` pins both halves (Super Admin/CEO get headings and
rows; SFE Manager stays headless with his hubs) and fails by name if either regresses. The original
decision sheet is at `xlsx/super-admin-sidebar-revert-decisions.xlsx` (gitignored, 12 rows) — rows
1-9 are now implemented; rows 10-12 (Marketing Approval Inbox, Request Vacation/Submit Excuse,
Sales Queue retirement) were deliberately kept as-is. Related:
[[match-module-design-before-building-ui]], [[admin-shell-design-rules]].
