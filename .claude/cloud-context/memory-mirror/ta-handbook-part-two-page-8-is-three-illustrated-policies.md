---
name: ta-handbook-part-two-page-8-is-three-illustrated-policies
description: "Talent Acquisition handbook Part Two (pages 8-21, built 2026-10-16, all approved by him page by page): the page map, the generator, the rules he set (vacants wording, her real account screenshots, no signature on page 21, Arabic mark only as watermark/foot) and the facts printed on page 8 (attendance, excuses, leave, salary in two parts or one)."
metadata:
  node_type: memory
  type: project
  originSessionId: 0699131c-9b4a-4ab5-b5cd-5820bfbcb052
  modified: 2026-10-16T13:38:17.816Z
---

**APPROVED AS FINAL by him, 2026-10-16: "handbook approved, nothing else to change"** - the file is `Talent-Acquisition-Handbook-Complete-Pages-1-21-v3.pdf` (21 pages, Part One 1-7 + Part Two 8-21). Do not reopen it unless he does.

**"Start here" sheet (2026-10-16, his word: "after her welcome put it"):** the second sheet of `Talent-Acquisition-Handbook-Complete-v5.pdf`, straight after the Welcome page, UNNUMBERED, so the printed page numbers below stay valid (the PDF has 22 sheets). It tells her the Sato-email sign-in (invitation to her Gmail, one-time password from it), then the Phoenix sign-in (HR-011), then changing the temporary password at My Profile > Password. The one-time password is deliberately NOT printed. Renumbering every page by one was not done; do it only if he asks.

**Page map (final, 2026-10-16):** 8 policies, 9 signing in, 10 overview, 11 organogram intro, 12 reading the chart,
13 the whole journey (11 stages), 14 recruitment workspace, 15 candidate pool, 16 screening page, 17 interview calendar,
18 writing a job offer, 19 following an offer, 20 the rest of the menu (brief), 21 end of Part Two (navy and gold).
Part One is pages 1-7 (page 7 closes Part One). Generators in the session scratchpad: `tools\build-part2.mjs` (Part Two)
and `tools\build-handbook.mjs` (Part One); the full file is `Talent-Acquisition-Handbook-Complete-Pages-1-21-v1.pdf`.

**His rules while building it:** one page at a time, he approves each before the next; every statement about Phoenix needs
a screenshot from Yomna's real account in his Chrome (read-only, never type a password, never send or change anything);
screenshots at full desktop size; applicant names, emails, phones and packages blurred; say "vacants" (open vacants,
closed vacants), never "requisitions"; wording never "deduct", never "policy", never servile; Arabic Sato mark only as
watermark or foot, never in the masthead; his signature removed from page 21 (and Part One page 7); the organogram
comes before the recruitment pages ("task number one").

**Page 13 stage 7 (decided 2026-10-16):** Yomna has Viewer access on the interview calendar, so she asks for the day,
interviewer and up to 25 CVs and HR gives each CV a time. No access change was made.

**Facts printed on page 8, each read from the code or production on 2026-10-16:**
- Attendance, the Default Attendance Policy (id 4): day starts 09:00, lateness counted from the 09:30 flex ceiling,
  15 minutes free, then 1/8 day (16-30 min), 1/4 (31-45), 1/2 (46+); 7h50m presence between first and last punch;
  completing the hours halves a late penalty; late and short costs only the larger; a single punch goes to
  verification first. Yomna (HR-011) has no policy of her own, so the default applies.
- Leave (`src/lib/vacation/calculations.ts`): leave taken in months 1-6 is unpaid; 15 days in the first year, earned
  1.25 per completed month; 21 days a year from the first anniversary; emergency 6 days per calendar year, same day,
  before 10:00 Cairo; annual leave must start today or later; a compensatory day opens once its event date has come.
- Excuses: two a month, two hours each, the manager decides.
- Salary: two parts for Medical Representatives and District Managers, Senior included; one part for every other title
  (`docs/recruitment-offer-joining-form.md`). Part 1 = Basic Salary (70% of Base), paid on the 1st; Part 2 = the rest of
  Total Payable, paid on the 10th (printed "after closing"). One part pays the whole Net Salary in Part 1. Yomna is `one_part`.

**Still open (his answer needed, none blocks the file):** her title (Phoenix `Talent Acquisition` vs handbook `Talent
Acquisition Specialist`); her record has no sign-in email, so a reset code cannot reach a Sato mailbox; the fuel allowance
left off page 8; whether Pedia payroll gets a slide; the Requisitions tab is still named "Requisitions" in Phoenix.
Related: [[talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day]], [[the-house-document-identity-standard]].
