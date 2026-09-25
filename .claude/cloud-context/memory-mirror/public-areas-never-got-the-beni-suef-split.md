---
name: public-areas-never-got-the-beni-suef-split
description: "public.areas (the legacy org area table recruitment/vacancies point at) had NO UE9 row and called GZ6 'Fayoum-Beni Suef' — fixed in prod 2026-08-19 (GZ6 renamed to Fayoum, UE9 Beni Suef added id 1145, vacancy VAC-UE9-AIF opened). Do not undo."
metadata: 
  node_type: memory
  type: project
  originSessionId: a754a99d-dcc7-4d41-9b78-549eb94ea0a7
  modified: 2026-08-19T02:04:27.156Z
---

Applied to PRODUCTION (`ozucdzovmcqvepbozvqf`) on 2026-08-19, owner-approved in conversation.
**Do not undo.**

`au.canonical_areas` / `au.seats` / `au.line_area_map` all got the 2026-08-03 Beni Suef split.
**`public.areas` did not** — it still had 49 unified rows with `GZ6` named `Fayoum-Beni Suef` and
**no `UE9` row at all**. That table is what `position_vacancies.area_id` points at, and what the
recruitment requisition cascade (Position → Line → vacant Area) renders as `areaName · vacancyCode`.
Two consequences, both live for months:

- The Anti Infective **Fayoum** vacancy `VAC-B106-O7F` (`SEAT-AIF-REP-GZ6`) displayed as
  `Fayoum-Beni Suef` and carried `region_name = 'Upper Egypt'`, contradicting its own manager
  (AI-0007 Mahmoud Eldaly, the **Giza** DSM) and its own seat (`region_code = GZ`, parent
  `SEAT-AIF-DM-GZ`). The 2026-08-09 manager repair fixed the manager and left the region behind.
- The Anti Infective **Beni Suef** seat `SEAT-AIF-REP-UE9` — active in `au.seats`,
  `vacant_will_hire` in `au.line_area_map` — had **zero** `position_vacancies` rows, so it was
  invisible to recruitment and could not be hired for at all.

**What was changed (4 writes):** `public.areas` 1118 renamed `Fayoum-Beni Suef` → `Fayoum`;
`public.areas` gained `UE9` `Beni Suef` (**id 1145**); `position_vacancies` 249 `region_name`
`Upper Egypt` → `Giza`; new open vacancy **`VAC-UE9-AIF`** (id 327, `SEAT-AIF-REP-UE9`, Anti
Infective, region `Upper Egypt 1`, manager **B-1 Nosiba**, the `SEAT-AIF-ADM-UE-1` acting DM).
Before-state JSON: `scratchpad/fayoum-beni-suef-vacancy-fix-before-2026-08-19.json` (session
a754a99d). Unified areas 49 → 50. No employee, team or coaching row moved — the two employees still
on GZ6 are both **resigned** (B-106, B-52).

**Known side effect, left deliberately:** Pedia's vacancy `VAC-B52-9P3` (`SEAT-PED-REP-GZ6`) now
reads `Fayoum` instead of `Fayoum-Beni Suef`, even though on Pedia one rep covers both halves. The
merge is expressed by two `au.line_area_map` rows sharing `SEAT-PED-REP-GZ6`, not by the area's
name — see [[fayoum-beni-suef-golden-rule-per-line]]. Do not "fix" this by renaming GZ6 back.

**How to apply:** `public.areas` is a legacy per-line table (90 line-scoped rows + the unified
`line_id IS NULL` set) and is **not** kept in sync with `au.canonical_areas` by anything. Before
trusting an area name or id from it, diff it against `au.canonical_areas`. Same staleness class as
[[area-migration-map-predates-the-beni-suef-split]]. A seat that exists in `au.seats` but has no
`position_vacancies` row is unreachable from recruitment — check both when a vacancy "should be
there and isn't".

**Second wave, same day (2026-08-19), same audit — also applied to PRODUCTION, do not undo.**
The sweep across Anti Infective, Pedia and CNS found the Beni Suef gap was not unique:

- **4 more rep seats were unreachable** — active in `au.seats`, `vacant_will_hire` in
  `au.line_area_map`, zero `position_vacancies` rows. Opened as **`VAC-CA6-CNS`** (id 328, CNS Cairo
  West, B-116), **`VAC-GZ1-CNS`** (329, CNS Giza - Giza Centers, B-117), **`VAC-CA2-PED`** (330,
  Pedia Nasr City, PD-0006), **`VAC-D24-PED`** (331, Pedia Sharkia 1, PD-0010).
- **11 open/historical vacancies had a region label contradicting their own seat** — repaired from
  `au.seats` -> `au.regions` (ids 173, 174, 266, 272, 273, 292, 293, 298, 299, 300, 308).
- **`VAC-B175-QTX`** (308) had no seat at all; linked to `SEAT-AIF-DM-UE-2` from its own
  owner-approved note.
- **`VAC-SEAT-KSL`** (312) was import debris — every field null, so it recruited for nothing.
  Set to **cancelled**, not deleted, so the import stays auditable.
- **Casing normalised to the `au` authority** (case-only, 14 rows): `public.areas` 3 -> `Nasr City`,
  6 -> `Cairo West`, 23 -> `Alex-BHR`; 9 vacancies and the 2 **active** employees B-119/B-156
  `ALEX-BHR` -> `Alex-BHR`. The **6 resigned** employees still spelling it `ALEX-BHR` were left
  alone deliberately — see [[terminal-vacancy-guard-makes-six-employees-uneditable]].

Verified after: 50 unified areas = 50 canonical = 50 matched, 0 casing drift, 0 of 37 open
vacancies with a wrong region label, 0 blank labels, 0 unreachable vacant rep seats, 0 seats with
more than one open vacancy.
