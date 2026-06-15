# Workflow Governance & Route Architecture

This document removes two long-standing sources of confusion in the codebase:

1. **Which approval modules are governed by the workflow registry vs by hardcoded
   TypeScript** — the "single source of truth" claim was only partially true.
2. **Which route folders own their own app shell / access guard** — the admin route
   group is not the only place admin-style pages live.

It is reference material. It does not change runtime behaviour.

---

## 1. Workflow governance: registry-governed vs code-governed

Approval state machines live in two styles. Both are legitimate; the point is to know
which is which before changing a transition.

- **Registry-governed** — transitions are validated against the
  `workflow_registry_modules` table through `src/lib/workflow-registry/` (functions
  `assertWorkflowRegistryTransition` / `assertWorkflowRegistryRuntimeTransition`).
  The registry is the source of truth for *allowed from→to + allowedRoles + reason
  requirements*, and it writes audit logs.
- **Code-governed** — transitions are a hardcoded TypeScript table in the domain
  module. The registry is not consulted.
- **Hybrid** — the registry is consulted *and* a local TypeScript table carries
  semantics the registry can't express (per-action side effects, or an extra guard).

| Module | Governance | Registry module key | Definition file |
|---|---|---|---|
| Vacation / Leave | Registry | `leave_requests` *(legacy alias — see below)* | `src/lib/vacation/workflow.ts` |
| Coaching | Registry | `coaching_reports` | `src/lib/coaching/workflow.ts` |
| Marketing requests | Registry | `marketing_requests` | `src/lib/marketing-requests/workflow.ts` |
| Outstation expenses | Registry | `outstation_expenses` | `src/lib/outstation/workflow.ts` |
| Resignations | Registry | `resignations` | `src/lib/employee-lifecycle/workflow.ts` |
| Offers | Registry | `offers` | `src/lib/employee-lifecycle/workflow.ts` |
| Contracts | Registry | `contracts` | `src/lib/employee-lifecycle/workflow.ts` |
| Probation | **Hybrid** | `probation` | registry key in `src/lib/employee-lifecycle/workflow.ts`; local guard `validateWorkflowTransition` in `src/lib/probation/service.ts` |
| Payroll | **Hybrid** | `payroll_batches` | registry cross-check in `src/lib/payroll/workflow-registry.ts`; local side-effect table `payrollTransitions` in `src/lib/payroll/workflow.ts` |
| Weekly Planning | **Code-governed** | — (none) | hardcoded `WEEKLY_PLAN_TRANSITIONS` in `src/lib/weekly-planning/workflow.ts` |

### Practical rules

- Changing a **registry-governed** transition's allowed roles / from→to may be a data
  change in `workflow_registry_modules`, not a code change. Check the registry first.
- Changing a **hybrid** module (payroll, probation) almost always needs **both** the
  registry entry *and* the local table to stay in sync. Payroll deliberately throws a
  `Workflow Registry mismatch` error if the registry and the local `payrollTransitions`
  table disagree — that is a guardrail, not a bug.
- **Weekly Planning** is intentionally code-only today; do not assume the registry
  governs it.

### The `leave_requests` registry-key alias (do not rename)

`src/lib/vacation/workflow.ts` exports:

```ts
export const leaveWorkflowRegistryModuleKey = "leave_requests";
```

This literal string is a **legacy alias**, not a live table:

- The old leave engine and its `leave_requests` table were **dropped** in migration
  `20260610000000_drop_dead_leave_engine.sql`. Vacations now live in
  `v2_vacation_requests`.
- The key `"leave_requests"` is persisted as `workflow_registry_modules.module_key`
  and is referenced by audit-log entity ids.
- **Renaming it would orphan registry rows and audit history.** Keep the alias; treat
  "leave_requests" in registry/audit context as "the vacation workflow".

### The Workflow Control Center is read-only (not a second engine)

There is a separate "Workflow Control Center" under `src/lib/workflow-control/`,
`app/api/admin/workflow-control/**`, and `src/components/workflow-control/`, surfaced at
`/admin/workflow-control`. It is a **read-only map + simulator**, not a governance
engine:

- Its persistence/publish/rollback feature flags are hardcoded `false`
  (`src/lib/workflow-control/feature-flags.ts`); the draft/publish/rollback APIs return
  `*_disabled` and write to **no** table.
- The runtime engine (`src/lib/workflow-registry/`) imports **nothing** from
  workflow-control — there is zero coupling.
- Its `definitions.ts` is static display data, not consumed by the engine.

So "publishing" in the Control Center cannot change production behaviour today. If draft
authoring is ever enabled, it must be folded into the registry, not run in parallel.

---

## 2. Route categories & app-shell ownership

Not every admin-style page lives in the `app/(admin)/` route group. The `(admin)` group
folder is invisible to URLs (Next.js route group), and its layout
(`app/(admin)/layout.tsx`) provides the shared `AppShell` + login guard **once** for all
pages inside it. Pages outside the group own their shell per-page on purpose.

| Category | Where | Shell / guard ownership |
|---|---|---|
| **Admin group** | `app/(admin)/**` (e.g. `app/(admin)/admin/access`, `app/(admin)/employees`, `app/(admin)/admin/system-cleanup`) | `AppShell` + login redirect from `app/(admin)/layout.tsx`. Pages must **not** re-add `AppShell`. Page-specific permission guards still live in the page. |
| **Dual-mode pages** | `app/payslips`, `app/leave-management` | Render `AppShell` (admin) **or** the employee-portal shell depending on `resolveNavigationMode`. Stay outside the group by design. |
| **Full-width / standalone admin** | `app/organogram`, `app/offers` | Own per-page `AppShell` (often `contentWidth="full"`) + own guard. |
| **Redirect hubs** | `app/overview` | No shell — resolve role and redirect (e.g. to the role landing path). |
| **Employee portal** | `app/employee-portals/**` | Employee-portal shell, never `AppShell`. |

### Rule for new admin pages

Put new admin pages **inside `app/(admin)/`** and let the group layout supply the shell.
Only render a per-page `AppShell` if the page is genuinely dual-mode, full-width, or a
public/standalone surface (the four categories above). `system-cleanup` was moved into
the group (`app/admin/system-cleanup` → `app/(admin)/admin/system-cleanup`) for exactly
this reason — its URL `/admin/system-cleanup` is unchanged.

> Sidebar visibility (`src/config/system-navigation.ts`) is UX only — it is **never**
> the security boundary. Every route still enforces access on the server.
