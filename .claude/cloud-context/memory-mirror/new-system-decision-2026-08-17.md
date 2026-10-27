---
name: new-system-decision-2026-08-17
description: "Owner decided 2026-08-17 to build a NEW system rather than repair Phoenix; audit numbers, the two calls made for him, and the rules file that must go in the new repo."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-08-17T16:25:49.890Z
---

On **2026-08-17** the owner decided to stop repairing Phoenix and build a new system — new repo, new
branding, new UI, same work logic. He said twice he is fed up; the case against a rewrite was made
with data and he reaffirmed, so this is settled. Do not re-litigate it.

**Two calls made on his behalf** (he declined to answer the question, wanted momentum):
- **Same production database.** He asked for a new system, never new data. Zero payroll risk, and a
  clean domain layer makes a later schema move easy rather than terrifying.
- **HR core first** — employees, seats, org. Everything references it, and `lib/employees` had the
  worst repair-to-build ratio in Phoenix (2.23).

**The audit that produced this** (read-only, full git history, 17 Aug 2026 @ `82f6fa46`) — report
published as [Where Phoenix Hurts](https://claude.ai/code/artifact/36685a86-4635-4e9d-9ca1-8133de5759ca):
- Phoenix is only **110 days old** (first commit 2026-04-28). 2,884 non-merge commits, 906,833 lines.
- **47.1% of commits are repairs.** Repairs per feature: May 0.50 → Jun 1.33 → Jul 1.42 → **Aug 2.02**.
  The collapse took **six weeks** — May's fix rate was 4.3%, June's was 48.6%.
- **Root cause: 83 domain folders** under `src/lib` where ~12 are needed. One noun modelled six ways.
- **60.1% of fixes are followed by another fix to the same file within a week**; 20.6% within 24h.
- Counter-evidence against a full rewrite: **1,769 of 3,796 code files have never been fixed**; half
  of all fixes land in **282 files (7.4%)**; the **UI layer is the healthiest** part at 0.35 fix:feat.

**Why the new repo's rules must be MECHANICAL, not behavioral:** Phoenix already had ~15,000 words of
`AGENTS.md`/`CLAUDE.md` and they prevented none of the above. The new `AGENTS.md` (drafted 2026-08-17,
in the session scratchpad) pairs every structural rule with a named enforcement test — closed domain
manifest, single definition per noun, 400-line ceiling, config-as-data, no hand-maintained registry,
migration hygiene. **Those seven tests are written BEFORE any feature code.**

**Carry over the rules, not the code.** Phoenix's 787 test files are the real asset — the business
rules in executable form. Extraction started; see [[phoenix-rules-spec-extraction]]. Expect ~80–100
owner rulings to surface; they go to him as **one XLSX with dropdowns**, never as chat questions.

**The new repo exists: `E:\New`** → remote **`it-gawish-hr/phoenix-next`, PRIVATE**, pushed
2026-08-17 (before that it lived only on the E: drive). **The whole situation for a fresh
account is `E:\New\plans\00-START-HERE.md`**, with one self-contained `.md` per plan (`00`–`09`)
beside it. He is switching accounts when his limit ends — point any new session at that file first,
not at this memory. Run the laws with the **glob**: `node --test "tests/law/**/*.test.ts"` (a bare
directory path dies). Now **8 law tests / 31 assertions**, all green at `49c816b`.

**The plan sheet is the new repo's memory, and updating it is law C12.** One live Google Sheet, six
tabs, PAINTED from `E:\New\plans\plan-data.json` and **never typed into**; the Apps Script in
`E:\New\google-apps-script\plan-sheet\` pulls hourly and nothing ever pushes — same architecture as
Phoenix's Master Map, **no Google credential anywhere.** Every session appends what it did to that
JSON and runs `npm run plan:build`; `tests/law/plan-sheet-is-current.test.ts` goes red the moment a
commit is newer than the newest request in it. His own test, in his words: *if he asks about
something and it is not in the sheet, there is a corruption in the trip.* **Offline copy:
`E:\New\xlsx\phoenix-next-plan.xlsx` — a SNAPSHOT, never the live one.** The script reads through the
**GitHub Contents API** (`Accept: application/vnd.github.raw`), **not** `raw.githubusercontent.com`,
which does not serve private repos; config (`PLAN_REPO`, `PLAN_TOKEN`, `PLAN_REF`) lives in the
sheet's Script Properties and **never** in git. A private repo returns **404, not 403**, when a token
cannot see it — so a bad token looks exactly like a bad path.

Related: [[sos-monthly-closing-is-the-only-sales-truth]] · [[owner-office-allocation-rule-value-share]]
