import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  borrowableFields,
  canMergeCandidates,
  describeBorrowedFields,
  describeCopiedHistoryLine,
  isActiveApplicationStage,
  mergeBlockReason,
  mergeableFields,
  mergeScreeningExtraAnswers,
  splitRowsByExistingKey,
} from "../src/lib/recruitment/candidate-merge.ts";

/**
 * The same person arriving twice is the normal state of this pool — 337 CVs on WhatsApp, 211 by
 * email, and 132 of the 555 rows in production share a person with another row. The flag has always
 * been there; joining the two records back together has not.
 *
 * A merge deletes a row, so everything here is about what it is NOT allowed to do.
 */

const survivor = {
  email: "ahmed.hassan@example.com",
  fullName: "Ahmed Hassan",
  id: "survivor-1",
  phone: "+201001234567",
  university: "Cairo University",
  yearsExperience: 0,
};

const duplicate = {
  degree: "BSc Pharmacy",
  email: "ahmed.h@gmail.com",
  fullName: "Ahmed Hassan",
  id: "duplicate-1",
  nationalId: "29504121201234",
  phone: "   ",
  university: "Ain Shams University",
  whatsapp: "+201119998877",
  yearsExperience: 6,
};

export function runRecruitmentCandidateMergeTests() {
  // ── THE HEADLINE: a merge fills blanks and NOTHING else ──────────────────────────────────────
  // This is the property that makes a merge safe to press. A wrong merge adds facts to the wrong
  // person, which a recruiter can edit back; an overwriting merge destroys the surviving record's
  // own CV data, which nobody can. Every field the survivor already answered must be untouched —
  // including the ones the duplicate answers differently, and including a legitimate zero.
  const borrowed = borrowableFields(survivor, duplicate);
  const borrowedKeys = borrowed.map((field) => field.key);
  for (const held of ["email", "university", "yearsExperience"]) {
    assert.equal(
      borrowedKeys.includes(held as (typeof borrowedKeys)[number]),
      false,
      `a merge must never overwrite ${held} — the survivor already has a value there`,
    );
  }
  assert.deepEqual(borrowedKeys.sort(), ["degree", "nationalId", "whatsapp"]);

  // A whitespace-only value is a blank, not a fact: the duplicate's "   " phone must not land on
  // the survivor, and it must not count as something the survivor could borrow either.
  assert.equal(borrowedKeys.includes("phone" as (typeof borrowedKeys)[number]), false);
  const blankPhoneSurvivor = borrowableFields({ id: "a", phone: "  " }, { id: "b", phone: "+201009998888" });
  assert.deepEqual(
    blankPhoneSurvivor.map((field) => field.key),
    ["phone"],
    "a survivor holding only whitespace has a blank to fill",
  );

  // Values arrive trimmed, and every borrowed field names the column it writes to.
  const trimmed = borrowableFields({ id: "a" }, { degree: "  BSc Pharmacy  ", id: "b" });
  assert.equal(trimmed[0].value, "BSc Pharmacy");
  assert.equal(trimmed[0].column, "degree");
  const columns = new Set<string>(mergeableFields.map((field) => field.column));
  assert.equal(columns.size, mergeableFields.length, "two fields must never claim the same column");

  // ── The columns a merge is NOT allowed to borrow ─────────────────────────────────────────────
  // A borrowed status would silently reverse a decision somebody made, and a borrowed source would
  // claim the survivor arrived through a channel it did not.
  for (const forbidden of ["status", "status_note", "notes", "source", "created_by", "created_at"]) {
    assert.equal(columns.has(forbidden), false, `${forbidden} must never be borrowed from a duplicate`);
  }

  // ── Refusals ─────────────────────────────────────────────────────────────────────────────────
  const clean = { duplicate, duplicateApplications: [], survivor, survivorApplications: [] };
  assert.equal(mergeBlockReason(clean), null);
  assert.equal(canMergeCandidates(clean), true);

  assert.match(
    mergeBlockReason({ ...clean, duplicate: { ...duplicate, id: survivor.id } }) ?? "",
    /cannot be merged into itself/i,
  );
  assert.match(mergeBlockReason({ ...clean, survivor: null }) ?? "", /no longer exists/i);
  assert.match(mergeBlockReason({ ...clean, duplicate: null }) ?? "", /no longer exists/i);

  // Once the duplicate has become an employee its row is the evidence of that hire, so it cannot be
  // deleted out from under the employee record — by either route into "hired".
  for (const hired of [
    { requisitionId: "req-1", stage: "hired" },
    { convertedEmployeeHrId: "PH-0042", requisitionId: "req-1", stage: "offer_accepted" },
  ]) {
    assert.match(
      mergeBlockReason({ ...clean, duplicateApplications: [hired] }) ?? "",
      /already been hired/i,
      "a record that produced an employee must never be merged away",
    );
  }

  // recruitment_applications_active_uidx allows ONE live application per person per requisition.
  // Moving the duplicate's onto the survivor would be rejected by the database, so it is refused
  // here first — with the name of the opening, because "merge failed" tells nobody what to do.
  const collision = mergeBlockReason({
    ...clean,
    duplicateApplications: [{ requisitionId: "req-9", requisitionTitle: "Medical Representative", stage: "hr_interview" }],
    survivorApplications: [{ requisitionId: "req-9", requisitionTitle: "Medical Representative", stage: "cv_screening" }],
  });
  assert.match(collision ?? "", /Medical Representative/);
  assert.match(collision ?? "", /Withdraw or reject one of them first/i);

  // The same pair of applications is fine once either side is finished — that is precisely what the
  // index's WHERE clause excludes, so the guard has to agree with it stage for stage. "hired" is
  // the one member of that list this loop cannot use: it is refused earlier and for a stronger
  // reason, checked above.
  for (const finished of ["offer_declined", "offer_expired", "application_rejected", "application_withdrawn"]) {
    assert.equal(isActiveApplicationStage(finished), false, `${finished} is a finished application`);
    assert.equal(
      mergeBlockReason({
        ...clean,
        duplicateApplications: [{ requisitionId: "req-9", stage: finished }],
        survivorApplications: [{ requisitionId: "req-9", stage: "cv_screening" }],
      }),
      null,
      `a ${finished} application is outside the one-live-application rule and must not block a merge`,
    );
  }
  assert.equal(isActiveApplicationStage("hired"), false, "hired is a finished application");
  assert.equal(isActiveApplicationStage("cv_screening"), true);

  // A survivor who has already been hired is not the blocked case — merging a stray CV into an
  // employee's own record is exactly what a recruiter would want to do with it.
  assert.equal(
    mergeBlockReason({
      ...clean,
      survivorApplications: [{ convertedEmployeeHrId: "PH-0042", requisitionId: "req-9", stage: "hired" }],
    }),
    null,
    "only the record being DELETED is checked for a hire — the survivor keeps everything it has",
  );

  // Two applications against DIFFERENT openings never collide.
  assert.equal(
    mergeBlockReason({
      ...clean,
      duplicateApplications: [{ requisitionId: "req-2", stage: "cv_screening" }],
      survivorApplications: [{ requisitionId: "req-9", stage: "cv_screening" }],
    }),
    null,
  );

  // ── What the recruiter is told ───────────────────────────────────────────────────────────────
  assert.equal(describeBorrowedFields([]), "");
  assert.equal(describeBorrowedFields(borrowed), "national ID, WhatsApp number and degree");
  assert.equal(
    describeBorrowedFields(borrowableFields({ id: "a" }, { degree: "BSc", id: "b" })),
    "degree",
    "one borrowed field reads as itself, with no stray conjunction",
  );

  // ── The order the DB half must keep ──────────────────────────────────────────────────────────
  // None of this is visible to a pure test, and each line is something a later edit could reorder
  // without any test going red — so the ordering is pinned against the source itself.
  const service = readFileSync(new URL("../src/lib/recruitment/candidate-merge-service.ts", import.meta.url), "utf8");
  const childTables = service.slice(service.indexOf("const childTables"), service.indexOf("] as const"));
  assert.ok(
    childTables.indexOf("ats_applications") < childTables.indexOf("ats_files"),
    "applications must move FIRST — it is the only move the database can reject, and a refusal after the files have moved leaves the duplicate half-emptied",
  );
  // ── THE APPEND-ONLY TABLE: the move that could never have worked ─────────────────────────────
  // This assertion used to demand the OPPOSITE, and pinned the bug in place: `childTables` listed
  // ats_candidate_status_events on the reasoning that it has no foreign key, so a merge that did
  // not move it would orphan the duplicate's history. The foreign key half is true. The conclusion
  // was not — public.ats_candidate_status_events carries `ats_candidate_status_events_immutable`,
  // a BEFORE DELETE OR UPDATE row trigger raising `restrict_violation` for EVERY role, so the
  // UPDATE that "moves" a child row can never succeed there. Because the table sat LAST in the
  // list, the guaranteed failure landed after applications, files, extractions and intake events
  // had already moved: 2 of 23 production merges on 2026-09-04 left the duplicate holding 0 files
  // and 0 extractions, which reads to a recruiter as a candidate with no CV rather than as a merge
  // that stopped half-way.
  assert.equal(
    childTables.includes("ats_candidate_status_events"),
    false,
    "ats_candidate_status_events is append-only — an UPDATE of candidate_id raises restrict_violation for every role, so moving it in childTables can only ever fail, and it fails AFTER the other tables have moved",
  );
  const appendOnlyStart = service.indexOf("const appendOnlyChildTables");
  const appendOnly = service.slice(appendOnlyStart, service.indexOf("const linkedByOwnColumn", appendOnlyStart));
  assert.ok(
    appendOnlyStart > 0 && appendOnly.includes("ats_candidate_status_events"),
    "the duplicate's decision history still has to reach the survivor — as COPIES, since append is the only verb the table permits",
  );
  assert.ok(
    service.includes("await copyAppendOnlyRows("),
    "declaring the append-only list without walking it loses the duplicate's history entirely, which is worse than the failure it replaced",
  );

  // ── THE SECOND append-only table, missed by the first fix ────────────────────────────────────
  // ats_candidate_comments carries `ats_candidate_comments_no_update` — BEFORE UPDATE, refusing the
  // very same move with a different message ("delete and write a new comment instead"). The
  // 2026-09-04 fix moved status events out of childTables and left comments IN it, where it would
  // have failed in exactly the same way for any duplicate carrying a comment. Nothing in a
  // catalogue read found it: every check had been aimed at the table the incident named. Rehearsing
  // a whole merge on staging is what caught it.
  assert.equal(
    childTables.includes("ats_candidate_comments"),
    false,
    "ats_candidate_comments refuses an UPDATE too — moving it in childTables repeats the exact failure this file exists to prevent",
  );
  assert.ok(
    appendOnly.includes("ats_candidate_comments"),
    "a comment can only be copied onto the survivor, never re-pointed",
  );

  // The two append-only tables disagree about the ORIGINALS, and the disagreement is the whole
  // reason this is a flag rather than a constant. Status events refuse DELETE as firmly as UPDATE,
  // so their originals must stay. A comment CAN be deleted and has no foreign key, so its original
  // must go or it outlives the duplicate as an orphan. Getting either backwards fails: one throws,
  // the other leaks.
  const appendOnlyDescriptor = (table: string): string => {
    const at = appendOnly.indexOf(`table: "${table}"`);
    assert.notEqual(at, -1, `${table} is missing from appendOnlyChildTables`);
    return appendOnly.slice(appendOnly.lastIndexOf("canDeleteOriginals:", at), at);
  };

  assert.ok(
    appendOnlyDescriptor("ats_candidate_status_events").startsWith("canDeleteOriginals: false"),
    "ats_candidate_status_events refuses DELETE as firmly as UPDATE, so its originals must be left where they are",
  );
  assert.ok(
    appendOnlyDescriptor("ats_candidate_comments").startsWith("canDeleteOriginals: true"),
    "a comment has no foreign key to cascade it away, so leaving the original behind outlives the candidate as an orphan",
  );

  // ── The five tables a merge used to lose on delete ────────────────────────────────────────────
  // Each carries candidate_id and was in NEITHER list, so the duplicate's rows were destroyed by
  // the cascade (sends, district returns, views) or left orphaned with no foreign key at all
  // (comments, manager folders). A manager send is the evidence of who was actually shown a
  // candidate; losing it silently is not a tidy-up.
  const dedupedStart = service.indexOf("const dedupedChildTables");
  // Sliced to the next declaration rather than to a bracket: this list is not `as const`, so it
  // has no unique closing token of its own.
  const deduped = service.slice(dedupedStart, service.indexOf("const appendOnlyChildTables", dedupedStart));
  assert.ok(dedupedStart > 0, "dedupedChildTables must exist — four child tables are unique on (candidate_id, key)");
  for (const table of [
    "ats_candidate_manager_sends",
    "ats_candidate_district_returns",
    "ats_candidate_views",
    "ats_candidate_comments",
    "ats_candidate_manager_folders",
  ]) {
    assert.ok(
      childTables.includes(table) || deduped.includes(table) || appendOnly.includes(table),
      `${table} carries candidate_id, so a merge that never moves its rows loses them when the duplicate is deleted`,
    );
  }

  // ats_candidate_views HAS NO `id` COLUMN — its primary key IS (candidate_id, viewer_hr_id). The
  // plain reassign path selects "id" to count what moved, which answers 42703 there, so this table
  // could never simply be appended to childTables.
  assert.equal(
    childTables.includes("ats_candidate_views"),
    false,
    "ats_candidate_views has no id column, so the plain reassign path would answer 42703 on it",
  );
  assert.ok(
    deduped.includes("identityColumn: \"viewer_hr_id\""),
    "ats_candidate_views must be addressed by viewer_hr_id — it has no id column to name its rows by",
  );
  assert.equal(
    childTables.includes("ats_candidate_source_context"),
    false,
    "ats_candidate_source_context is a VIEW over ats_cv_intake_events — updating it would throw, and it follows that table on its own",
  );

  // ── The link a merge used to strand ──────────────────────────────────────────────────────────
  // The WhatsApp session points at the candidate through a column of its own naming, so it can
  // only travel on the second list: reassign writes `candidate_id`, which that table has not got.
  assert.equal(
    childTables.includes("ats_whatsapp_classification_sessions"),
    false,
    "the classification session links through applied_candidate_id, so reassign would try to write a candidate_id column that table does not have",
  );
  const linkedStart = service.indexOf("const linkedByOwnColumn");
  const linked = service.slice(linkedStart, service.indexOf("] as const", linkedStart));
  assert.ok(
    linked.includes("ats_whatsapp_classification_sessions") && linked.includes("applied_candidate_id"),
    "a merge that leaves applied_candidate_id on the deleted duplicate strands the applicant's own answers, and the session then reads as though they never applied at all",
  );
  // Existence first, and not as a formality: `indexOf` answers -1 for a loop that is not there, and
  // -1 is less than every real position — so the ordering assertion below passes on a merge that
  // repoints nothing at all. That is the exact bug being fixed here, and the first draft of this
  // test was green against it.
  const relinkLoopAt = service.indexOf("of linkedByOwnColumn");
  assert.ok(
    relinkLoopAt > 0 && service.includes("await relink("),
    "the merge never walks linkedByOwnColumn — declaring the list without acting on it leaves the session pointing at the row that was just deleted, which is the whole defect",
  );
  assert.ok(
    relinkLoopAt < service.indexOf("Step 6: the duplicate row itself"),
    "the session must be repointed BEFORE the duplicate is deleted — afterwards nothing can find it from either end",
  );
  assert.ok(
    service.indexOf(".delete().eq(\"id\", duplicateId)") < service.indexOf("borrowedPayload(borrowed)"),
    "the duplicate must be deleted BEFORE its email/national ID are written onto the survivor — both carry a partial UNIQUE index, so borrowing one while the duplicate still holds it is a 23505 every time. (phone_norm's unique index was dropped 2026-08-30 when phone stopped being an identity key, so phone alone would no longer conflict — the ordering is still required for the other two.)",
  );
  for (const norm of ["email_norm", "phone_norm", "national_id_norm"]) {
    assert.ok(
      service.includes(norm),
      `${norm} is maintained only in TypeScript, so a merge that writes the plain column without it leaves the survivor invisible to the dedup that would have caught the next copy`,
    );
  }
  assert.ok(
    service.includes("mergeScreeningExtraAnswers("),
    "the DB half stopped calling the pure screening-answers merge helper — it must not reimplement the union inline, where this test cannot see it",
  );

  // ── THE PHASE ORDER: everything refusable before anything that is not ────────────────────────
  // This is the property that makes a failed merge survivable. A merge is several round trips with
  // no transaction around them, so the question is never "can it fail" but "what does the duplicate
  // look like when it does". Every step the database could still reject has to happen while the
  // duplicate is still whole.
  const mergeAt = service.indexOf("export async function mergeCandidates");
  const dedupedLoopAt = service.indexOf("of dedupedChildTables", mergeAt);
  const childLoopAt = service.indexOf("of childTables", mergeAt);
  const copyAt = service.indexOf("await copyAppendOnlyRows(", mergeAt);
  const relinkAt = service.indexOf("of linkedByOwnColumn", mergeAt);
  const deleteAt = service.indexOf("Step 6: the duplicate row itself", mergeAt);
  // Existence first: indexOf answers -1 for a step that is not there, and -1 is less than every
  // real position, so an ordering assertion alone passes on a merge that skips the step entirely.
  for (const [label, at] of [
    ["the deduped move", dedupedLoopAt],
    ["the plain child move", childLoopAt],
    ["the append-only copy", copyAt],
    ["the relink", relinkAt],
    ["the delete", deleteAt],
  ] as const) {
    assert.ok(at > 0, `${label} is missing from mergeCandidates entirely`);
  }
  assert.ok(
    dedupedLoopAt < childLoopAt,
    "the deduped tables must move BEFORE the plain ones: their collision is predicted from a separate read of the survivor, so it is the only move left that can still race into a 23505 — and a throw there must not find the files and extractions already gone",
  );
  assert.ok(
    childLoopAt < copyAt,
    "the append-only copy is an INSERT and cannot be refused, so it belongs after every move that can be",
  );
  assert.ok(copyAt < relinkAt && relinkAt < deleteAt, "nothing may read the duplicate after it is deleted");

  // ── The collision split, exercised rather than grepped ───────────────────────────────────────
  // Four child tables are unique on (candidate_id, key). The same manager holding both records of
  // one person is ordinary — it is part of what makes them a duplicate — so a collision is a fact
  // to report, not an error to raise, and the SURVIVOR's own row is the one kept.
  const sends = [
    { id: "d1", manager_hr_id: "a-12" },
    { id: "d2", manager_hr_id: "b-10" },
  ];
  const split = splitRowsByExistingKey(sends, ["a-12"], (row) => row.manager_hr_id);
  assert.deepEqual(split.movable.map((row) => row.id), ["d2"]);
  assert.deepEqual(split.blocked.map((row) => row.id), ["d1"], "the survivor already has a-12, so the duplicate's send to a-12 cannot travel");

  // A null key cannot trip a unique index — NULLs never equal each other in one — so it always
  // moves. Getting this backwards would silently strand every row whose key happens to be blank.
  const nullKeyed = splitRowsByExistingKey([{ id: "n1", manager_hr_id: null }], ["a-12"], (row) => row.manager_hr_id);
  assert.deepEqual(nullKeyed.movable.map((row) => row.id), ["n1"]);
  assert.equal(nullKeyed.blocked.length, 0);

  // `keyOf` returning null is also how a PARTIAL index is honoured: ats_candidate_district_returns
  // is unique on (manager_hr_id, candidate_id) only WHERE status = 'open', so a resolved return
  // never collides even when the survivor holds an open one for that same manager.
  const returns = [
    { id: "r1", manager_hr_id: "a-12", status: "resolved" },
    { id: "r2", manager_hr_id: "a-12", status: "open" },
  ];
  const partial = splitRowsByExistingKey(
    returns,
    ["a-12"],
    (row) => (row.status === "open" ? row.manager_hr_id : null),
  );
  assert.deepEqual(partial.movable.map((row) => row.id), ["r1"], "a resolved return is outside the partial index and must still move");
  assert.deepEqual(partial.blocked.map((row) => row.id), ["r2"]);

  // The comparison is deliberately EXACT. HR ids in this database are mixed case, and the habit of
  // lowercasing both sides is right for a query and wrong here: the btree index compares raw bytes,
  // so case-folding would invent a collision the database would have allowed and drop a real row.
  const mixedCase = splitRowsByExistingKey([{ id: "m1", manager_hr_id: "A-12" }], ["a-12"], (row) => row.manager_hr_id);
  assert.deepEqual(
    mixedCase.movable.map((row) => row.id),
    ["m1"],
    "A-12 and a-12 are two different keys to the unique index, so the row moves — folding case here would silently drop it",
  );

  // ── What a copied history line says ──────────────────────────────────────────────────────────
  // A copy is indistinguishable from a decision somebody made on the survivor unless it says so.
  const copiedWithNote = describeCopiedHistoryLine({
    duplicateId: "369b306e-7de0-478b-8e0d-f183ce70f3f0",
    existingNote: "Sent to Saad Salama for Kafr El-Sheikh 1.",
    mergedOn: "2026-09-04",
    table: "ats_candidate_status_events",
  });
  assert.ok(copiedWithNote.startsWith("Sent to Saad Salama for Kafr El-Sheikh 1."), "the original note is kept in full — never replaced");
  assert.match(copiedWithNote, /\[Copied from duplicate record 70f3f0 when it was merged in on 2026-09-04\./);
  assert.match(copiedWithNote, /append-only/);
  // The duplicate is deleted by the time anyone reads this, so the label ties the line back to the
  // backup schema. Last six characters, matching the lines written by hand on 2026-09-04.
  const copiedBlank = describeCopiedHistoryLine({ duplicateId: "ab92cd29-5924-469b-a4b9-6dcd078f40f3", existingNote: null, mergedOn: "2026-09-04", table: "ats_candidate_status_events" });
  assert.ok(copiedBlank.startsWith("[Copied from duplicate record 8f40f3"), "a line that had no note is the provenance alone, with no stray leading space");

  // ── screening_extra_answers: the jsonb analogue of borrowableFields ─────────────────────────────
  // A jsonb bag of admin-growable keys does not fit mergeableFields' one-column-one-blank-check
  // shape, so it gets its own pure function. Same law as every scalar field: the SURVIVOR always
  // wins on a real collision, and the duplicate only ever fills a gap.
  assert.deepEqual(
    mergeScreeningExtraAnswers({}, {}),
    { changed: false, merged: {} },
    "two empty answer bags merge to nothing, and nothing changed",
  );

  const survivorOnly = mergeScreeningExtraAnswers({ has_license: "Yes" }, {});
  assert.deepEqual(survivorOnly, { changed: false, merged: { has_license: "Yes" } });

  const duplicateOnly = mergeScreeningExtraAnswers({}, { has_license: "No" });
  assert.deepEqual(
    duplicateOnly,
    { changed: true, merged: { has_license: "No" } },
    "the duplicate's own answer is the only one on file, so it must survive the merge",
  );

  // THE HEADLINE for this field, mirroring the scalar headline above: on a genuine collision the
  // SURVIVOR's answer is kept, never overwritten by the duplicate's — even though jsonb assignment
  // makes "last one wins" trivial to get backwards by writing `{...survivor, ...duplicate}` instead.
  const collidingAnswers = mergeScreeningExtraAnswers(
    { has_license: "Yes", preferred_shift: "Morning" },
    { has_license: "No", years_driving: "3" },
  );
  assert.deepEqual(
    collidingAnswers,
    { changed: true, merged: { has_license: "Yes", preferred_shift: "Morning", years_driving: "3" } },
    "a key both sides answered keeps the SURVIVOR's answer; a key only the duplicate answered is unioned in",
  );

  // Disjoint keys: the whole point of "union", not "the bigger bag wins".
  const disjoint = mergeScreeningExtraAnswers({ a: "1", b: "2" }, { c: "3", d: "4" });
  assert.deepEqual(disjoint, { changed: true, merged: { a: "1", b: "2", c: "3", d: "4" } });
}
