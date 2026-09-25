---
name: nav-personal-layout-is-per-caller-never-a-targeting-matrix
description: "The personal sidebar layout keys on the CALLER's own hr_id and can never introduce an href — both properties are pinned by a registered test, so don't \"improve\" either one away."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cf5aa32-4d8c-4a73-9b79-a284b8c51694
  modified: 2026-08-28T06:51:21.912Z
---

The free placement editor (branch `codex/nav-free-placement`, PR **#2516**, built 2026-08-28) lets the
owner drag any page into any module, or up into the utility strip, **in his own account only**. It
replaced Modules Control, which was the opposite shape — see
[[admin-shell-sidebar-per-user-curation]] for what was retired and why.

**Why:** two properties make this safe, and both are easy to destroy with a change that looks like an
improvement. Each is pinned by `tests/navigation-personal-layout.test.ts`, registered in
`tests/run-tests.ts`, so it runs in the required CI `validate` job.

**How to apply:**

1. **A layout REARRANGES the already-gated set — it can never introduce an href.**
   `applyPersonalLayout` runs strictly AFTER `getSections` has done role/permission filtering, and
   every item it emits comes from a `Map` built from that input. A layout naming
   `/admin/super-secret` yields nothing if the viewer wasn't already allowed it. **Do not** "fix" the
   layout to look pages up from `system-navigation.ts` directly — that single change converts a
   cosmetic preference into an access-control bypass. Navigation was never the security boundary
   (CLAUDE.md); this must not make it one.

2. **The hr_id always comes from `access.hrId`, never from the request.** No `?hrId=`, no body field,
   no header. The moment a caller can name someone else, a personal preference becomes a targeting
   matrix — exactly the thing the owner asked to retire *"with no traces ever"*. The test greps the
   route source (comments stripped first — the file's own header documents the rule, and an unstripped
   pin matches its own prose) and asserts all three store calls pass `access.hrId` literally.

3. **Guests are rejected on `access.source === "guest"`, not `!access.role`** — an unauthenticated
   caller resolves to role `Employee` here, so a `!access.role` guard is dead code.
   [[an-unauthenticated-caller-has-role-employee-not-null]]

4. **Unknown hrefs fall back, they are never dropped.** A stored layout is a snapshot of the nav on
   the day it was saved, and ~30 commits/day land here. Anything gated-in that the layout doesn't
   mention is appended to its origin section (recreating that section if the layout dropped it), so a
   new page is always reachable. Treating a saved layout as the complete list would make every new
   page silently invisible to the one account that most needs to see it — the same silent-degradation
   shape as [[outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line]].

5. **One generic core, deliberately.** `applyPersonalLayout` is generic over the item type so the live
   sidebar (real `NavigationSectionItem`s, icons and all) and the editor (plain `{href,label}`, because
   a React icon component can't cross from a server to a client component) share ONE reconciliation.
   Two copies would drift and the symptom would be an editor that lies about where a page lands.

6. **Scoped to `mode === "admin"`.** `AppShell` also renders the employee portal; one stored document
   applied to both navs would let a portal render overwrite the admin arrangement.

**State as of 2026-08-28 (later that morning), Cairo:** PR #2516 **merged** (squash `d16aadba`), so
the code is on `main` and shipped to production. The migration is applied to **BOTH** staging
(`cifwmndunmlxjhyjugxa`) and **production** (`ozucdzovmcqvepbozvqf`) — owner approved the production
run, and it was verified against `pg_class`: table present, RLS on, 1 policy, 3 CHECK constraints,
0 rows, grants to `service_role` only (`anon` and `authenticated` have none). **Saving a layout
works in production.**

Before that migration, production had the code but not the table, and it degraded correctly rather
than erroring — worth keeping in mind if the table is ever dropped or a new environment is stood up:
`loadPersonalLayout` treats a missing table exactly like a missing row and returns null without
throwing, so the standard sidebar renders and only a *save* fails.

**Proven on staging 2026-08-28, not merely asserted:** all three CHECK constraints reject bad rows;
GET/PUT/DELETE round-trip through the real route; the live sidebar obeyed a layout that moved
Outstation Expenses into a new module and lifted a page to the strip, and every page *not* named in
the layout stayed put; Reset restored the default. CSRF was proven with a control — same path, same
method, foreign `Origin` → **403**, own origin → **401**. (A blanket 403 would have proven nothing:
this app returns 403 for almost any unauthenticated `/api/**` call.)

**One unexplained event, unresolved:** a full 28-section default layout appeared in the staging table
~7 minutes after being deleted. Not reproduced — loading the editor writes nothing (tested twice),
the store has no write-on-read, and the browser network log showed no second PUT. Impact was nil (a
throwaway `dev-preview` key on staging). If a layout ever appears that nobody saved, start here.
