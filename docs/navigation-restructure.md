# Navigation restructure — the owner's eleven rulings

**Status: model only. Zero lines of `src/config/system-navigation.ts` have changed.**

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
