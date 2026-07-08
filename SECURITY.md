# Security Policy

Phoenix Workforce is a private enterprise HR/workforce platform that handles
sensitive employee data including personally identifiable information (PII),
payroll records, salary details, bank account information, and HR workflow
approvals. Security is a first-class concern across every layer of the system.

---

## Reporting Vulnerabilities

**Do not open public issues for security vulnerabilities.**

Contact the repository owner directly through GitHub. When reporting, include:

- A clear description of the vulnerability
- Steps to reproduce the issue
- An assessment of the potential impact
- A suggested fix, if applicable

Reports will be acknowledged promptly and addressed with appropriate urgency
based on severity.

---

## Architecture Security Model

- **Application-managed authentication** -- login uses HR_ID + bcrypt password
  (not Supabase Auth). Sessions are signed with HMAC-SHA256 and validated on
  every request against `app_auth_users`. Sessions are rejected on inactive
  user, role change, or session-version mismatch.
- **15 role-based access levels** with hierarchical scope enforcement
  (`self` / `team` / `hierarchy` / `line` / `company` / `system`).
- **Row-Level Security (RLS)** enforced on all Supabase tables for
  user-scoped reads via the anon-key client.
- **Server-side permission enforcement** via `assertPermission()` on every
  API route handler before any data access or mutation.
- **Admin client** (service role, bypasses RLS) restricted to tightly bounded
  server-only tasks and never exposed to client code.
- **Dev-auth system** gated behind `NODE_ENV=development` and localhost only;
  completely disabled in production builds.
- **Security headers** configured in `next.config.ts`: Content-Security-Policy,
  Strict-Transport-Security (HSTS), X-Frame-Options DENY,
  Cross-Origin-Resource-Policy, and related hardening headers.

---

## Data Sensitivity Classification

| Classification | Examples |
| -------------- | -------- |
| **Critical** | Payroll records, salary details, bank account information, authentication credentials, session tokens |
| **High** | Employee PII (national ID, contact details), resignation records, probation records, performance reviews, coaching notes |
| **Medium** | Attendance logs, expense claims, leave balances, offer letters, contract details, outstation requests |
| **Standard** | Notifications, system configuration, navigation settings, workflow definitions |

All data at Critical and High classification levels requires server-side
permission checks and RLS enforcement. No client-side-only access control is
acceptable for these categories.

---

## Access Control

The permission matrix is defined in `src/lib/auth/permissions.ts`, which
specifies the `defaultPermissionMatrix` mapping each of the 15 `PhoenixRole`
values to allowed actions on each `PermissionResource`.

Key principles:

- **Sidebar visibility is UX only, not a security boundary.** Navigation
  links are hidden based on role for usability, but this is never relied upon
  for access control.
- **Server-side checks are mandatory.** Every API route must call
  `resolveAccessContext(request)` and `assertPermission(ctx, resource, action)`
  before performing any operation.
- **Scope-aware filtering** ensures that users only see data within their
  authorized scope (`self`, `team`, `hierarchy`, `line`, `company`, or
  `system`) via helpers such as `canAccessPayroll`, `canAccessSales`,
  `canSeeEmployee`, and `filterEmployeesForAccess`.
- **Runtime overrides** from the `role_permission_overrides` table allow
  operational adjustment of permissions without code changes; these are
  cached for approximately 30 seconds.

---

## Database Security

- **Row-Level Security (RLS)** policies are active on all Supabase tables.
  The anon-key client respects these policies for all user-scoped reads.
- **Service role access** (admin client) bypasses RLS and is restricted to
  server-side operations that require elevated privileges. Usage is
  audit-logged.
- **Migration changes** are applied through timestamped SQL files in
  `supabase/migrations/` and require staging validation before production
  deployment. Destructive migrations require explicit approval and
  rollback planning.
- **Database role alignment** and RLS validation scripts are available via
  `db:*` and `phaseNN:*` npm scripts, which serve as a migration safety
  harness.

---

## Environment Variables

- Secrets (Supabase service role key, session signing secret, API keys) must
  never be committed to the repository.
- All `.env` files are included in `.gitignore`.
- Reference `.env.example` for the list of required environment variables.
- Required server-side variables include: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and the
  session-signing secret.

---

## Dependencies

- `npm audit` is expected to report zero vulnerabilities at
  `--audit-level=low`.
- Known transitive vulnerabilities are addressed via `overrides` in
  `package.json` to pin safe versions.
- Dependency updates should be reviewed for security implications before
  merging.

---

## Deployment Security

- **Production deploys** are only permitted from the `main` branch after
  passing the full validation gate (`npm run check:harden`: lint, typecheck,
  tests, and build).
- **Preview environments** enforce a read-only guard via the
  `PHOENIX_PREVIEW_READ_ONLY` environment variable, preventing accidental
  mutations against production data from preview deployments.
- The production domain (`https://phoenix-hr.satopharma.com`) must be
  verified after every production deploy -- workspace aliases can diverge
  from the public alias.
- Only two active Vercel deployments are maintained: production (`main`) and
  the working preview branch.
