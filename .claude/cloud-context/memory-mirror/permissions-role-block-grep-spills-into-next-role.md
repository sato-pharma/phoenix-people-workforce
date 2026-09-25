---
name: permissions-role-block-grep-spills-into-next-role
description: "Grepping src/lib/auth/permissions.ts for one role's grants silently returns the NEXT role's line — parse block boundaries instead"
metadata: 
  node_type: memory
  type: reference
  originSessionId: b69b2a0c-6ede-46dc-969f-a15c6572317e
  modified: 2026-08-11T21:16:08.149Z
---

In `src/lib/auth/permissions.ts` the role blocks are long (100+ lines each) and many roles have no
grant for a given resource. Searching forward from a role's header for `<resource>:` therefore runs
past the end of that role's block and returns the **next** role's line, with no error.

Concretely: searching from `"Medical Rep": {` for `direct_orders` returns
`direct_orders: ["read","create","update","approve","export"]` — which belongs to **District
Manager**, the following block. Medical Rep actually has **no** `direct_orders` grant.

**Why:** a wrong answer here inverts a role's access in any matrix you build, and it reads as
plausible, so nothing downstream catches it.

**How to apply:** collect every 2-space-indented `Role: {` header with its line number first, then
search only within `[thisHeader.line, nextHeader.line)`. Report "(no grant)" when the slice has no
match — never widen the window to find one. Verified 2026-08-12 against `origin/main` 76e4016b:
9 roles hold a `direct_orders` grant, 7 hold none.

Related: [[monthly-closing-view-access-four-gates]], [[restricted-skus-are-all-head-office-line]].
