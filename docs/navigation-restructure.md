# Navigation restructure — the owner's eleven rulings

**Status: built.** The rulings are implemented in `src/config/system-navigation.ts` — see "What
was built" at the foot of this file. The one conflict between a ruling and a later owner decision
was **put to the owner on 2026-08-30 and answered**; it was not resolved by guessing, and his
answer reversed two of his own earlier decisions. The Super Admin's rail went from **59 visual
rows to 47**.

This file exists because the last model didn't. An earlier session modelled this restructure in
full — "21 modules over 234 pages" — and never wrote it down, so it died with that session's
context. Rebuilding it from the transcript recovered the rulings but not the analysis, and the
analysis turned out to be the half that mattered: the first version of this document, written
earlier today, was **substantially wrong**, and the corrections are recorded below rather than
quietly overwritten.

Everything here was read from the config at `eccf0920`, not from memory.

## The eleven rulings, verbatim

Recovered from the owner's own message. These are decisions, not suggestions.

| # | Ruling |
|---|---|
| 1 | Sales = 5 blocks; **Monthly Closing alone**, **Targets alone** |
| 2 | Direct Orders separate from Sales; Direct Order Exceptions is **not** an approval |
| 3 | Marketing Requests its own module, Marketing ROI folded in |
| 4 | Payroll and Expenses **totally** separate |
| 5 | Weekly/Monthly Plans **not** under Attendance & Leave |
| 6 | Field Force splits: field **visits** vs field **coaching**; Early Birds with Field Force |
| 7 | Workforce Compliance and Double Visit **not** training-manager-only |
| 8 | Attendance separate from Leave |
| 9 | **New HR module** — employees, organogram, resignations, contracts |
| 10 | Layer 1 = **Approvals + Organogram only** |
| 11 | **No analytics module, no sales analytics** (said three times) |

## The architecture is two layers, not one

This is the correction that reframes the whole phase. `system-navigation.ts` (3,033 lines, 299
`href` entries) holds **two** navigation structures, and the first pass at this document described
only the first one:

**Layer 1 — the sidebar rail.** Three seed arrays:

| array | lines | sections | items |
|---|---|---|---|
| `adminNavigationSectionSeeds` | 210–1059 | 35 | 60 |
| `employeePortalNavigationSectionSeeds` | 1061–1360 | 9 | 60 |
| `hrNavigationSectionSeeds` | 1390–1481 | 8 | 29 |

**Layer 2 — the hub pages.** Twenty `*PageItems` arrays (lines 1511–3004) holding **145 cards**.
A rail entry such as `/admin/crm` opens a hub whose cards come from `crmPageItems`. So the rail is
not the navigation — it is the index to it.

**294 destinations in total: 126 rail-only, 125 hub-only, 19 in both.**

Ruling 10 says "**Layer 1** = Approvals + Organogram only". That word is literal, and it maps onto
this architecture exactly. And the lost model's "234 pages" was counting destinations across both
layers, not 234 sidebar entries — which is why it never matched anything visible in the rail.

## Findability, measured

230 admin page routes are nav-eligible (excluding `/login`, `/privacy`, `/terms`, `/dev/**`,
`/auth/**` and the root, which are correctly absent from any sidebar):

| | count |
|---|---|
| in the sidebar rail | 58 |
| not in the rail, but linked from a hub card or an in-page link | 116 |
| **no static link found anywhere in the codebase** | **56** |

**56 is an upper bound, not a count of abandoned pages.** Three things inflate it, and each was
checked rather than assumed:

- **63 files build hrefs as template literals** (`href={\`/admin/${slug}\`}`), which a literal scan
  cannot see.
- **The 8 `/admin/direct-orders/*` desks are provably false positives** — `direct-orders-workspace.tsx`
  builds them from suffix fragments (`"/held"`, `"/pharmacies"`, …) concatenated onto a base path,
  so the full route never appears as a literal.
- **At least one is work in progress right now** — `/admin/mailbox-monitor` is being built by a
  parallel session on `codex/mailbox-compliance-monitor`. Unlinked means "not wired up yet" there,
  not "rotting".

