---
name: admin-shell-sidebar-per-user-curation
description: "RETIRED 2026-08-28 (#2505). Modules Control and sidebar_module_assignments are GONE — the replacement is a per-caller personal layout, not a targeting matrix."
metadata:
  node_type: memory
  type: reference
  originSessionId: 86dead4a-bc1f-4bec-9468-73095b6ae999
  modified: 2026-08-28T05:25:46.927Z
---

# 🔴 RETIRED — do not follow the recipe below

**Modules Control was removed on 2026-08-28 by PR #2505.** `src/lib/admin/modules-control.ts`,
`src/lib/employee-portal/module-curation.ts`, `/admin/modules-control` and
`/api/admin/modules-control` no longer exist — the routes return **404** (verified on production
that day, revision `90c6ea87`). Production `sidebar_module_assignments` held **0 rows** at the time
of retirement, so nothing was curated by it when it went. Everything under "What it used to do" is a
**dated record of how it worked**, kept because older sessions and docs still reference it — not
instructions. Do not insert rows, do not look for the UI, and do not rebuild it.

## What replaced it, and why it is a different shape

The owner's ask, verbatim 2026-08-28: retire Modules Control *"totally… with no traces ever"*, do
**not** add a way to create modules, be able to *"move everything anywhere"* across the three nav
layers, and — the sentence that decides the design — ***"I don't mean in anyone account. I mean in
my own account."***

So the replacement is the **inverse** of what is described below:

| | Modules Control (retired) | Personal layout (now) |
| --- | --- | --- |
| Who it targets | other people, by `target_type in ('user','role','position','line')` | **only the caller**, keyed on their own `hr_id` |
| Granularity | a whole module, by `module_id` | **a single page**, by `href` |
| Cross-module moves | impossible | the whole point |
| Storage | `sidebar_module_assignments` | `nav_personal_layout` (one row per person, jsonb) |

Built on branch `codex/nav-free-placement`, PR **#2516**. Key files:
`src/lib/navigation/personal-layout.ts` (pure core), `personal-layout-store.ts`,
`app/api/navigation/personal-layout/route.ts`, `src/components/admin/sidebar-layout-editor.tsx`,
page at `/admin/sidebar-layout` (Admin Tools card, Super Admin only). See
[[nav-personal-layout-is-per-caller-never-a-targeting-matrix]] for the invariants that keep it safe.

## What it used to do (dated record — 2026-06-21 to 2026-08-28)

Rows in `sidebar_module_assignments`: `target_type='user'`, `target_key`=lowercased hr_id or
login_id, `navigation_mode='admin'`, one `module_id` per kept item, `sort_order`, `is_enabled=true`.
That is what the `/admin/modules-control` UI wrote (`saveModuleControlAssignments`); reversible by
deleting the rows. It was used once in anger — Marketing Manager A-9 "Hossam Reda", 2026-06-21,
removing Report It / HR Actions center / Expense Dashboard.

`getEffectiveSidebarModuleIds` resolved candidates **user → role → position → line**; the first type
with any rows won and became an exact whitelist, further filtered by that person's role/permission
validity. It hid items from both the sidebar and the command palette. As of PR #421 it also honoured
`sort_order` for items and sections.

## What is STILL TRUE from the old gotchas

- **`getSections` honours `excludedRoles` in BOTH modes** (fixed 2026-06-24,
  `src/lib/navigation/active-path.ts`). Still the valid way to hide an admin nav item from a role.
- **Admin-shell-employee roles** (`adminShellEmployeeRoles`: SFE Manager, Marketing Manager, Finance
  Manager, Financial Advisor, Talent Acquisition) land in AppShell `navigationMode="admin"` at
  `/workspace/*`, so they see the full admin nav filtered by role+permission. Permission-only items
  used to be curated away with Modules Control; **with it gone, the only remaining levers are
  `roles`/`excludedRoles`/`permissions` in `system-navigation.ts`** — a config change affecting
  everyone in that role, not one person. [[portal-sidebar-real-source]]
