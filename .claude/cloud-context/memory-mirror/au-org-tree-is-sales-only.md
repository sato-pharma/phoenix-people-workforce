---
name: au-org-tree-is-sales-only
description: "au_v_org_tree is the SALES seat model — head office (every Product Manager) holds no seat by design, so \"not in organogram\" is an accusation, not a finding"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c1fd41c-abde-42fb-9f8c-c8f3f3b8c67c
  modified: 2026-08-28T02:57:55.187Z
---

`au_v_org_tree` is the organogram: **one row per seat, EVERY tier**, carrying `seat_id`, `path`,
`seat_tier`, `occupant_hr_id` and — below the area layer — `line_code`/`region_code`. Measured on
production 2026-08-28: **133 seats, 91 occupied by 90 people, all 91 resolve.**

**It is the SALES seat model and has no marketing branch.** All three active Product Managers are
off it by design — `B-155` (Product Manager), `A-10` (Product Manager), `A-8` (Group Product
Manager). So a person with no seat is usually **head office or a leaver**, not a gap in the chart.
Labelling such a row "not in organogram" is literally true and reads as an accusation; the owner
objected to exactly that wording when it was applied to his District Managers. **Fall back to the HR
directory's `job_title`** (`EmployeeDirectoryRow.jobTitle`, already on the cached row) and name the
person by it. A *seat still outranks a job title* for anyone on the chart, and a free-text title must
never decide a KPI denominator — it is a LABEL only.

**Never resolve a person's line/region from `au_v_line_area_map.rep_seat_id`** — that column holds
REP seats and nothing else, so every DM, Acting DM, RSM and NSM falls through it. That mistake
rendered 22 seated managers as holding no seat and reached a PR.

Two structural facts that bite:

- **A seat above the area layer carries no cell of its own** and resolves to the union of its
  descendants: RSM -> 3 cells, NSM -> 7-8, CEO -> 22.
- **`path` INCLUDES the seat itself** as its last element — `SEAT-AIF-ADM-UE-1` carries
  `[SEAT-ROOT-CEO, SEAT-AIF-NSM, SEAT-AIF-ADM-UE-1]`. Reading it as ancestors-only is how someone
  later "fixes" a bug that is not there.

**91 seats to 90 people is not a typo.** One person holds two seats — an ACTING_DM seat and the REP
seat beneath it. Per [[acting-dm-authority-is-app-role-not-job-title]] she **stays a medical rep**,
so the REP seat must win the tier whatever order the view returns the rows in; deciding it by row
order is no decision at all. See also [[never-change-the-organogram-skeleton]] and
[[organogram-chart-source-is-au-seat-model-not-directory]].
