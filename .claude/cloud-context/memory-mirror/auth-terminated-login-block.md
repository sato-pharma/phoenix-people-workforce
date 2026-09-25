---
name: auth-terminated-login-block
description: "Resigned/terminated employees are blocked at BOTH login and session; login gate added 2026-06-20 (PR #359) to close the is_active-drift gap."
metadata: 
  node_type: memory
  type: project
  originSessionId: ed35b8f5-5eb6-4d42-9da0-50c378aeda1e
---

LOCKED RULE: a resigned/terminated/inactive/not_renewed employee can NEVER sign in or hold a session. Enforced in TWO places, both using the single source of truth `isTerminalEmploymentStatus` (active set = {active, on_leave}) in `src/lib/auth/session-lifecycle.ts` (pure, unit-tested):

1. **Read-time session gate** (pre-existing, WP-3): `resolveEmployeeLifecycleGate` in `src/lib/auth/server.ts` rejects an ongoing session every request when the linked employee is terminal. FAILS CLOSED on lookup error.
2. **Login gate** (added 2026-06-20, PR #359 squash 2435394f, prod 200): `isLinkedEmployeeTerminal` in `src/lib/auth/credentials.ts` — `authenticateLoginId` denies sign-in (returns null → 401) for a terminal linked employee. FAILS OPEN on lookup error (availability; the session gate is the fail-closed backstop). Only a confirmed terminal status blocks; unlinked/missing employee stays allowed.

**Why the login gap existed:** resignation/termination RPCs (`phx_resign_employee_and_open_vacancy`) DO set `app_auth_users.is_active=false`, but a status set OUTSIDE the RPC (CSV import) left is_active stale=true, so login (which only checked is_active) passed. Drift. Session gate still blocked them post-login; the login gate now blocks the sign-in itself.

**One-time data cleanup applied to prod 2026-06-20:** deactivated 7 departed-but-active auth users (B-67/B-99/B-109/B-150/B-160/B-180 resigned, B-101 terminated) — set is_active=false + bumped session_version. Verified 0 terminal-but-active remain.

Test: source-assertions in `tests/auth-session.test.ts` for BOTH gates. Related: [[directory-active-filter-gate]], [[job-title-not-a-permission-source]].
