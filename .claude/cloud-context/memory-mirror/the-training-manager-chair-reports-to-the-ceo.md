---
name: the-training-manager-chair-reports-to-the-ceo
description: "Owner 2026-10-19 - the Training Manager reports to the CEO (Anwar Gaweesh, AA), not the Marketing Manager (A-9); changed on the open vacancy, the open requisition and the offer job title; two offers sent earlier that day still say the old boss."
metadata:
  node_type: memory
  type: project
  originSessionId: 505a35ad-33fa-4d19-88f7-21c1a6bae2db
  modified: 2026-10-19T14:44:23.685Z
---

Owner, 19 Oct 2026: *"in organogram move the training manager position to be reporting to dr anwar gaweesh the ceo"* - a Super Admin structure change by his own intent, so it passes [[never-change-the-organogram-skeleton]]. He then chose "Change to CEO" for the offer letter and "Move to the CEO" for the hiring manager.

**Three production rows changed (17:37-17:40 Cairo), each one row, reversible:**
- `position_vacancies` id 394 (Training Manager, Head Office, open, `seat_id` null): `manager_hr_id` A-9 -> AA, `manager_name` -> Anwar Gaweesh. The Head Office branch of the chart is built from `employees.manager_hr_id` plus open `position_vacancies` rows (`organogram-head-office.ts`), so this row IS the chair on the chart.
- `ats_requisitions` 16af44db-b052-440b-848f-53ef0b113221: `hiring_manager_hr_id` A-9 -> AA. It had no applications. `hire-draft.ts` copies this id onto the new employee's manager, so the hire arrives with manager AA.
- `offer_job_titles` 42f48718-dbeb-4860-a031-4278a8a825f6 (Training Manager): `reports_to` "Marketing Manager" -> "Chief Executive Officer" (the National Sales Manager row's wording).

**Fourth row, same evening (17:44 Cairo):** at his word *"use this the training manager job offer"* the same `offer_job_titles` row's `role_summary` became his two-paragraph text ("...expertise, leadership, and training capabilities required to develop and strengthen our field force." / "As Training Manager, you will be responsible for designing and delivering training programmes..."), 632 characters, no `{{territory}}`, kept with its blank line (the letter's HTML collapses it into one paragraph). Replaced wording, for putting back: "...expertise and the teaching skill this role calls for, and we would like you to bring both to {{territory}}. In this role you will own the learning of our teams..." (451 characters). The code seed `OFFER_TRAINING_MANAGER_ROLE_SUMMARY` still holds the old wording.

**Why the three had to move together:** `phx_autofill_replacement_vacancy_for_employee` fills a vacancy only when the new employee's `manager_hr_id` equals the vacancy's (or that manager is null or departed). A hire with manager A-9 against a vacancy under AA would leave the vacancy open as a ghost under the CEO.

**Left as it was:** the previous holder A-7 (terminated 2026-08-31, manager A-9, history). Two Training Manager offers SENT earlier the same day, before the change: `087a912c-d908-4104-9881-a8b2816a183f` ("Marketing Manager", sent 17:16 Cairo) and `ae439f20-5295-4d7d-aac8-1dd64ab6d6bf` ("General Manager", sent 17:09 Cairo) - a sent letter is what the candidate received, never edited in place. The seed default `reportsTo: "Marketing Manager"` in `src/lib/offers/default-template.ts` (fresh installs only; a one-line PR he would not merge, so parked).

Related: [[recruitment-automation-spec-before-build]] - [[organogram-has-two-data-paths-suppress-only-hits-vacancies]].
