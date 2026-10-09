---
name: a-supabase-query-builder-then-returns-a-promiselike-with-no-catch
description: "`.then(...).catch(...)` on a Supabase query or rpc builder is TS2339 — PromiseLike has no catch — and `.then(ok, onError)` cannot see the error the ok handler throws for `result.error`"
metadata:
  node_type: memory
  type: project
  originSessionId: abf9f7ad-6d41-471f-84f7-43a58d29f3a1
  modified: 2026-10-09T20:13:03.622Z
---

`supabase.from(...).select(...).then(...)` and `supabase.rpc(...).then(...)` return a
**`PromiseLike`**, not a `Promise`. Hanging a `.catch()` on one fails the typecheck with
`error TS2339: Property 'catch' does not exist on type 'PromiseLike<…>'`, plus a `TS7006` for the
implicitly-`any` error parameter — and a local typecheck is denied here (`bash-guard.mjs` C8), so the
PR's `checks` job is the first thing that tells you (red in ~80s, PR 5709, 2026-10-09).

The tempting fix is the two-argument `.then(ok, onError)`. **It is wrong:** `onError` does not see an
error thrown by `ok`, and `if (result.error) throw result.error` lives inside `ok` — which is every
database failure there is. It would catch nothing while looking like it caught everything.

**Why:** the pattern appears wherever several optional readings run in one `Promise.all` and each
must fail softly (one unreadable panel costs that panel, not the page).

**How to apply:** give each reading its own `async` function with a real `try`/`catch` around
`await`, logging through `logError(message, { labels: { event }, error })` and returning an empty
fallback — see the three `read*` helpers in `src/lib/sales/mapping-guard-detail.ts`. Never
`Promise.resolve(builder.then(...))` as a workaround; the named function is what makes the fallback
readable. Related: [[dropping-a-function-drops-its-acl-and-the-new-one-is-public]].
