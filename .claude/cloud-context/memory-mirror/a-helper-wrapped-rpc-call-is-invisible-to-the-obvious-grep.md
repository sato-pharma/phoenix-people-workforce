---
name: a-helper-wrapped-rpc-call-is-invisible-to-the-obvious-grep
description: "a grep for `rpc(\"current_…\")` returned nothing and read as proof of no caller — the five calls go through a local rpcValue(client, name) helper, and revoking the grant would have reddened the real-auth smokes"
metadata:
  node_type: memory
  type: project
  originSessionId: 0a3a0a02-b55f-42bb-8f6f-7c578d5fd602
  modified: 2026-10-13T03:05:45.759Z
---

The Supabase advisor raises `authenticated_security_definer_function_executable` eleven times on
`public.current_access_*` / `current_phoenix_role`. Five are load-bearing in live RLS (91 policies,
all `to authenticated`). The other six read as spare: a `pg_policy` scan finds **0** policies naming
them, and a grep for `rpc('current_access_…')` across `scripts/` finds **0** callers. Both readings
are true and the conclusion drawn from them is wrong — `scripts/phase24-real-auth-rls-api-smoke.ts`
calls **five of the six by RPC as a signed-in `authenticated` user**, through its own
`async function rpcValue<T>(client, name)`, so the function name never appears next to `rpc(`. The
sixth, `current_access_can_see_employee`, is reached through policies `phase25-*`/`phase26-*` create
`to authenticated` at smoke time, which is also why `pg_policy` reads 0 for it.

**Why:** the drafted migration was written twice (2026-10-08, 2026-10-13) off those two zero
readings. It would have closed nothing — all eleven are already `search_path=public` pinned and
`anon` has EXECUTE on none — and reddened the real-auth smokes.

**How to apply:** a zero from a grep for a *call shape* is evidence about the shape, not about
callers. Search for the bare identifier across the whole tree before concluding nothing calls it,
and when the call is dynamic (`rpc(name)`, `from(table)`, a dispatch table), find the wrapper and
grep its argument lists instead. `tests/access-helper-execute-grant-lock.test.ts` now refuses the
migration and pins the phase24 `rpcValue` calls as the evidence, so the next session reads the
triage instead of re-deriving it. Related: [[verify-the-emitted-artifact-never-the-source]].
