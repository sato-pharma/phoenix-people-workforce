import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DUPLICATE_FOLDER_KEY,
  DUPLICATE_FOLDER_KIND,
  isFiledCandidate,
  isShelvedFromReview,
  type ReviewQueueCandidate,
} from "../src/lib/recruitment/candidate-folder.ts";

/**
 * THE 371 LOST CVs. Measured on production 2026-09-18, and the reason this file exists.
 *
 * The owner's report, in his own words: "i cannot reach what i want cvs lost never up to date zero
 * functionality at the end of the day". The arithmetic behind it:
 *
 *   1,121 candidates on the record
 *     704 offered by the screening page
 *     417 filed to a folder, and therefore absent from it
 *     371 of those 417 still `status = 'new'` — undecided, unread, unreachable
 *
 * Unreachable is the strong word and it is the measured one: a real applicant filed to the Sohag1
 * shelf on 15 September could not be found on that page by name, and its full-text CV search
 * answered "0 CVs mention" for her. The page's own counters understated to match — "New CVs 252"
 * against 624 people nobody had decided on.
 *
 * ── WHY THE FIX IS NOT "STOP HIDING FILED CVs" ───────────────────────────────────────────────────
 *
 * The shelf is the owner's own design and it works: "if this CV is good, but I'm not needing it now,
 * I push the CV to the folder", and "the CV that I push to a folder ... it is not appearing now on
 * the main page". That is a decision he made about CVs he had READ. Filing in practice runs the
 * other way round — a CV arrives on WhatsApp, its declared area files it to a position shelf the
 * same evening, and it leaves the review queue before any human has opened it.
 *
 * So the queue asks a narrower question than the pool does: a filed CV was off the SCREENING queue
 * once a DECISION existed on it, and since 2026-10-19 no shelf takes it off at all — the decision
 * tabs keep a decided CV out of "Not decided yet", which is the "not appearing again" he asked for,
 * and the old exclusion hid it from the tab it was decided into (section 2). Every
 * other filed-CV surface — the pool, the CV database, the folder tab, the folder suggestions —
 * keeps asking `isFiledCandidate` and is deliberately untouched by this.
 *
 * THE DUPLICATE ARCHIVE IS EXEMPT AND MUST STAY EXEMPT. Archiving a duplicate is a discard of a
 * redundant record, not a good CV parked for a seat, so it is out of the queue whatever its status
 * says. That is the one case where "undecided" must NOT bring a row back.
 */

/** A candidate carrying only what the review queue reads off one. */
function row(
  folder: { kind: string; key: string } | null,
  status: string | null = "new",
  cvFolderIds: readonly string[] | null = null,
): ReviewQueueCandidate {
  return {
    cvFolderIds,
    folder: folder ? { ...folder, filedAt: "2026-09-15T17:34:00.000Z", filedByHrId: "B-10" } : null,
    status,
  } as unknown as ReviewQueueCandidate;
}

const shelved = (candidate: ReviewQueueCandidate | null | undefined) => isShelvedFromReview(candidate);

