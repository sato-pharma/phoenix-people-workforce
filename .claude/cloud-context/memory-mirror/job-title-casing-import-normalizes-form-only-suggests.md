---
name: job-title-casing-import-normalizes-form-only-suggests
description: "employees.job_title has TWO writers that DELIBERATELY differ, and a session will be tempted to unify them: the IMPORT normalizes free text through toOrgTitleCase() (a sheet is bulk data with no author), while the Employees-screen Save (employeePayload) writes what was TYPED and only OFFERS a correction via suggestOrgTitleCasing() (a form IS the human's intent). Running the full caser over form input damages deliberate spellings — QA/QC → Qa/qc, eCommerce → Ecommerce, Sales Rep (Delta 3) → (delta 3) — none fixable by any rule, so the divergence is CORRECT, not an inconsistency to close. The 2026-09-05 import repair itself regressed a real title (Finance and Admin Manager → Finance And Admin Manager) until the minor-word rule; hint + fix shipped and verified live in production."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0da0925d-272b-46cc-a2f9-cfa8d624429b
  modified: 2026-09-06T22:33:15.453Z
---

**`employees.job_title` has two writers, and they are SUPPOSED to behave differently. Do not make
them match.**

- **The IMPORT normalizes.** `app/api/imports/employees/confirm/route.ts` routes every uploaded Job
  Title through `toOrgTitleCase()` (at `buildRecord()` in `src/lib/imports/employee-validator.ts`),
  so a sheet spelling `Ceo` / `Sfe Manager` / `R And D Manager` cannot write a mangled title back.
  A spreadsheet cell is bulk machine-shaped data with no author standing behind it — per-word title
  case is a net repair there. Shipped #3311, then the minor-word fix #3326.
- **The Employees-screen Save does NOT.** `employeePayload()`
  (`src/lib/employees/employee-directory.ts`, `job_title: compact(input.jobTitle)`) writes what the
  person typed, verbatim, and the form only *offers* a correction underneath the Title field via
  `suggestOrgTitleCasing()` with a "Use it" button (shipped #3332). A form is one person deliberately
  typing one title — the casing IS the intent.

**Why the form must never call `toOrgTitleCase()`.** It title-cases every word, so over free-text it
produces something WORSE than what was typed, and no general rule fixes it:

| typed | full caser would store |
| --- | --- |
| `QA/QC Supervisor` | `Qa/qc Supervisor` |
| `eCommerce Manager` | `Ecommerce Manager` |
| `Sales Rep (Delta 3)` | `Sales Rep (delta 3)` |

`QA/QC` is one whitespace-delimited word; the other two are deliberate intra-word capitals no rule
can tell from a typo. Proposing a value worse than the typed one is a worse failure than staying
quiet, so `suggestOrgTitleCasing()` is surgical — it rewrites only the vocabulary it actually knows
(an acronym, a minor word out of place, the `R and D` phrase) and returns every other character
byte-identical, or `null` (not the unchanged string) when there is nothing to say.

**Why:** the two paths differ because their INPUT differs — bulk sheet vs. deliberate human keystroke
— not by oversight. A session that sees `employeePayload` write `job_title` unconditionally while the
import normalizes will read it as a bug and try to close the gap; doing so silently corrupts every
`QA/QC`-shaped title through the UI.

**How to apply:** never point `employeePayload` (or any form Save) at `toOrgTitleCase()`; if a form
needs the `Ceo`→`CEO` catch, use `suggestOrgTitleCasing()` (suggest, don't normalize — the system
flags, it does not auto-correct). Reuse the shared `ORG_TITLE_ACRONYMS` / `ORG_TITLE_MINOR_WORDS`
sets; never grow a second vocabulary.

**The repair regressed real data once — this is why the minor-word rule exists.** When #3311 pointed
`job_title` at the caser, the caser title-cased EVERY word, so it would have rewritten B-185's real
stored `Finance and Admin Manager` (a correct, human-entered title, also on the
`finance_and_admin_manager` position row) to `Finance And Admin Manager` on the next upload — the same
silent damage in the opposite direction. `ORG_TITLE_MINOR_WORDS` (in `org-title-case.ts`) lower-cases
a minor word only in the MIDDLE of a name (first/last letter-bearing word always capitalises).
`a` is DELIBERATELY excluded from that set — the live sales LINE codes are the bare letters `A`, `C`,
`P`, so `Team A Support` must keep its `A` — the same weigh-the-false-positive reasoning that keeps
`it` out of the acronym set. Measured on the 24 distinct production titles: 23 were fixed points, that
one was not; after #3326 it is 24 of 24. The old test even PINNED the wrong casing
(`"Finance And Admin Manager"`), so the suite was defending the bug.

Both fixes are live and #3332's hint was verified by observation in the real production app (Super
Admin → Employees → Add Employee → Title → typing `Ceo` shows the amber `Did you mean "CEO"?`, "Use
it" writes `CEO` and clears the hint — no Save). Same DRY discipline throughout: the junction between
`new-session.mjs` and `sync-worktree-env.mjs`, and the one caser both import paths share, exist
because two byte-identical private copies once let a title caser stay "fixed in one of two places".

Related: [[employee-import-blanks-salaries-and-job-title-creates-positions]] (the original generator
fix, the acronym set, the round-trip invariant) ·
[[optional-field-written-unconditionally-is-a-silent-erase]]
