import assert from "node:assert/strict";

import {
  candidateCvTabLabels,
  candidateCvTabs,
  candidateRedFlagTitle,
  candidateRedFlagsFor,
  isRedFlaggedCandidate,
  partitionCandidatesByRedFlag,
} from "../src/lib/recruitment/red-flag.ts";

export function runRecruitmentRedFlagTests() {
  // --- THE SAFETY PROPERTY, and the reason this module exists as a function rather than as a
  // --- condition typed into two components. A red flag SORTS a CV into the other tab; it must
  // --- never be able to describe a candidate nobody has actually flagged. Blank is the state of
  // --- the large majority of the pool — nationality is absent on 216 of 226 production rows — so
  // --- a predicate that reads blank as foreign would move nearly the whole pool into the red tab
  // --- and the split would be worse than no split at all.
  assert.equal(isRedFlaggedCandidate({ nationality: null, status: "new" }), false);
  assert.equal(isRedFlaggedCandidate({ nationality: "", status: "new" }), false);
  assert.equal(isRedFlaggedCandidate({ nationality: "   ", status: "new" }), false);
  assert.equal(isRedFlaggedCandidate({}), false);
  assert.equal(isRedFlaggedCandidate(null), false);
  assert.equal(isRedFlaggedCandidate(undefined), false);

  // --- Ineligible under the Egyptian-nationals-only rule.
  assert.deepEqual(candidateRedFlagsFor({ nationality: "Sudanese", status: "new" }), ["not_egyptian"]);
  assert.deepEqual(candidateRedFlagsFor({ nationality: "Pakistani", status: "new" }), ["not_egyptian"]);

  // --- A dual national holding Egyptian nationality IS an Egyptian national, and every spelling of
  // --- it has to read as eligible. This is the half most likely to be "tidied" into an equality
  // --- check one day, which would move real hireable people into the red tab.
  for (const nationality of ["Egyptian", "egyptian", "Egyptian Arab Republic", "Egyptian / British", "مصري"]) {
    assert.equal(
      isRedFlaggedCandidate({ nationality, status: "new" }),
      false,
      `${nationality} must never be red-flagged`,
    );
  }

  // --- Rejected, whatever the nationality says.
  assert.deepEqual(candidateRedFlagsFor({ nationality: "Egyptian", status: "rejected" }), ["rejected"]);
  assert.deepEqual(candidateRedFlagsFor({ nationality: null, status: "rejected" }), ["rejected"]);

  // --- Both reasons at once, ineligibility first — it is the one no decision can undo.
  assert.deepEqual(candidateRedFlagsFor({ nationality: "Syrian", status: "rejected" }), [
    "not_egyptian",
    "rejected",
  ]);

  // --- What is deliberately NOT red, because both were argued over on the screens themselves:
  // --- every non-terminal status, and a file the reader judged not to be a CV. "Not a CV" is amber
  // --- on the row on purpose — nothing is wrong with the person, the attachment is a certificate —
  // --- so folding it in here would quietly contradict the pill beside it.
  for (const status of ["new", "shortlisted", "sent_to_manager", "hired"]) {
    assert.equal(isRedFlaggedCandidate({ nationality: "Egyptian", status }), false, `${status} must not be red`);
  }
  assert.equal(isRedFlaggedCandidate({ nationality: null, status: "new" }), false);

  // --- A legacy free-text status resolves to null rather than being guessed at, so it is NOT red
  // --- by status. Production carried exactly one such row — the handwritten sentence
  // --- "Not Eligible — Non-Egyptian (Dubai, UAE)" — and it is red anyway, through the column that
  // --- actually records the fact. That is the point: the flag reads recorded data, never prose.
  assert.equal(isRedFlaggedCandidate({ nationality: null, status: "Not Eligible — Non-Egyptian (Dubai, UAE)" }), false);
  assert.deepEqual(
    candidateRedFlagsFor({ nationality: "Emirati", status: "Not Eligible — Non-Egyptian (Dubai, UAE)" }),
    ["not_egyptian"],
  );
  // --- 'Candidate Created' is the pre-2026-08-15 database default that every inbound CV received.
  // --- It normalizes to `new`, and must never read as a decision anybody made.
  assert.equal(isRedFlaggedCandidate({ nationality: "Egyptian", status: "Candidate Created" }), false);

  // --- The explanation shown on hover. Empty when there is nothing to explain, so a caller can
  // --- render it unconditionally; and it must NAME the stated nationality, because "this CV is
  // --- red" with no reason is what a recruiter overrules by reflex.
  assert.equal(candidateRedFlagTitle({ nationality: "Egyptian", status: "new" }), "");
  const title = candidateRedFlagTitle({ nationality: "Sudanese", status: "rejected" });
  assert.ok(title.includes("Sudanese"), "the title must name the stated nationality");
  assert.ok(title.toLowerCase().includes("rejected"), "the title must say the candidate was rejected");

  // --- THE PARTITION, which is what the two tabs actually render. Every candidate must land in
  // --- exactly one pile and NONE may be dropped: this replaced a single list, so a row lost here
  // --- is a CV that has silently disappeared from the module with no error anywhere.
  const pool = [
    { id: "a", nationality: "Egyptian", status: "new" },
    { id: "b", nationality: "Sudanese", status: "new" },
    { id: "c", nationality: null, status: "rejected" },
    { id: "d", nationality: "", status: "shortlisted" },
    { id: "e", nationality: "Syrian", status: "rejected" },
    { id: "f", nationality: null, status: "sent_to_manager" },
  ];
  const split = partitionCandidatesByRedFlag(pool);
  assert.deepEqual(
    split.active.map((row) => row.id),
    ["a", "d", "f"],
  );
  assert.deepEqual(
    split.red.map((row) => row.id),
    ["b", "c", "e"],
  );
  assert.equal(
    split.active.length + split.red.length,
    pool.length,
    "every candidate must survive the split — a lost row is a CV that vanished from the pool",
  );

  // --- Order is preserved inside each pile. The pool sorts newest-first and the screening queue
  // --- sorts by band; both apply their own ordering AROUND this call, so a partition that
  // --- reshuffled would silently override the sort the reader was promised.
  assert.deepEqual(
    partitionCandidatesByRedFlag([
      { id: "3", nationality: null, status: "new" },
      { id: "2", nationality: "Sudanese", status: "new" },
      { id: "1", nationality: null, status: "new" },
    ]).active.map((row) => row.id),
    ["3", "1"],
  );

  // --- An empty pool gives two empty piles, never undefined. Both tabs render their count even at
  // --- zero, and `counts[tab]` reading undefined would print nothing where a 0 belongs.
  const empty = partitionCandidatesByRedFlag([]);
  assert.deepEqual(empty.active, []);
  assert.deepEqual(empty.red, []);

  // --- Both tabs must be nameable. A missing label renders an empty button, which reads as a
  // --- broken tab rather than as a missing string.
  assert.deepEqual([...candidateCvTabs], ["active", "red"]);
  for (const tab of candidateCvTabs) {
    assert.ok(candidateCvTabLabels[tab].length > 0, `${tab} needs a label`);
  }
}
