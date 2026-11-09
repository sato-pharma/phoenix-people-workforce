---
paths:
  - "src/components/employee-portal/dashboards/**"
  - "src/components/employee-portal/team-calendar-view.tsx"
  - "src/lib/employee-portal/{home-snapshot,serving-roster,unranked-managers,team-calendar,team-calendar-cell,team-calendar-weeks,rsm-home-summary}.ts"
  - "app/employee-portals/team-calendar/**"
  - "tests/{portal-serving-roster,nsm-team-calendar,regional-team-reports,ceo-command-center,business-review-person-names,rsm-home-premium}*"
---

# Module memory — A manager's team boards on the portal home

**Scope:** The district, regional, national and CEO landing boards: the serving roster from the org tree, My Districts and its unranked managers, the NSM team calendar square, managers on leave, and the names the home snapshot prints.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

- 🔴 **THE NSM TEAM CALENDAR'S SQUARE PRINTS AM · PM · PHARMACIES APART, AND A MANAGER'S DAY CARRIES EVERY RECORD THAT IS HIS** (owner, 2026-10-23). The engine attaches `ownVisitSplit` and `rideAlongSplit` per VISITS day (`splitBucketOf` → `visitCountBucket`, a campaign or admin row in none); the portal service hangs a manager's own Phoenix CRM single visits on his cells as `managerOwnSplit` (through `loadManagerOwnVisitDays`, best-effort). `portalDaySplit` prints his own calls, a pure ride-along day the split of the visits he joined (fuchsia stays the DV marker), and a day of only his own Phoenix visits reads as worked, never the rose "No activity". Display only — never a status, severity or deduction candidate. Pinned by `tests/nsm-team-calendar.test.ts`.

- 🔒 **A MANAGER'S TEAM ROSTER COMES FROM THE ORG TREE, AND ONLY THE MONEY IS GATED ON A PUBLISHED CLOSING** (2026-10-12). All nine closings were unpublished to unlock the months for a brick move, and a Pedia Giza district manager reported "everything is showing zero": his Team Size read **0** against four occupied rep seats, his CRM First Visit board read **Reps submitted 0/0** with "No visits submitted yet today" — and because nobody can be missing from a roster of nobody, the SAME board printed its green "Every rep on your team has submitted their first visit." Every one of those rosters was derived from `getDsmTeamPerformance` / the national / regional services, which are membership-by-SALES-history. 🔴 **The head count and every daily CRM board now read `resolveServingRoster` (`src/lib/employee-portal/serving-roster.ts`), which wraps the audited `getManagerScope` org-tree walk; the sales roster survives only as the fallback when a seat resolves to nobody, and an EMPTY roster gets its own state on the board instead of the all-clear.** The sales figures stay withheld — that half is his 2026-08-13 ruling and is correct. Pinned by `tests/portal-serving-roster.test.ts`.

- 🔒 **THE CEO'S "MANAGERS ON LEAVE" WATCHES EVERY MANAGER IN THE DIRECTORY, AND THE NATIONAL CRM FIRST VISIT BOARD COUNTS THE REGIONAL MANAGER** (owner, 2026-10-20). `managerOnLeaveCandidates` is everyone at least one active employee reports to — head office and field alike — not the month's double-visit riders; the CEO double-visit table lists idle managers too. `resolveServingRoster` returns `regionalManagers`, and `servingRosterManagers` puts them before the district managers on the board ("Managers submitted"). Pinned by `tests/ceo-command-center.test.ts`, `tests/portal-serving-roster.test.ts`.

- 🔴 **A REGIONAL MANAGER'S "MY DISTRICTS" LISTS EVERY DISTRICT MANAGER ON HIS ORG TREE — ONE WITH NO ROW IN THE PUBLISHED WINDOW SITS UNDER THE RANKED ROWS, UNRANKED, "Joined <date> · No published month yet"** (owner, 2026-11-09: Sahar El Gallad joined 24 Oct against a Jul–Sep window and had no row while the card said "3 districts"). Never a 0% and never a figure: her sales arrive with the first published month that holds her. `managersWithoutPublishedMonth` (`src/lib/employee-portal/unranked-managers.ts`), pinned by `tests/regional-team-reports.test.ts`.

- 🔴 **THE HOME SNAPSHOT'S TOP REPS AND MANAGER NAMES GO THROUGH `personNameLookup`** — the active-only directory missed a departed district manager, who printed in the Source of Sales capitals beside every proper-case name (NSM audit, 2026-10-26). Pinned by `tests/business-review-person-names.test.ts`.
- 🔴 **THE RSM HOME TELLS ITS FIGURES THROUGH `rsm-home-summary.ts`: A PERCENTAGE NEVER ROUNDS UP ACROSS A LINE, AND THE VIEWER'S OWN REQUESTS ARE NEVER THE VIEWER'S DECISION** (premium pass, owner, 2026-11-09). `wholePercent` floors (89.6% reads 89%, never 90% beside a gap to 90%), and the shared ranking boards use it. The Gap to 90% tile and Districts Needing Attention test the money against 90% of the target (`incentiveGap`). `PendingActions` splits the snapshot's vacation and excuse counts (the viewer's own) from the plans awaiting the viewer (`pendingItems`). The pacing panel names its scope and month, and a change is "Up 12% on Aug 2026", never "pts". Each month's target is the same closing row's. Account: `docs/rsm-home.md`. Pinned by `tests/rsm-home-premium.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (1)

- `nsm-team-calendar-portal-build` — The NSM-only Team Calendar employee-portal tab — SHIPPED, not uncommitted: app/employee-portals/team-calendar serves the page, a visits API and a per-rep per-date drilldown. This file records its data source, scoping and access model, which is the part worth reading before changing who can see it.
<!-- module-memory:notes:end -->
