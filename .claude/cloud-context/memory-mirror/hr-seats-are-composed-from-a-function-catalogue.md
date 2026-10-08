---
name: hr-seats-are-composed-from-a-function-catalogue
description: "The HR permission roles (HR Operations, HR Resourcing = Talent Acquisition) are COMPOSED from HR functions in hr-functions.ts — no literal role block exists for either, so a test scraping permissions.ts for one returns null. HR Advisory was RETIRED 2026-10-08; its leftover functions sit on UNASSIGNED_HR_FUNCTIONS (the Super Admin's)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10c9e0cd-506e-4881-977d-63fca5e0190c
  modified: 2026-10-08T21:40:00.000Z
---

Owner rule, 2026-08-28: **stop naming permission roles after job titles.** It had cost two sweeps —
`HR Specialist` (retired 2026-06) and `Talent Acquisition` (retired 2026-08-28). His correction was
to define the HR **functions** and give each seat a subset: *"make, for example, six HR functions.
The HR business partner have from this six, for example, four … but at the end of the day,
everything."*

**CURRENT (2026-10-08):** `HR_ROLE_BUNDLES` composes **HR Operations** and **HR Resourcing** (shown as
Talent Acquisition). The HR Business Partner seat (`HR Advisory`) was **retired** that evening —
"no more HR business partner … everything regarding recruiting is for the talent acquisition", the
rest "Leave it for system administrator now" (PR #5565). `recruiting` is Talent Acquisition's
alone; `hiring_paperwork`, `engagement_retention`, `hr_communication` and `workforce_insight`
are on `UNASSIGNED_HR_FUNCTIONS` (the Super Admin's), and governance rule 3 now reads "bundles plus
that list = the catalogue". Handing one out is a MOVE from that list into a bundle.

The original two-seat layout, for history (`src/lib/auth/hr-functions.ts` then held **eight functions**):

| | Functions |
|---|---|
| **HR Advisory** | recruiting · engagement_retention · workforce_insight · performance_probation · hr_governance |
| **HR Operations** | people_records · time_attendance · payroll_inputs · performance_probation · hr_governance |

Five each, two shared, union = the whole catalogue. **To change what a seat can do, move a key
between the two arrays** — no rename, no sweep, no migration. `HR Advisory` was chosen after the
owner's approved `HR Recruiting` was invalidated by this same correction, and **he confirmed it
2026-08-28** ("yes go with HR Advisory, merge it").

**SHIPPED 2026-08-28.** PR #2519 merged as `46b5ee20`, live in production 09:19 Cairo, and migration
`20260828140000_hr_role_keys_replace_talent_acquisition` applied to `ozucdzovmcqvepbozvqf` the same
morning. Post-apply counts re-read from live: retired role = 0 rows in all eleven places, both new
`roles` rows exist, all three CHECK constraints carry the 17-value list, and `employees.job_title`
still reads `Talent Acquisition` on A-16 — the migration asserts that and rolls back if it does not.
The job title is a historical fact about a person; only the ROLE was retired.

## The three things that bite

- **No literal role block exists in `permissions.ts` for a live HR seat.** The matrix entry is
  `hrBundleGrants(seat)` (the retired `HR Advisory` entry is now a literal `{}`). Any test that scrapes the source text for a role block — several
  do, e.g. the `roleBlock()` helper in `tests/coaching-permissions.test.ts` — gets `null` and reports
  "permission block must exist". Read `permissionMatrix[role]` instead.
- **`permissionMatrix` is NOT the raw composition.** `applyHardPermissionBoundaries`
  (`permissions.ts:513`) runs over it and INTERSECTS every resource — narrowing only — **except
  `support_requests`, which it SETS outright**. That is the one path that can widen a grant after
  composition, and `tests/hr-function-governance.test.ts` rule 6 pins it.
- **The successor of a retired role is a question about which FUNCTION carried the grant, not a
  find-and-replace.** A sweep mapped the retired seat's `organogram:read` to HR Operations; it
  belongs to `workforce_insight`, which only HR Advisory holds, and CI caught it. Same class of
  error produced the patient-data over-grant in
  [[report-it-sounds-like-hr-and-is-patient-data]].

## Retired seats fail CLOSED

**HR Advisory (2026-10-08) is retired IN PLACE, not aliased:** it stays in `phoenixRoles` via
`retiredPhoenixRoles` so its salary-redaction restrictions keep applying, every picker lists
`assignablePhoenixRoles`, and the server refuses to assign it. Its one former holder (inactive)
became Employee in the same migration — never the successor seat.

`normalizeRole` aliases both `"hr specialist"` and `"talent acquisition"` to **`Employee`**, never
to a successor. Aliasing a retired key sideways reads as continuity and is a privilege
carry-forward. Verified before deciding: the only production row still carrying the retired role was
inactive and resigned.

## Governance

`tests/hr-function-governance.test.ts` (registered in `tests/run-tests.ts`) holds eight rules —
chiefly that no `PhoenixRole` is also a `phoenixCompanyJobTitle` except a **closed** grandfather list
of nine historical collisions, that neither a bundle nor an individual function breaches
`HR_ROLE_BOUNDARIES`, and that neither seat holds the whole catalogue. Proven by breaking it three
ways; each fired its own headline assertion.
