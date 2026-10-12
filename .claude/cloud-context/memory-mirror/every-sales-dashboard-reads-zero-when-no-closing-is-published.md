---
name: every-sales-dashboard-reads-zero-when-no-closing-is-published
description: "Everything is showing zero" on a manager's dashboard is answered FIRST by monthly_closing_publications.unpublished_at — one unpublish blanks every rep and manager on that line, company-wide, and the data is untouched.
metadata:
  type: project
---

Every sales surface reads only rows whose own `(line, period)` Monthly Closing is **published** (`loadPublishedPeriodKeys` filters `unpublished_at is null`), so unpublishing a month makes it vanish from every rep's and every manager's keycards at once — the figures are withheld by design, not lost. On **2026-10-12 at 01:05–01:11 Cairo** all nine `(line × month)` rows (July/August/September × Anti Infective, CNS, Pedia) were unpublished to unlock the months for the Qena أبنود/قوص brick move (Qena 1 → Qena 2, applied 13:27 the same day), and a Pedia Giza district manager reported "everything is showing zero" while his September was intact at 465,752 EGP against an 828,090 EGP target.

**Why:** the publication gate is invisible from the dashboard, so the symptom looks like a broken account, a lost seat or a dead attribution join — and chasing those costs an hour before the one-line query answers it.

**How to apply:** when any sales figure reads zero for a person, query `monthly_closing_publications` for `published_at` / `unpublished_at` BEFORE looking at seats, area codes or attribution; if nothing is published, say so and name the brick move or price fix the months were unlocked for. A re-publish after an unpublish gets a fresh `published_at` and **re-sends the announcement email** — pass `notify: false` for a month that was already announced. See [[sos-monthly-closing-is-the-only-sales-truth]].

**Half of this was a DEFECT, fixed 2026-10-12 (PR 5772):** only the MONEY may go quiet. The head counts and the daily CRM First Visit boards were rostered from the same sales services, so the district manager also saw Team Size 0 against four occupied rep seats, "Reps submitted 0/0", and — nobody being missing from an empty roster — a green "Every rep on your team has submitted". They read `resolveServingRoster` (the org-tree walk) now. If a roster, a head count or a daily board is empty AFTER that fix, the publication gate is NOT the answer: look at the seat in `au_v_org_tree`.