The honest statement is: **56 admin pages have no link this analysis can find, and the true number
of genuinely unreachable pages is somewhere below that.** Each needs a per-page answer, not a sweep.

## Ruling 9 is already built — by someone else

`hrNavigationSectionSeeds` exists and contains precisely what ruling 9 names: `/hr/employee-360`,
`/hr/organogram`, `/hr/contracts`, `/hr/resignations`, across 8 sections and 29 items. It arrived
in PR #2554 from a parallel session's `codex/hr-phase3-boundaries` work.

**So ruling 9 is not this phase's work, and building it here would manufacture a conflict** — the
documented failure mode when two sessions patch the same thing in parallel.

It is currently **inert**, and that is not a defect:

- No `/hr/*` page exists on disk (0 files), and no rewrite or middleware serves those paths.
- `resolveNavigationMode` (`src/lib/auth/permissions.ts:1281`) returns only `"employee-portal"` or
  `"admin"` — **never `"hr"`**, so `getNavigationSections("hr")` is unreachable at runtime.

It is a staged scaffold waiting on its pages. Reporting it as "29 dead links in production" would
have been wrong, which is why the runtime path was traced before writing this down.

## Ruling 11, sized

The only ruling that is fully unambiguous and fully in scope here. What currently carries the word:

- **1 hub array**: `salesAnalyticsPageItems` (9 cards)
- **15 destinations** whose href contains `analytics`
- **9 distinct labels a user actually reads**: Sales Analytics, SoS Analytics, Closing Analytics,
  Weekly Analytics, Attendance Analytics, Coaching Analytics, Probation Analytics, Double Visit
  Analytics, Double-Visit Analytics

Note the last two differ only by a hyphen — the same concept spelled two ways, which is itself the
drift this whole project exists to fix.

⚠️ **Scope question the ruling text does not settle.** "No analytics module, no sales analytics"
plainly kills the *module* and the *Sales Analytics* block. Whether it also renames
"Attendance Analytics" and "Probation Analytics" — which are tabs inside other modules, not
modules — is a wider reading. The lost model reportedly eliminated the word from every label, but
that is a recollection of a deleted artifact, not the ruling.

## Remaining defects visible independent of the rulings

- **`/organogram` appears twice** — `command-center` and `people-management`.
- **`/admin/weekly-plans/calendar` appears twice** — `ceo-company-calendar` and
  `finance-events-calendar`, same href, two sections, both labelled "Company Calendar".
- **Leave Management exists twice** — `finance-leave-management` and `leave-management`, different
  pages, identical section label.
- **Probation is scattered across five entries** in `people-management`, plus a sixth in
  `ceo-probation`.
- **`/admin/crm` and `/admin/crm-tools` both render as "CRM"** in the same section.

## Four calls the rulings do not settle

Flagged rather than buried. Each changes what someone sees.

1. **Territory Management.** Ruling 1 says Sales is five blocks and names two of them
   (Monthly Closing, Targets). Source of Sales, Weekly and Sales vs Target fill the other three,
   which leaves Territory Management without a slot. Folding it into Source of Sales is the
   proposal — it *is* the SoS geography, and all SoS sales attribute to today's geography — but
   that is a judgement, not a ruling.
2. **Organogram's home.** Ruling 10 puts it in Layer 1; ruling 9 lists it inside HR — and the HR
   module now exists with `/hr/organogram` in it. So it would sit in both, which is how the current
   duplicate arose in the first place.
3. **How far ruling 11 reaches** — the scope question above.
4. **Role gates for anything that splits.** Splitting one section into two means deciding the gate
   for each half. Ruling 7 explicitly widens Workforce Compliance and Double Visit beyond Training
   Manager; the rest would inherit their parent's gate by default.

## Safety

Navigation is **UX only** — `system-navigation.ts` hiding a link is not a security boundary, and
every page re-checks server-side with `assertPermission`. An error here makes a page hard to
*find*, not reachable by the wrong person.

