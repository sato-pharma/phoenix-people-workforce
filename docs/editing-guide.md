# Phoenix Workforce Editing Guide

This guide explains where to make common system-wide edits without hunting through the full codebase.

## Safe Branch Rule

Do not edit `main` directly. Use the working branch or a dedicated feature branch, then validate before push or deployment. The working-branch name is documented in [current-operating-state.md](current-operating-state.md).

## Global Edit Points

| What you want to change | Main file |
| --- | --- |
| App name, brand labels, brand assets, public URLs, email defaults, global search/loading/login text, and edit/harden policy | `src/config/system-settings.ts` |
| Sidebar sections, page labels, icons, roles, permissions, and home links | `src/config/system-navigation.ts` |
| Global colors, typography tokens, and shared CSS variables | `src/styles/tokens.css` and `app/globals.css` |
| Shared UI primitives such as buttons, cards, inputs, badges, and switches | `src/components/ui/` |
| Admin shell layout and navigation rendering | `src/components/layout/` |
| Employee portal shell, dashboard, and portal-specific UI | `src/components/employee-portal/` |
| Business rules and data access by domain | `src/lib/<domain>/` |
| Browser pages and route screens | `app/**/page.tsx` |
| API endpoints | `app/api/**/route.ts` |
| Database schema and RLS changes | `supabase/migrations/` |
| Validation and regression tests | `tests/` |

## Navigation Changes

Use `src/config/system-navigation.ts` as the source of truth for navigation metadata.

Each navigation item has:

- `href`: the route path.
- `label`: the text shown in the sidebar.
- `icon`: the Lucide icon component.
- `permissions`: the required permission resource and optional action.
- `roles`: the only roles that should see the link.
- `excludedRoles`: roles hidden from the link where the renderer supports exclusions.

Keep access control in server-side permission checks too. Sidebar visibility improves the user experience, but it must not be the only security layer.

## Editing Mode

During active editing, use the fast local gate:

```bash
npm run check:edit
```

This keeps TypeScript honest without forcing every existing lint/test hardening rule to pass after each small UI move.

Before commit, push, PR, migration, or deployment, switch back to the full hardening gate:

```bash
npm run check:harden
```

Do not relax production-critical protections while editing. Authentication, permissions, RLS, payroll locks, employee lifecycle rules, and deployment checks stay protected even when the UI and configuration are being reshaped.

## Domain Change Rule

For business logic, start in `src/lib/<domain>/` before editing UI. The UI should call domain services instead of duplicating payroll, leave, expenses, outstation, HR, or sales rules inside components.

## Validation Before Delivery

Run the smallest useful validation first, then broaden if the change touches shared behavior:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

For production-impacting work, do not push or deploy until validation is clean or the risk is explicitly accepted.
