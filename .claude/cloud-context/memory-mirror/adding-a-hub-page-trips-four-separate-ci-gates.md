---
name: adding-a-hub-page-trips-four-separate-ci-gates
description: "One new Recruitment & Hiring hub page fails CI four times in a row — four unrelated invariants in four files, each only visible once the previous one is fixed. A FIFTH if the module sends email."
metadata: 
  node_type: memory
  type: project
  originSessionId: ad53de17-d4b2-4840-be09-4ee95dd4eaa5
  modified: 2026-08-26T20:46:02.641Z
---

Adding **one** page to `recruitmentHiringPageItems` cost three red CI cycles on 2026-08-22 (PR #2292).
Each gate hides the next, so they surface one at a time. Satisfy all four **in the same commit**:

1. **Portal twin** — Talent Acquisition is a portal-shell role and `app/(admin)/layout.tsx` redirects
   it out of the whole `(admin)` group, so an admin-only hub card is unreachable for the role it is
   for. Needs `app/employee-portals/<x>/page.tsx`, an `employeePortalNavigationSectionSeeds` entry, an
   `employee-portal-layout.tsx` entry, and `PORTAL_TWIN_BY_HUB_HREF` in
   `tests/recruitment-hub-portal-coverage.test.ts` — **which also pins the hub COUNT** (five when
   this was written, **seven** as of Job Offers on 2026-08-26). Move the number too.
2. **Sidebar label width** — `tests/fixtures/sidebar-label-widths.json` needs a *measured* entry
   (`pnpm run ui:measure-sidebar-labels`, playwright chromium). A label with no snapshot **fails**;
   it is not skipped. Budget 156px, 136px for a hub label. See [[portal-sidebar-label-width-budget]].
3. **Mobile bottom nav** — every portal sidebar href must be in `PORTAL_NAV_REGISTRY` **or** in
   `desktopOnlyPortalRoutes` with a written reason, in `tests/employee-portal-bottom-nav.test.ts`.
   All Talent-Acquisition tools are desktop-only — six when this was written, **seven** with Job
   Offers. See [[portal-nav-registry-one-way-sync-test]].
4. **Access registry** — every `app/api` route must be declared in `src/lib/security/access-registry.ts`.
   Declaring a mutation method then obliges `csrfRequired: true`, and *that* obliges the handler to
   call `assertSameOriginMutation(request)` — the test greps the source for it. Split GET from
   PUT/POST rather than using one `allMethods` blanket, or the registry states `read` for a route
   that writes. See [[access-registry-is-declarative-and-writes-no-audit-row]].
5. **The email allowlist — a FIFTH gate, only if the module sends mail.** Added 2026-08-26 by the
   Job Offers module (PR #2432). `tests/email-notifications.test.ts` walks `app/` + `src/` for any
   file containing `sendPhoenixEmail(` and `deepEqual`s the sorted list against a hard-coded array.
   A new sender is a FAILURE, not an addition — put the path in, in sort order, with a comment
   saying why it bypasses the DB template engine (every existing entry has one). Nothing about the
   page you added hints this exists.

**Not a gate, but found the same way:** a brand-new API surface can be *fully* absent from the
access registry and nothing outside that one test notices. Seventeen `/api/offers` routes shipped
undeclared. Register method by method, never one `**` blanket — a blanket states `read` for the
route that emails a binding salary offer.

**Why this is worth a memory:** none of the four is discoverable from the page you are adding, and
each red run is ~16 Actions minutes on an account that has hit the spending cap before.

**How to apply:** after adding a hub page, run the suite locally the way CI does before pushing —
`node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader
./tests/alias-loader.mjs tests/run-tests.ts`, **without** `--env-file-if-exists=.env.local` (that
file points at production; CI has none, and the suite needs none). **~41s, 922 tests** as of
2026-08-26 (846 and ~90s when this was written), and it catches gates 1, 3, 4 and 5. This is not
the banned pre-push validation ritual — it is running the one job that is already red.

**The runner rethrows on the first failure, so the suite reports ONE gate per run.** Do not
serialise a five-run loop through it: probe the likely registry guards directly first — import each
suspect `tests/*.test.ts` and call its exported fn in one node process — then run the whole suite
once to confirm. Gate 2 is invisible to all of this (the fixture needs headless chromium), so
measure the label first, before the suite run.

**A green suite still carries no type signal** — `--experimental-strip-types` strips types and
never checks them, so a prop you forgot to thread, a `Badge variant` that does not exist, or a test
helper taking an env object all pass locally and fail `typecheck` on the PR. Three of the six CI
rounds this module cost were that. See [[a-green-test-run-carries-no-type-signal-at-all]] and
[[a-test-can-never-hand-a-function-a-process-env-literal]].
