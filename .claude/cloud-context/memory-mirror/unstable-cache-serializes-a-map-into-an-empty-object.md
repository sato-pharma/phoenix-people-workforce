---
name: unstable-cache-serializes-a-map-into-an-empty-object
description: "unstable_cache serializes what it stores, so a returned Map comes back {} — the page works on the render that fills the cache and throws on every one after"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c1fd41c-abde-42fb-9f8c-c8f3f3b8c67c
  modified: 2026-08-28T02:57:41.438Z
---

`unstable_cache` **serializes** its value. A `Map` (or `Set`, or `Date`, or any class instance) does
not survive that trip — it comes back as `{}`. So a loader that returns a Map works on **exactly
one** render, the one that fills the cache, and then throws on every render after it, for the whole
revalidate window, forever.

Measured 2026-08-28 on `/admin/reps-plans` (PR #2494). `loadOrgPlacementTree` was
`unstable_cache(async () => buildOrgPlacementTree(nodes), …, { revalidate: 300 })`, and
`buildOrgPlacementTree` returns `{ index: Map, … }`. First load: the full board, 775 KB. Second load
and every load after: `TypeError: index.get is not a function` at `placementOf`, rendered as the
admin error boundary — a 313 KB page that looks like a **permission redirect**, not a crash, which
is how the first 30 minutes of diagnosis went into dev-auth.

**Cache the ROWS, build the object graph per call.** Plain strings, numbers, arrays and object
literals round-trip intact; anything with methods does not. Rebuilding is cheap — 133 rows, one pass
— next to the database read it replaces.

**No unit test can see this.** Every test calls the pure builder directly, where a Map is still a
Map. It is only reachable by loading the page **twice**. Pin it two ways instead: assert that a
JSON round-trip of the built value loses `.get` (states the fact), and source-pin the data module so
the exported loader is a plain `async function` and not `unstable_cache(...)` (holds it to the rule).

**One load is not a verification.** The reload is the test — see
[[next-2mb-data-cache-throws-only-in-dev-and-kills-the-server]] for the other Data Cache trap in this
repo, and [[the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open]] for the general habit of
checking the thing rather than the code that should produce it.
