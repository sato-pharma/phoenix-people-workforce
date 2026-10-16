---
name: a-dm-never-receives-a-dm-cv
description: "Owner rule 2026-09-09 - a district manager NEVER receives an application for a district manager post. DMs receive medical reps; the sales manager ABOVE a district receives the DM applicants, and so does everyone above him. Stated once as a rank - a manager receives only applicants for seats strictly BELOW his own. Now holds for a recruiter's hand-push only (the gate in sendCandidatesToManager): the automatic folders it also governed were REMOVED 2026-10-16, when a manager's folders became empty shelves filled only by what a person sends. Read before changing candidate-seat-rank.ts or sendCandidatesToManager."
metadata: 
  node_type: memory
  created: 2026-09-09
  modified: 2026-09-09T21:13:12.312Z
  type: feedback
  originSessionId: 131afc38-77af-472e-b526-e10d7ac9f9f0
---

**⚠ AMENDED 2026-10-16 — the folder half below is HISTORY.** The owner ended automatic delivery (*"now no more managers receive cvs automatic"*): a manager's folders are empty shelves off the organogram and hold only a CV a person sent (docs/recruitment-manager-cv-folders.md). `candidateManagerSeatTier` and `managerMayBeSentApplication` remain, and still refuse a hand-push of an applicant for the manager's own seat or above; `managerApplicantBoards` and the 96 → 31 board counts describe the removed placement and are kept only as the account of why the rank rule exists.

**The owner's words, 2026-09-09**, on finding district managers reading applications for their own
job in `/employee-portals/recruitment-candidates`: *"the district managers receive medical reps and
the national sales managers receive district managers and medical reps. A district manager never
receives district manager."* Then, on being told the hand-push was the one door still open:
*"close the push one too."*

**Why:** he named two rungs and the company has four, so the rule is stated once as a RANK — **a
manager receives only applicants for seats strictly below his own**. Written as a list ("a DM gets
reps, an NSM gets DMs") it cannot say where a REGIONAL sales manager's application goes, and Pedia
has a live RSM seat with three districts under it. The rank form is the same shape as
[[scope-runs-downward-only-never-your-own-manager]], which is his own earlier ruling for the
coverage boards.

**How to apply:** `candidateManagerSeatTier` (src/lib/recruitment/candidate-seat-rank.ts) reads the
post being applied FOR — `applied_for_job_title`, then the forwarded `Subject( … )` envelope, then
`current_job_title` — and answers `DM` / `RSM` / `NSM`, or **null for everybody else**. Null is the
ordinary case and routes exactly as it did before the rule existed. That asymmetry is the safety of
it: the rule can only ever REMOVE a CV from a district manager's folder, never empty one. Requiring
a positive `medical_rep` read instead would have emptied the folders, because most CVs in this pool
carry no readable title at all.

**The scale when it was found, measured on production.** Of 537 CVs eligible to reach a district
folder, **135 named a district-manager job** — 106 in `applied_for_job_title`, a further 29 in
`current_job_title` alone. Two real district managers were each holding a dozen applicants for their
own seat, in their own region:

| board | before | after |
| --- | --- | --- |
| Weaam Mahmoud (AI-0013), Anti Infective Upper Egypt 2 | 96 CVs | 31 |
| Amgad Ibrahim (B-118), CNS Upper Egypt | 93 CVs | 29 |

**Where they go instead — this half matters as much.** `managerApplicantBoards` builds one board per
OCCUPIED RSM/NSM seat, one folder per district beneath it, walking the WHOLE ancestor chain: an
Alex-BHR application reaches the Pedia regional manager AND the national one. Four boards live
(3 NSM + 1 RSM), 115 people, 450 placements. **Dropping the CVs without this half would be worse
than the bug** — a CV nobody can see reads as "nobody applied".

**Nothing is ever routed to the CEO**, so an application for a national sales manager's own seat
reaches no board at all and stays with Talent Acquisition. Two live CVs are in that state. That is
correct, not a gap.

**Two places the HAND-PUSH deliberately says yes where the folders say no** (`managerMayBeSentApplication`,
gating `sendCandidatesToManager`, which is the single door both notify-manager routes go through):
a head-office manager holding NO seat on the sales tree (Finance, HR, Training, the Product
Managers), and the CEO, who is in that picker on purpose. Both are the difference between a routing
rule firing and a person deciding. Measured: of 72 hand-pushes on record, 12 carried a
district-manager title and NONE went to a district manager — the gate refuses nothing that has
happened.

**⚠ Do NOT "fix" a district folder that now looks emptier.** Weaam's board going 96 → 31 is the rule
working. The 65 that left are on her national sales manager's board.

**⚠ An "Area Sales Manager" is a DISTRICT manager here**, not the seat above — the owner's own
correction of 2026-08-28, encoded in `candidateRoleFamily`. Only "Regional/Zone(al)" earns the RSM
rung. The ladder reads like a synonym at that one point and is not.

**Enforced mechanically**, not only behaviourally: `tests/recruitment-manager-seat-rank.test.ts`
runs in the required CI `validate` job, and pins both halves — a DM applicant reaching no district
board, and the push gate being applied BEFORE the notification (by order within the function, not a
byte window). Proved RED before green in both. Shipped in PR #3621, merge `0666c8a8e`, live in
production 2026-09-09.

Related: [[the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer]] ·
[[scope-runs-downward-only-never-your-own-manager]]
