---
name: admin-route-group-shell
description: "Admin pages live under app/(admin)/ and get AppShell from the group layout — never re-add per-page AppShell."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7a4fd344-9e8e-4a7f-8f44-4e6f52c8d8df
---

The admin surface was migrated to a Next.js route group: all always-admin segments
live under `app/(admin)/` (admin, attendance, coaching, contracts, cv-database,
employees, hiring-documents, hr-calendar, payroll, probation, reports, resignations,
sales). The shared `app/(admin)/layout.tsx` renders `<AppShell navigationMode="admin">`
once, so the sidebar/topbar stay mounted across navigation. Route groups don't change
URLs (`/employees`, `/payroll`, etc. are unchanged).

**Do NOT** add `<AppShell>` inside these pages — that double-wraps the shell. Pages just
return their content; `loading.tsx` files return content skeletons only (no AppShellLoading).

Intentional exceptions that KEEP their own per-page shell (do not move into the group):
`app/organogram` (contentWidth="full"), `app/payslips` (dual admin/employee chrome),
`app/leave-management` (own hybrid layout), `app/offers` (public `[token]` pages).

Sidebar active-route logic now lives in [[nav-active-path-and-lint-noise]].
