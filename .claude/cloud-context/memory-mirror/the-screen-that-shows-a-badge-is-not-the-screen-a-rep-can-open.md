---
name: the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open
description: "The portal Customer Database screen is Super Admin + SFE Manager ONLY, so deep-linking a rep notification there is a silent 403 — a rep's capture path is /employee-portals/marketing-requests/validation."
metadata: 
  node_type: memory
  type: project
  originSessionId: faedc714-ba73-4daa-a9e9-810ee2b0f383
  modified: 2026-08-23T21:02:59.301Z
---

**`/employee-portals/marketing-requests/customer-database` is NOT a rep page**, despite living under
`employee-portals/`. Its route calls `getMarketingCustomerDatabaseWorkspace(access)`, which calls
`assertMarketingCustomerDatabaseAccess` — **Super Admin and SFE Manager only**
(`src/lib/marketing-requests/service.ts`). A Medical Rep opening it gets a 403.

**The rep-reachable twin is `/employee-portals/marketing-requests/validation`** ("Customer
Validation"), gated by `assertEmployeePortalMarketingPageAccess("requests")` → `marketingCreatorRoles`,
which **does** contain `Medical Rep`. It renders the same `NotFieldValidatedBadge` and holds the
complete-an-existing-record path from #2352.

Both files render the badge — `git grep -l NotFieldValidatedBadge` returns
`marketing-customer-database.tsx` and `marketing-validation-workspace.tsx` — so "which screen shows
this?" is the wrong question. **Ask which screen the recipient's ROLE can open.**

Also worth knowing: the customer-database workspace is **not territorially scoped at all**. It loads
every active link (`limit(1000)`) and relies purely on the role gate — unlike most marketing reads,
which are area-scoped ([[marketing-customers-belong-to-areas-not-people]]).

**Why:** building the daily field-capture nudge (PR #2360), the obvious `actionUrl` was the screen
that draws the badge. That would have sent a notification to **51 medical reps every morning
pointing at a forbidden page** — worse than sending nothing, because it teaches people to ignore the
next one. Caught only by reading the gate before pushing, not by any test or type error; a wrong
`actionUrl` is a plain string and nothing in CI would have gone red.

**How to apply:** before setting `actionUrl` on any notification, open the destination's route file,
follow its `assert*Access` call, and confirm the union of roles you are notifying is inside it. Pin
it with an assertion — `tests/marketing-field-capture-backlog.test.ts` checks the URL is a portal
route, is not the customer-database screen, that `marketingCreatorRoles.has("Medical Rep")`, and that
the page file exists. Related: [[a-matrix-grant-is-only-gate-one-of-two]],
[[marketing-system-validated-means-no-human-looked]].