export async function runScreeningFiledPoolTests() {
  // ── 1 · AN UNDECIDED FILED CV IS STILL IN THE QUEUE ─────────────────────────────────────────
  //
  // The headline assertion. This is Rahma Mamdouh Ahmed's row: created 15 September, filed to
  // medical_rep / Sohag1 the same afternoon, never opened, never decided, and invisible on the
  // screening page until this predicate existed.
  assert.equal(
    shelved(row({ key: "Sohag1", kind: "medical_rep" }, "new")),
    false,
    "an undecided CV on a position shelf must stay in the screening queue — 371 of these were lost",
  );
  // A HAND-BUILT FOLDER IS THE OPPOSITE CASE, by the owner's own answer on 2026-09-18. A shelf is
  // filled by the system the evening a CV arrives; a folder in his tree is only ever somebody's own
  // act, and he chose that a CV he moves there ("Archive") appears ONLY inside that folder — so the
  // screening page stays clean and a new CV is easy to see. Undecided or not, it is off the queue.
  for (const status of ["new", null, "shortlisted", "rejected"]) {
    assert.equal(
      shelved(row(null, status, ["folder-archive"])),
      true,
      `a ${JSON.stringify(status)} CV moved into a hand-built folder is off the screening queue`,
    );
  }
  assert.equal(
    shelved(row({ key: "Sohag1", kind: "medical_rep" }, "new", ["folder-archive"])),
    true,
    "on a shelf AND in a hand-built folder: the folder wins, because a person put it there",
  );

  // A STATUS THE VOCABULARY CANNOT READ LEAVES THE CV VISIBLE. `normalizeCandidateStatus` answers
  // null for anything that is neither one of the five codes nor a mapped legacy value, and this is
  // the one function where that must not hide a person — see isShelvedFromReview for why it parts
  // company with `isUnreviewedCandidateStatus` here. "Candidate created" is the one legacy value
  // that IS mapped, and it maps to new: it was the database default every inbound CV received.
  for (const status of [null, "", "  ", "Candidate Created", "screening", "interview", "a handwritten sentence"]) {
    assert.equal(
      shelved(row({ key: "Nasr City", kind: "medical_rep" }, status)),
      false,
      `status ${JSON.stringify(status)} is not a decision, so the CV stays in the queue`,
    );
  }

  // ── 2 · A DECIDED CV ON A SHELF STAYS TOO — on the tab its decision names ───────────────────
  //
  // Until 2026-10-19 a decision took a shelved CV off this page, which made sense before the decision
  // tabs and made none after them: the page opens on "Not decided yet", so the CV is already out of
  // the way, and the exclusion only took it out of the pile it had been decided INTO. 11 of the 19 CVs
  // shortlisted in the three days to 19 Oct sat on a District Manager, Medical Rep or Other shelf and
  // could not be found under Shortlisted — "when i filter on the shortlisted i donot find what i
  // short listed".
  for (const status of ["shortlisted", "backup", "rejected", "sent_to_manager", "hired"]) {
    assert.equal(
      shelved(row({ key: "Sohag1", kind: "medical_rep" }, status)),
      false,
      `a ${status} CV on a shelf must stay on Screening, under its own decision tab`,
    );
  }
  for (const kind of ["district_manager", "other", "paramedical"]) {
    assert.equal(
      shelved(row({ key: "Nasr City", kind }, "shortlisted")),
      false,
      `a CV shortlisted on the ${kind} shelf must be findable under Shortlisted`,
    );
  }

  // ── 3 · THE DUPLICATE ARCHIVE IS OUT WHATEVER ITS STATUS ────────────────────────────────────
  //
  // The one exemption, and the reason this is not simply "filed AND decided". An archived duplicate
  // is a discarded record; bringing the undecided ones back would refill the queue with exactly the
  // rows somebody archived to get rid of. Its pool behaviour is pinned separately in
  // tests/candidate-folders.test.ts and is untouched here.
  assert.equal(
    shelved(row({ key: DUPLICATE_FOLDER_KEY, kind: DUPLICATE_FOLDER_KIND }, "new")),
    true,
    "an UNDECIDED archived duplicate must NOT come back — a discard is not a CV parked for a seat",
  );
  assert.equal(shelved(row({ key: DUPLICATE_FOLDER_KEY, kind: DUPLICATE_FOLDER_KIND }, "rejected")), true);

  // ── 4 · AN UNFILED CV IS ALWAYS IN THE QUEUE, decided or not ────────────────────────────────
  //
  // Nothing about this change may narrow the queue. A decided CV that was never filed stays exactly
  // where it was: the piles themselves (screening-queues.ts) are what separate new from decided.
  assert.equal(shelved(row(null, "new")), false);
  assert.equal(shelved(row(null, "rejected")), false, "a decision alone must never hide a CV — only FILING does");
  assert.equal(shelved(row(null, "hired")), false);
  assert.equal(shelved(null), false);
  assert.equal(shelved(undefined), false);
  assert.equal(
    shelved(row(null, "rejected", [])),
    false,
    "an empty folder list is not filed — the direction that shows a person rather than losing one",
  );

  // THE TWO PREDICATES ARE DIFFERENT QUESTIONS, and the difference is the whole fix. If these ever
  // agree on this row again, 371 CVs have gone back into hiding.
  const undecidedOnAShelf = row({ key: "Sohag1", kind: "medical_rep" }, "new");
  assert.equal(isFiledCandidate(undecidedOnAShelf), true, "it IS filed — the pool and the folder tab are right to hide it");
  assert.equal(
    isShelvedFromReview(undecidedOnAShelf),
    false,
    "…and it is NOT off the review queue, which is a different question",
  );

  // ── 5 · THE LOADER ASKS THIS PREDICATE, not the pool's one ──────────────────────────────────
  //
  // A behavioural test cannot reach `loadScreeningWorkspace` — it opens a service-role Supabase
  // client on import. So the wiring is pinned at the source, which is the convention this module
  // already uses (tests/candidate-folders.test.ts reads recruitment-workspace.tsx the same way).
  // Without this, the predicate above can be perfect and the page still hide 371 people.
  const loader = readFileSync(
    fileURLToPath(new URL("../src/lib/recruitment/screening-workspace.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    loader,
    /const reviewPool = allCandidates\.filter\(\(candidate\) => !isShelvedFromReview\(candidate\)\)/,
    "the screening pool must be built from isShelvedFromReview — !isFiledCandidate is what lost the 371",
  );
  assert.doesNotMatch(loader, /!isFiledCandidate\(/, "and no filter in this loader may go back to the pool's predicate");
  assert.match(
    loader,
    /unread: reviewPool\.filter/,
    "the unread counter must count the same pool the page shows — it read 252 against a true 624",
  );

  // ── 6 · A ROW THAT REJOINED THE QUEUE SAYS WHERE IT IS FILED ────────────────────────────────
  //
  // A CV that silently rejoins the pile is indistinguishable from one that was never filed, and the
  // reader loses the one fact that explains why it is there. Names, never a folder key or an id —
  // the owner's standing rule.
  assert.match(loader, /folderLabel: filedLabelFor\(candidate\)/, "every row must carry where it is filed");
  assert.match(
    loader,
    /candidateFolderLabel\(folder\.kind, folder\.key\)/,
    "…resolved through the shared label function, so the words match the folder screens",
  );

  const types = readFileSync(
    fileURLToPath(new URL("../src/lib/recruitment/screening-workspace-types.ts", import.meta.url)),
    "utf8",
  );
  assert.match(types, /folderLabel: string \| null;/, "and the row type must declare it");

  const list = readFileSync(
    fileURLToPath(
      new URL("../src/components/recruitment/workstation/workstation-candidate-list.tsx", import.meta.url),
    ),
    "utf8",
  );
  assert.match(
    list,
    /Boolean\(row\.folderLabel && !row\.seatReason\) \|\|/,
    "the badge line must open for a row whose ONLY meta is the folder — otherwise the pill never paints",
  );
  assert.match(
    list,
    /\{row\.folderLabel && !row\.seatReason \? \(/,
    "…and the pill itself must render, dropped in seat mode where the seat sentence already says it",
  );
}