Verification available without a browser: 30 nav-related test files, 23 registered in
`tests/run-tests.ts` — including `sfe-manager-nav-dead-links`,
`organogram-nav-link-exists-for-every-role-that-can-open-it`, `sidebar-label-width` (which enforces
the owner's no-truncation, no-wrap rule against a measured pixel budget),
`sidebar-role-scoped-headings`, `navigation-active-path` and `phase22-role-matrix-security`.

Note what those tests check: rail → route (a link with no page). Nothing currently checks
route → rail (a page with no link), which is why 56 pages could drift out of reach unnoticed. A
restructure of this size should add both that check and a test pinning the eleven rulings — no
module label matching `/analytic/`, Payroll and Expenses as separate sections, Monthly Closing and
Targets each alone — so the structure cannot drift back without a red PR.

## What was built (2026-08-30)

### Built

| Ruling | Change |
|---|---|
| 10 | **Organogram is its own top-level section.** It had two rail entries — one in Command Center gated `roles: ["CEO"]`, one in People Management gated `excludedRoles: ["Marketing Manager", "CEO"]`. The gates were mutually exclusive, so no ordinary role saw both; for the Super Admin, whose sidebar bypasses `roles`, `dedupeSectionsByHref` was the only thing hiding the second copy. The merged gate is the exact union of the two. |
| 10 | The section formerly labelled "Approvals Hub" is now **"Approvals"**, the owner's own word. Its four rows deliberately do *not* collapse — see below. |
| 6 | **Early Birds reaches the admin rail**, beside Field Coaching. It had never rendered for anybody: see the finding below. |
| 1 | **Monthly Closing stands alone for the Super Admin**, at `/sales/monthly-closing`. It was one of Sales' five blocks folded inside another of the five (a card in the Source of Sales hub) for every role except the Finance Manager. |
| — | **The two "Company Calendar" sections are one.** Both pointed at `/admin/weekly-plans/calendar` under the same label, kept apart only by role. The seer set is unchanged. |
| — | **PM Product Master left the Employee 360 block** for a section of its own. It is a product-master page that was reading as a per-employee-profile tool because it shared that heading; its row and gate are untouched, only the heading it sits under changed. |
| 10 | **CRM, Probation and Marketing collapsed onto their hub rows** — 9 rows to 1, 5 to 1, and 5 to 3. This reverses the owner’s 2026-08-08 and 2026-08-29 decisions, and was done only because he was asked and chose it. See “Answered” below for the question, his answer, and why Marketing did not reach 1. |

### What it actually cost, measured

Resolved through `getSections` for **every role that reaches the admin shell**, at three points: the
commit before this branch, after the structural work, and after the collapse. Read each cell as
sections / items / **visual rows** — a single-item section renders *headerless*, so it is one row,
not a heading plus a row. The visual row count is the honest one.

| Role | before | after the structural work | after the collapse |
|---|---|---|---|
| Super Admin | 26 / 51 / **59** | 30 / 53 / **60** | 30 / 41 / **47** |
| CEO | 21 / 30 / **34** | 24 / 31 / **34** | 24 / 30 / **33** |
| SFE Manager | 17 / 23 / **27** | 19 / 24 / **27** | 19 / 23 / **26** |
| Financial Advisor | 10 / 15 / **18** | 10 / 15 / **18** | 10 / 14 / **17** |
| HR Operations | 11 / 14 / **16** | 11 / 14 / **16** | 11 / 14 / **16** |
| HR Advisory | 10 / 13 / **15** | 11 / 13 / **15** | 11 / 13 / **15** |
| Finance Manager | 13 / 14 / **15** | 13 / 14 / **15** | 13 / 14 / **15** |

**Two corrections to the first version of this table, both mine.** It listed six roles with larger
numbers, and it was wrong twice over:

- It was measured with a permission lookup that set only the *granted* pairs, leaving the rest
  `undefined`. `undefined` is not `false` to a gate that tests for a missing key, so rows appeared that no
  real session shows. Every figure above is built with the lookup the registered navigation tests
  use — **every** `resource:action` pair set explicitly to true or false.
- It listed **HR Specialist**, **National Sales Manager** and **Marketing Manager**. The first is
  not a role at all any more (HR seats are composed from function bundles; retired seats alias to
  `Employee`), and the other two are **portal** roles — `resolveNavigationMode` sends them to the
  employee portal, so they never see this rail. Measuring them against `adminNavigationSections`
  measured a shell they never open. Seven roles reach the admin shell; those seven are the table.

**The structural work did not shrink the rail — the collapse did.** Nobody lost a route in either
half. Across the whole branch, per role:

| Role | gained | lost |
|---|---|---|
| Super Admin | CRM hub, Probation hub, Early Birds, Monthly Closing | the 12 rows those two hubs carry, plus All Marketing Requests and ROI Tracker — every one a card on a hub he can open |
| CEO | Early Birds | ROI Tracker (a card on the ROI hub he can open) |
| SFE Manager | Early Birds | All Marketing Requests (a card on the ROI hub he can open) |
| Financial Advisor | — | ROI Tracker (a card on the ROI hub he can open) |
| HR Operations, HR Advisory | the Probation hub | `/probation`, which is a card on it |
| Finance Manager | — | — |

The duplicates that went were in the **config**, not on anyone's screen: two duplicated hrefs
(`/organogram`, `/admin/weekly-plans/calendar`) and two duplicated section labels, now zero and one
(Leave Management, two different pages for two disjoint audiences, correct as it stands).
`dedupeSectionsByHref` had been suppressing both at render time, which is why nothing looked wrong
— the duplication was load-bearing rather than visible, and that is the worse of the two states to
leave a config in.

### The finding: Early Birds had no door

`/admin/early-birds` shipped on 2026-08-09 (#1918). Its rail section names Super Admin, CEO and
SFE Manager — three admin-shell roles — and was appended to `employeePortalNavigationSectionSeeds`
instead of `adminNavigationSectionSeeds`. It is the **only** `/admin/*` href in that portal array,
which is the signature of a slip rather than a decision, and `resolveNavigationMode` pins all three
of those roles to `"admin"`, so the entry has never rendered in either shell.

No guard fired, and correctly so: the page *is* reachable, from a card in
`src/components/admin/ceo-phase-b.tsx:862` — a component rendered by **both** `/admin/ceo-command-center`
and `/admin/sfe-command-center`, so each of the three roles could get to it. The findability backlog
was right to record it as `linked-from-a-component` rather than as stranded.

What makes that a thin door rather than a real one is the **condition** on it. The card renders
inside `{earlyBirdStars.length > 0 ? … : null}`, so **a fortnight with no stars to show removes the
module's only route, for everybody**, with nothing anywhere saying so. A rail row does not blink
out when the data behind it is empty.

The stray portal-array copy is left in place: the owner's standing instruction for this audit is not
to touch the employee portal, and the dead entry costs nothing (`dedupeSectionsByHref` runs per
mode, so the two copies never meet). It is worth removing in a change that is allowed to.

It is not the only one. Sweeping the portal rail the same way finds **five rows that render for no
role in that shell**. They are reported here and deliberately left alone:

| Row | Why it renders for nobody |
|---|---|
| `/admin/early-birds` | an admin href in the portal array — the slip above |
| `/employee-portals/marketing-requests/control` | names only Super Admin and SFE Manager, both admin-shell roles |
| `/employee-portals/marketing-requests/customer-database` | same |
| `/employee-portals/sales-analytics` | same shape |
| `/leave-management/vacation-control` | same shape |

The middle two deserve a look by someone allowed to touch that file: they are real pages, gated to
two roles, filed on a rail neither of those roles ever sees.

### Answered: ruling 10 versus the 2026-08-08 decision sheet (2026-08-30)

Ruling 10 — "Layer 1 = Approvals + Organogram only" — reads naturally as *one row per module*.
Implementing it that way means collapsing the expanded module rows back into their hubs, **which is
precisely what the owner reverted on 2026-08-08 and reaffirmed on 2026-08-29.** That is a conflict
between two of his own instructions, so it was put to him rather than decided here:

> The rulings ask for one row per module. Your 2026-08-08 and 2026-08-29 decisions ask for the
> Super Admin's modules to be expanded into rows instead. Which wins?

He was shown that collapsing reverses both of those decisions, and chose to **collapse**. So:

| Module | before | after | where the pages went |
|---|---|---|---|
| CRM | 9 Super Admin rows, and he was excluded from the hub by name | 1 row — the hub | all 8 collapsed hrefs are cards in `crmPageItems` |
| Probation | 4 expanded rows plus the SFE Manager's hub | 1 row — the same hub, widened | all 4 are cards in `probationPageItems` |
| Marketing | 5 rows | 3 | 2 became cards in `marketingRoiPageItems` |

**Nothing was stranded, and that was checked rather than assumed.** Every href that lost a row is a
card on a hub whose page guard admits the roles that lost it, and every one of those roles has that
hub's row on their rail. The two pinning tests were re-pinned to the new arrangement and then
**broken deliberately to confirm they fire**: re-adding one collapsed CRM row, and restoring the
Super Admin exclusion on the probation hub, each produced the expected named failure.

#### Why Marketing came out at 3 rows and not 1

The other two collapse cleanly. Marketing does not, for three separate reasons, each of which is
consistent with the ruling rather than a defiance of it:

- **`/admin/marketing-requests/inbox` stays.** It carries a live pending badge
  (`navBadge: "marketing-approvals-pending"`), and a hub card cannot carry one — folding it in
  hides the count that is the entire point of an inbox. Ruling 10 also keeps approvals on layer 1.
- **`/workspace/marketing-requests` stays.** The owner instructed it be re-opened on the rail on
  the morning of 2026-08-30, hours before this collapse.
- **`/admin/marketing-roi` is the hub itself.**

#### The row that turned out to serve nobody

The first attempt at this collapse kept the ROI Tracker row alive "for the three roles that cannot
open the ROI hub" — Marketing Manager, Product Manager, Group Product Manager. That reasoning was
wrong, and measuring rather than reading the config is what caught it: **all three are portal
roles.** `resolveNavigationMode` sends them to the employee portal, so `adminNavigationSections` is
not their rail and naming them in it never did anything, before or after. The row rendered for
**nobody**. Their real route is the portal's own `/employee-portals/roi` and
`/employee-portals/roi-tracker`, deliberately separate URLs rather than a shared page with the
admin one (owner rule, 2026-07-28).

The row is deleted. Generalised, this is the part worth keeping: **a `roles` list in these arrays is
not a statement about what a person can see.** It is filtered by shell first, so a portal role
written into an admin section is dead weight that reads exactly like a working grant.

A sweep for the same defect elsewhere now reports **0 of 51 admin rail rows rendering for no role**.
The portal rail has **5 of 56**, listed under the previous heading; they are not touched here.

### Also deliberately not done

- **The four Approvals rows do not collapse into `/admin/approvals-hub`.** That page is the
  "Other Approvals" inbox and it actively bounces `?module=leave|excuse|weekly_plan` deep links
  back out to the three dedicated pages (`MIGRATED_DEEPLINK_BASES`). One row there would point at a
  page that refuses three quarters of the work it claimed to hold.
- **Ruling 5 needs nothing.** "Weekly/Monthly Plans not under Attendance & Leave" — it is a card on
  the People Management hub, which is neither.
- **Ruling 7 needs nothing.** Workforce Compliance and Double Visit Analytics are both gated by
  permission with no `roles` list on their hub cards, so neither is training-manager-only.
- **Ruling 9 is another session's work** (`hrNavigationSectionSeeds`, PR #2554), still inert
  because `resolveNavigationMode` never returns `"hr"`.
- **The "My Requests" rows** (Request Vacation, Submit Excuse) are personal self-service, not a
  module. They belong in the account menu, which is the next phase's subject.

### On the ruling-1 test

`tests/navigation-ruling-11-analytics.test.ts` asserted that Monthly Closing's section held exactly
one item in the raw seed array. Ruling 1's "alone" is a property of what a *person* sees, so that
assertion now resolves the section through `getSections` for every role and requires one row each.
It is strictly stronger where it matters — it would catch a role genuinely shown two Monthly Closing
rows even if the entries lived in two different sections, which the old form could not — and it was
verified by breaking the config and confirming the new message fires naming the role and both hrefs.

## Phase 4 — "tidy my account" (2026-08-30)

### The finding: an admin-shell user had fifteen personal pages and two doors

`/workspace/*` is where an admin-shell role does their *own* employee business — payslips, leave,
excuses, fingerprint, probation, expenses. It exists because these roles have **no employee
portal**: for them this is the only self-service there is.

Resolved through each page's real guard, an admin-shell user has **15** working personal pages.
Before this phase, **2** of them were reachable from anywhere in the UI — the two "My Requests"
rail rows. The other thirteen were reachable only by typing the URL. `WorkspaceFrame`, which every
one of them renders, carried a title and a description and **no navigation at all**, so even a user
who reached one page by link found no way to the other fourteen. Each page was an island.

Two of the thirteen — Payslips and Deductions — were already recorded in
`tests/navigation-reachability-backlog.ts` on 2026-08-28, excused as "reached via the workspace
shell's `basePath` prop". That excuse was too generous: the prop sets a base path, it does not draw
a link. There was no door. Both entries are now cleared, because both hrefs are literals in
`personal-workspace-nav.ts` and the ratchet test finds them.

### What was built

- **`src/lib/workspace/personal-workspace-nav.ts`** — one array, fifteen entries, each carrying the
  resource/action/roles its page's own guard checks, plus three resolvers
  (`resolvePersonalWorkspaceTabs`, `personalWorkspaceEntryHref`, `activePersonalWorkspaceTab`).
  There is no icon in this module on purpose: it stays cheap to import and nothing in it crosses the
  server/client boundary.
- **A tab strip on every personal page** (`personal-workspace-tabs.tsx`), rendered by
  `WorkspaceFrame` when it is given the caller's `access`. Same border, same square control, same
  uppercase weight as the Direct Orders strip — three tab strips that look like three different
  products is how a system starts to feel like several systems. Groups (me / pay / time / work /
  expenses / help) are separated by a hairline rather than by headers, so the strip stays one row.
- **"My Workspace" in the account menu**, pointing at the first tab the viewer can actually open.
  A role with no personal pages is offered no entry — see the CEO below.
- **`/admin/profile` is four tabs, not five stacked cards** — Profile, Password, Devices,
  Notifications. `?tab=` on server-rendered `<Link>`s, so Back works, a tab is shareable, and no
  JavaScript chooses one. Profile carries no query string, so the page's existing URL stays
  canonical.

### The rail, and the tabs, measured

Rail figures are visual rows resolved through `getSections`, continuing the phase-3 table. Tabs are
resolved through `resolvePersonalWorkspaceTabs` against the same strict lookup.

| Role | rail after phase 3 | rail after phase 4 | personal tabs |
|---|---|---|---|
| Super Admin | 47 | **44** | 15 |
| CEO | 33 | **33** | **0** |
| SFE Manager | 26 | **23** | 15 |
| Finance Manager | 15 | **15** | 12 |
| HR Advisory | 15 | **12** | 13 |
| HR Operations | 16 | **13** | 11 |
| Financial Advisor | 17 | **14** | 10 |

Three rows leave the rail for the five roles that had them: the two "My Requests" rows and the
section heading above them. The Finance Manager is unchanged because he never had those rows — his
two pages were folded into his own Leave Management button on 2026-08-10, which still stands. The
CEO is unchanged because he has no personal workspace at all.

**Nobody lost a route.** Every role that saw the two rows resolves both hrefs as tabs.

### The CEO resolves zero tabs, and that is correct

He is not in `adminShellEmployeeRoles` and never has been, so
`requireAdminShellEmployeeWorkspaceAccess` redirects him from all fifteen pages. He therefore gets
**no** "My Workspace" entry rather than one that throws him out. That refusal is by `redirect()`
with no message, which is why offering an entry to someone the page bounces reads to a user as the
app ejecting them for no reason — the exact defect that shipped on 2026-08-10 with the Finance
Manager's Request Vacation row.

### One row I removed and put back

The first pass also deleted the Finance Manager's `finance-fingerprint-report` rail row, on the
reasoning that personal pages belong in the workspace. That was wrong, and a registered test said
so by name: `tests/navigation-active-path.test.ts` pins it under *"the sidebar trim must not remove
a duty the Finance Manager actually holds"*, and its comment records it as one of the six modules
the owner asked for by name on 2026-08-10. It is restored, with a comment recording the mistake.

A second door to a page is not a defect. Removing a row the owner asked for, because a general rule
said it belonged elsewhere, is.

### Two test pins moved with the change

- `tests/navigation-active-path.test.ts` — the Request Vacation gate/guard assertion now reads
  `resolvePersonalWorkspaceTabs` instead of the rail. The 2026-08-10 incident comment is intact; the
  surface making the promise moved, the promise did not. It also **covers the Finance Manager now**,
  the very role that incident was about — he was exempt from the rail version because his row had
  been folded into Leave Management, and the tab strip is offered to every admin-shell role alike.
  Verified by breaking the tab three ways in fresh processes (narrowed to one role, href typo,
  deleted) and confirming the assertion's own message fires each time.
- `tests/sidebar-role-scoped-headings.test.ts` — `["my-requests", "My Requests"]` left the pinned
  list, because that section no longer exists. That list catches a heading being **re-blanked**;
  keeping the entry would have asserted a heading on nothing.

### The new test, and what it holds

`tests/personal-workspace-nav.test.ts` (registered in `tests/run-tests.ts`) parses
`admin-shell-employee-pages.tsx` and the `app/(admin)/workspace` route files rather than trusting a
second hand-written list. Nine groups: every tab is a real route; **the set of pages that render the
strip is exactly the set of pages that are tabs**; every tab's resource/action/roles matches its
page's guard verbatim; no tab renders for nobody; the CEO resolves zero and is offered no entry; a
signed-in Super Admin reaches all fifteen through the matrix, and the `scope === "system"` bypass
beside it still mirrors `canAccess` (probed with an *empty* lookup, the only thing that can see it);
every other admin-shell role gets a door that opens; the active-tab matcher (root exact, longest
wins); labels short enough not to wrap; groups contiguous.

### A scope assumption that was wrong, caught before it shipped

The first version of that test — and the resolver's own comment — said the Super Admin is
system-scoped, and that the `scope === "system"` line in `resolvePersonalWorkspaceTabs` is what lets
him see every tab. **Neither is true.** `scopeForRole` returns `"system"` for nobody; a signed-in
Super Admin is `"company"`-scoped, exactly like the CEO, the Finance Manager and HR Operations.
`"system"` belongs to `systemAccessContext` — the identity crons and imports run as, which never
renders a tab strip.

So the bypass is invisible to every screen, and the thing that actually gets a Super Admin his
fifteen tabs is his permission matrix. The line stays, because a resolver that mirrors `canAccess`
must mirror all of it or the same context gets two answers from two functions describing one gate —
but it is now documented as parity, not as anyone's fast path, and the assertion that protects the
product asserts the *matrix* path.

Two smaller type defects surfaced in the same pass, both invisible to the test runner because
`--experimental-strip-types` strips types without checking them: the tests passed `scope: "role"`,
which is not one of the seven `AccessScope` values, and built an `AccessContext` without its `hrId`.
Both are gone — every scope in the tests and in the topbar now comes from `scopeForRole`, the same
function `resolveAccessContext` calls, so none of them is a literal anyone can get wrong again. **A
green test run carries no type signal here; only the PR's `typecheck` job does.**

Broken ten ways in fresh node processes — all ten fire with their own named message. The first
harness reported three false "not caught" results: a `?v=` cache-buster busted only the test module,
not the dependency under test, which stayed cached in-process. **The harness was wrong, not the
test.** One process per break is the only honest way to run this.

### Deliberately not tabs

- **`/workspace/marketing-requests`, its inbox and its decision page** — company approval work with
  a live sidebar badge, not personal self-service.
- **`/workspace/vacancies`** — a company report that happens to live under `/workspace`.
- **`/workspace/organogram`** — already retired to a redirect earlier the same day.
