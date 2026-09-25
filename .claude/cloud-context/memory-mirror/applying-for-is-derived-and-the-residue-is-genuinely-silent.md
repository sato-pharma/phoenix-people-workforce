---
name: applying-for-is-derived-and-the-residue-is-genuinely-silent
description: "The candidate pool's \"Applying for\" is DERIVED from seven sources at read time, never stored — the last rung is the role they HOLD, and the 88 rows still empty are mostly CVs the model has never read."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5f6e15e1-d34d-44e7-957b-76b67e0453b9
  modified: 2026-08-21T01:46:25.437Z
---

**PROD 2026-08-21 (#2244 `72876b86`, #2246 `4f44b2c2`).** `ats_candidates.applied_for_job_title` is
filled on **15 of 555** rows. The column is populated by `src/lib/recruitment/applied-for.ts`, which
walks six sources at **read** time and **writes nothing**. Live result, **read off the production
DOM 03:44 Cairo**: **396 answered / 159 "Not stated"**, up from 204. Median answer 22 chars, 0 cells
truncated, 0 wrapped, page `scrollWidth === clientWidth` (1528).

**The wordy answers were trimmed by #2248 `8f514227` (26 → 11 cells).** `tightenJobTitle` runs LAST,
after every other guard has accepted the title, and removes only a person, a filler word, a CV
marker, a boast and a date. **The 10 distinct answers still long are CORRECT and must not be
"fixed"** — `National Sales Manager – Anti-Infective Line`, `Senior Medical Sales Representative
(Nigeria)`, `HR Generalist / HR Operations / Personnel & Payroll`,
`Procurement executive/Store logistic supervisor Supply chain executive`. Every word in those is a
line name, a country or a second role.

| rung | source | rows |
| --- | --- | --- |
| 1 | `applied_for_job_title` (a human typed it) | 15 |
| 2 | `ats_candidate_source_context.subject` **+** the `Subject( … )` inside `full_name` | 370 |
| 3 | the WhatsApp caption / messages sent with the CV | 3 |
| 4 | latest CV extraction `extracted_fields->'appliedForJobTitle'->>'value'` | 5 |
| 5 | the requisition an application points at | 3 |
| 6 | latest CV extraction `currentJobTitle` — **the job they HOLD** | 71 |

Ordering is deliberate: the **sender's own words outrank the model**, because the model's reading is
DERIVED from those same words (`formatCoveringMessage`), so preferring it prefers a paraphrase.

**Rung 6 is a DIFFERENT KIND OF FACT and must stay labelled as one (PR #2252, 396 → 467/555).** Every
rung above it is somebody saying what they *want*; this one is what they already *have*. It earns its
place because **117 candidates attached a CV and wrote no covering text of any kind** — for them the
choice is their current role or an empty cell. `currentJobTitle` is filled on **131** extractions
against `appliedForJobTitle` on **23**, because a CV is written to say what someone has *done*. The
tooltip therefore opens *"They did not say which job they want"* and the mobile card reads
*"(their role now, per CV)"*. **Never quietly promote it or drop the wording** — a recruiter reading
the job someone holds as the job they asked for routes the CV to the wrong manager.

**The residue is 88 and only one slice is buyable.** 56 have a CV file the model has **never read**
(an AI extraction run could fill many — a spend, ask first); 31 were read and hold **no job today**
(fresh graduates — 3 have a summary, **0** have an employer); 1 has no file at all. The older
"58 already read, found nothing" figure was about `appliedForJobTitle` only and is superseded:
the same extractions do carry `currentJobTitle`, which is what rung 6 harvests.

Traps proven by measurement, do not "simplify" them away:

- **A chat message must pass a job-word test; a subject line must NOT.** Live, the message rung put
  `صباح الخير` ("good morning") ×3 and a home address into the column that routes CVs. But subjects
  are shorthand — `Cairo 2 DM`, `M.r - Gharbia`, `Mohamed Hassan D.M` are real answers with no job
  word in them. Asymmetric on purpose (#2246).
- **`extracted_fields->>'appliedForJobTitle'` returns the whole JSON OBJECT, not the value.** Use
  `->'appliedForJobTitle'->>'value'`. The wrong form inflated a count from 9 to 169.
- **NFKC first.** Ten senders write 𝐍𝐚𝐭𝐢𝐨𝐧𝐚𝐥 𝐒𝐚𝐥𝐞𝐬 𝐌𝐚𝐧𝐚𝐠𝐞𝐫 in mathematical-bold; unfolded it is a
  different string in every filter and count.
- **`\b` is defined by `[A-Za-z0-9_]` and it has bitten this one file TWICE.** In front of an Arabic
  letter it matches NOTHING, which let a maternity-leave request through as a job title. And an
  **underscore is a word character**, so there is no `\b` between `Resume` and `_National` — the
  name-stripping rule silently skipped `Shashi Gupta _ Resume_National Sales Manager` and left the
  sender's name in the column (#2250). The underscore case is the nastier one: `_` is exactly what a
  filename uses as a separator, so the strings the rule exists to clean are the ones most able to
  defeat it. **End a marker on `(?![A-Za-z])`, not `\b`.** See
  [[shell-grep-unusable-use-git-grep-or-rg]] for the other regex trap in this repo.
- **Trim a trailing name ONLY across an explicit separator.** Two capitalised words are
  indistinguishable from two governorates: a draft of `tightenJobTitle` that stripped a bare
  capitalised tail deleted `Qena Luxor`, `Upper Egypt` and `Kafr Elsheikh`, and ate `Infective Line`
  out of the middle of `Anti-Infective`. A kept name is a blemish; a deleted territory is a wrong
  answer. `Finance Manager Mohamed Hamed` keeps its name on purpose.
- **Measure a cleaner change against the WHOLE live corpus, never against the rows you set out to
  fix.** The first draft passed all 26 target cases and silently damaged 8 healthy ones. The check
  that caught it: pull all 226 distinct live subjects, run the cleaner before and after, diff. Both
  regressions were invisible in the 26.
- **NEVER tighten a STRUCTURED field — only an envelope.** `tightenJobTitle` exists for subject lines
  and captions, where the sender's name and CV filename are glued to the role. Run against a CV
  extraction or a requisition it only destroys: it read `District Manager - Commercial Unit` as a
  person and deleted the business unit. `cleanJobTitle(value, { tighten: false })` for `cv`,
  `requisition` and `current`.
- **A tail that names a job is not a person, however much it looks like one.**
  `HR | Administration | Operations Manager` became `HR | Administration` — two capitalised words
  after a separator. The remainder-still-a-job guard could not catch it because "HR" is itself a job
  word, so the wreckage passed. Test what you are about to DELETE for a job word, not only what is
  left behind.
- **Stripping a leading phrase can STRAND the middle of it.** `CV for the position of National Sales
  Manager` loses `CV for ` as a name-or-job marker and shows *"the position of National Sales
  Manager"* — the `for the post of` entry only fires at the START of the string, so it never saw it.
  After adding any prefix rule, re-read the live column, not the test corpus.
- **The two extra queries run only against the ~120 rows the free evidence could not answer, and
  `appliedForJobTitle` + `currentJobTitle` come off ONE pass** over the same jsonb blob (a test pins
  the single `.from("ats_candidate_cv_extractions")`). `extracted_fields` is 1.1 MB across 370 rows
  and [[every-db-round-trip-crosses-the-atlantic]].

Related: [[ats-candidates-full-name-holds-the-whole-intake-envelope]] ·
[[cv-extraction-never-applied-to-candidate-columns]] · [[intake-candidates-never-get-phone-applied]]
