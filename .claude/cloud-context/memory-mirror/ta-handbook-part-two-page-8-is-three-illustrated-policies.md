---
name: ta-handbook-part-two-page-8-is-three-illustrated-policies
description: "Talent Acquisition handbook Part Two, page 8 (his ruling 2026-10-16): no title or contents page, no Phoenix-account chapter on it. It is ONE page that illustrates three policies - working hours and attendance, leave and vacation, salary payment (who is paid in two parts, who in one, and the breakdown). Part One stays 7 pages; build one page, he approves, then the next."
metadata:
  node_type: memory
  type: project
  originSessionId: 0699131c-9b4a-4ab5-b5cd-5820bfbcb052
  modified: 2026-10-15T23:12:31.824Z
---

His words, 2026-10-16: "page 8 not approved it should be Working hours and attendance policy / Leave and
vacation / salary payment policy who recieves 2 part and who recieves 1 and the breakdown donot put titles
start illusturating per point and remove the 12 13 14". Work is page by page: he confirms, then I continue.

**Page 8 as built (v3, scratchpad `handbook\Talent-Acquisition-Handbook-Part-Two-Page-8-Policies-v3.pdf`, generator
`tools\build-part2.mjs`, A4, 12 mm clear of the foot):** three blocks, line-only (the ink rule), no hero headline,
masthead without the Arabic mark (watermark and foot only, his ruling of 2026-10-12).

**Facts on it, each read from the code or production on 2026-10-16:**
- Attendance, the Default Attendance Policy (id 4): day starts 09:00, lateness counted from the 09:30 flex ceiling,
  15 minutes free, then 1/8 day (16-30 min), 1/4 (31-45), 1/2 (46+); 7h50m presence between first and last punch;
  completing the hours halves a late penalty; late and short costs only the larger; a single punch goes to
  verification first. Yomna (HR-011) has no policy of her own, so the default applies.
- Leave (`src/lib/vacation/calculations.ts`): leave taken in months 1-6 is unpaid; 15 days in the first year, earned
  1.25 per completed month; 21 days a year from the first anniversary; emergency 6 days per calendar year, same day,
  before 10:00 Cairo; annual leave must start today or later; a compensatory day opens once its event date has come.
- Salary: two parts for Medical Representatives and District Managers, Senior included; one part for every other title
  (`docs/recruitment-offer-joining-form.md`). Part 1 = Basic Salary (70% of Base); Part 2 = the rest of Total Payable
  (Net Salary + previous expenses + additions - deductions, never below 0). One part pays the whole Net Salary in
  Part 1 before month end. Yomna is `one_part`.

**Still open:** her title (Phoenix `Talent Acquisition` vs handbook `Talent Acquisition Specialist`), her sign-in has
no email, and Part One pages 1-6 still show the Arabic mark in the masthead. Related:
[[talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day]], [[the-house-document-identity-standard]].

**Update 2026-10-16 (v9):** page 8 now carries FOUR blocks on ONE A4 page — attendance, excuses (two a month, two hours each, manager decides), leave, salary payment (build bar, two parts, one part) — his word "make them one page it will fit". Fitted by tightening rule padding and block gaps (3.8 mm clear of the foot). I had split salary onto a page 9 (v8) and he sent it back. Excuse rules read "An excuse covers the day / Once approved, attendance does not deduct that day." Not approved yet.
**v10 (2026-10-16, his word):** Part 1 is paid on the 1st of the month, Part 2 on the 10th (printed 'after closing'); the figure carries those dates.
**v13 wording rule (his word, 2026-10-16):** never 'deduct/deducted/deductions', never the word 'policy', never a servile tone ('manager approves/returns'). Say it the gentle corporate way, same meaning.

**Page 9 (2026-10-16, 'page 8 approved, build page 9'):** Your Phoenix account — signing in. Built from REAL screenshots: the sign-in card (his own screenshot of the login page) and her home page, taken read-only in his Chrome browser named 'o', where Yomna Gamal's real account was already signed in (HR command centre, Talent Acquisition). Five numbered callouts on each. His rule: everything said about Phoenix needs a screenshot from her account.

**His rule 2026-10-16:** read his other sessions (list_sessions / search_session_transcripts / list_events) at the start of each handbook page and re-screenshot her account if they changed it: PRs 5969 (her menu rail), 5970 (her notification centre), 5971, 5967 (job posts) were merged and live while page 9 was being built, so its home-page screenshot was retaken. Her seat's search finds PAGES only, never people.
