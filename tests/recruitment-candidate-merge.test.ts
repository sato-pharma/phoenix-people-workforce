import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

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
import { copyLabelsFor, withCopyLabel } from "../src/lib/recruitment/cv-duplicate-copies.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The body of the LATEST migration that defines phx_merge_ats_candidates, comments stripped. Every
 * write of a merge moved into that one function on 2026-11-13, so the ordering pins below read it.
 */
function mergeFunctionSql(): string {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  for (let at = files.length - 1; at >= 0; at -= 1) {
    const sql = readFileSync(new URL(files[at], dir), "utf8");
    if (/create or replace function public\.phx_merge_ats_candidates\(/i.test(sql)) return stripSqlComments(sql).toLowerCase();
  }
  throw new Error("no migration defines public.phx_merge_ats_candidates");
}

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
  const mergeSql = mergeFunctionSql();
  assert.ok(
    mergeSql.includes("insert into public.ats_candidate_status_events"),
    "declaring the append-only list without copying it loses the duplicate's history entirely, which is worse than the failure it replaced",
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
    // The sixth, found on 2026-09-27 and missed by the pass that rescued the other five.
    "ats_interview_bookings",
  ]) {
    assert.ok(
      childTables.includes(table) || deduped.includes(table) || appendOnly.includes(table),
      `${table} carries candidate_id, so a merge that never moves its rows loses them when the duplicate is deleted`,
    );
  }

  // ── The booked interview ──────────────────────────────────────────────────────────────────────
  // `ats_interview_bookings.candidate_id` is ON DELETE CASCADE, so a merge that did not move it
  // DESTROYED the interview — and a cascade is not a refusal, so nothing was reported and nothing
  // was left behind to notice. It is also the row most likely to be on the duplicate rather than the
  // survivor, because booking an interview is what creates these duplicates in the first place:
  // `createInterviewBooking` makes a candidate for an outside person. Measured on production
  // 2026-09-27, all three byte-identical-CV pairs were one intake record with 0 bookings and one
  // calendar record with exactly 1. Merging the calendar record away — the direction the owner chose
  // on the Norhan Gamal Hamed pair — would have deleted three promised interviews in silence.
  assert.ok(
    childTables.includes("ats_interview_bookings"),
    "ats_interview_bookings must be in childTables — its candidate_id cascades on delete, so a merge that does not move it destroys a booked interview and reports nothing",
  );
  // It belongs on the PLAIN list and nowhere else: its only UNIQUE index is the primary key on `id`,
  // so a blind reassign cannot collide, and two interviews for one person is an ordinary state.
  assert.equal(
    deduped.includes("ats_interview_bookings"),
    false,
    "ats_interview_bookings is not unique on (candidate_id, anything) — treating it as deduped would drop a real interview as a predicted collision",
  );
  assert.equal(
    appendOnly.includes("ats_interview_bookings"),
    false,
    "a booking accepts an UPDATE, so copying it would leave the duplicate's own interview to die with the row",
  );
  // And the recruiter is TOLD. A moved interview that nobody mentions leaves a human looking for it
  // on the record that no longer exists.
  assert.ok(
    /if \(table === "ats_interview_bookings"\) movedInterviews = moved;/.test(service),
    "the merge must count the interviews it moved, or the summary cannot report them",
  );
  assert.ok(
    /movedInterviews: number;/.test(service),
    "CandidateMergeResult must carry movedInterviews so a caller can show it",
  );
  assert.ok(
    /countedNoun\(input\.movedInterviews, "booked interview", "booked interviews"\)/.test(service),
    "the summary must name the booked interview in the recruiter's words, never leave the move silent",
  );

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
  const relinkSqlAt = mergeSql.search(/update public\.ats_whatsapp_classification_sessions\s+set applied_candidate_id = p_survivor_id/);
  const deleteSqlAt = mergeSql.indexOf("delete from public.ats_candidates where id = p_duplicate_id");
  const borrowSqlAt = mergeSql.indexOf("update public.ats_candidates c set");
  assert.ok(
    relinkSqlAt > 0,
    "the merge never repoints applied_candidate_id — declaring the list without acting on it leaves the session pointing at the row that was just deleted, which is the whole defect",
  );
  assert.ok(
    deleteSqlAt > 0 && relinkSqlAt < deleteSqlAt,
    "the session must be repointed BEFORE the duplicate is deleted — afterwards nothing can find it from either end",
  );
  assert.ok(
    borrowSqlAt > 0 && deleteSqlAt < borrowSqlAt,
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
  // This was the property that made a failed merge survivable while a merge was several round trips
  // with no transaction around them. Since 2026-11-13 the steps run inside ONE SQL function
  // (phx_merge_ats_candidates), so a failure rolls all of them back — the order is still pinned,
  // because it is also what keeps a borrowed email from colliding, and it costs nothing to keep.
  const dedupedLoopAt = mergeSql.indexOf("update public.ats_candidate_manager_sends");
  const childLoopAt = mergeSql.indexOf("update public.ats_applications set candidate_id");
  const copyAt = mergeSql.indexOf("insert into public.ats_candidate_status_events");
  const relinkAt = relinkSqlAt;
  const deleteAt = deleteSqlAt;
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

/**
 * A MERGE MUST RE-FILE THE CABINET.
 *
 * The one event that changes a CV's NAME in Drive without ever touching the CV. Both records held
 * one CV each a moment before, so `copyLabelsFor` gave each the empty label and each file sits in
 * Drive under the plain `<person> - <number>.<ext>`. The instant they become siblings on one record
 * the right answer changes for BOTH — and nothing re-asks, because a file row is never written to
 * again and no later intake or classification event revisits it.
 *
 * Measured on production 2026-09-21, after 19 merges: NINE folders were left holding two different
 * documents under one file name, with nothing to tell a recruiter which was which. Re-running the
 * mirror renamed every one.
 */
export function runCandidateMergeRefilesTheCabinetTests() {
  const service = readFileSync(new URL("../src/lib/recruitment/candidate-merge-service.ts", import.meta.url), "utf8");

  // ── THE BEHAVIOUR, not the wiring ────────────────────────────────────────────────────────────
  // Why the re-file is needed at all, proved on the function that decides the name. Before the
  // merge each record holds one CV, so each file keeps the plain name; after it, one record holds
  // both and each needs a label. This is the assertion that goes red if the cabinet ever stops
  // disambiguating, which would make step 8 pointless rather than merely absent.
  const survivorCv = { content_md5: "aaa", created_at: "2026-09-14T05:52:12.663Z", id: "cv-survivor" };
  const duplicateCv = { content_md5: "bbb", created_at: "2026-09-19T18:03:57.287Z", id: "cv-duplicate" };
  const plainName = "Reham Raafat Sayed - 201128799086.pdf";

  assert.equal(
    copyLabelsFor([survivorCv]).get("cv-survivor"),
    "",
    "a record holding one CV keeps the plain name — that is why both files are identically named the moment they meet",
  );
  assert.equal(copyLabelsFor([duplicateCv]).get("cv-duplicate"), "");
  assert.equal(withCopyLabel(plainName, ""), plainName);

  const afterMerge = copyLabelsFor([survivorCv, duplicateCv]);
  const names = [
    withCopyLabel(plainName, afterMerge.get("cv-survivor") ?? ""),
    withCopyLabel(plainName, afterMerge.get("cv-duplicate") ?? ""),
  ];
  assert.equal(
    new Set(names).size,
    2,
    "once merged, the two CVs must no longer wear the same name in the same folder — this is the defect step 8 exists to clear",
  );
  for (const name of names) {
    assert.notEqual(name, plainName, "each merged sibling must gain a label, not just one of the pair");
    assert.ok(name.endsWith(".pdf"), "the label goes in the stem — a name ending in '(date)' is not a PDF to Drive");
  }

  // Both CVs arrived on DIFFERENT days here, so the date alone separates them. The awkward case —
  // two CVs on one day — is what the counter exists for, and it must still produce two names.
  const sameDay = copyLabelsFor([
    { content_md5: "ccc", created_at: "2026-09-19T00:35:11.000Z", id: "cv-a" },
    { content_md5: "ddd", created_at: "2026-09-19T00:36:22.000Z", id: "cv-b" },
  ]);
  assert.equal(
    new Set([
      withCopyLabel(plainName, sameDay.get("cv-a") ?? ""),
      withCopyLabel(plainName, sameDay.get("cv-b") ?? ""),
    ]).size,
    2,
    "two CVs merged in on ONE day still need two distinct names — a date alone would collide",
  );

  // ── THE WIRING ───────────────────────────────────────────────────────────────────────────────
  // Read from the service source, which is weaker than calling it: `mergeCandidates` reaches
  // `recruitmentDb()` and `getSupabaseAdmin()` directly, with no seam to hand a fake Drive to. What
  // the source CAN prove is the two things that were actually wrong — the call was absent, and
  // where it sits decides whether it reads the merged state or the stale one.
  assert.ok(
    service.includes("await mirrorCvs(survivorId)") && service.includes("deps.mirrorCvs ?? mirrorCandidateCvsToDrive"),
    "a merge must re-file the surviving record's CVs in the cabinet — without this the two files keep one name",
  );
  assert.ok(
    service.includes('import { mirrorCandidateCvsToDrive } from "@/lib/recruitment/drive-cv-mirror"'),
    "the mirror must be imported, not reached for through a dynamic require",
  );

  // AFTER the duplicate is gone, or it mirrors the state it was called to fix. `cabinetPathFor`
  // reads the SURVIVING record's answers and `copyLabelsFor` reads its CV siblings — run this while
  // the duplicate still owns half of them and it re-files against the pre-merge shape, writing names
  // that are wrong in a new way instead of the old one.
  // The duplicate is deleted inside the merge function, so "after the delete" is "after the RPC".
  const deleteAt = service.indexOf("supabase.rpc(MERGE_CANDIDATES_RPC");
  const mirrorAt = service.indexOf("await mirrorCvs(survivorId)");
  assert.ok(deleteAt > 0 && mirrorAt > 0);
  assert.ok(
    mirrorAt > deleteAt,
    "the re-file must run AFTER the duplicate row is deleted and its CVs have moved — earlier and it files the pre-merge shape",
  );

  // It must not be the last thing that can THROW. The database work is committed by then, and a
  // Drive outage turning a finished merge into an exception is how a caller learns "nothing
  // happened" about a merge that entirely happened. `mirrorCandidateCvsToDrive` swallows its own
  // errors — this pins that it is still the swallowing entry point and not `mirrorCvToDrive`.
  const mirrorSource = readFileSync(new URL("../src/lib/recruitment/drive-cv-mirror.ts", import.meta.url), "utf8");
  const entry = mirrorSource.slice(mirrorSource.indexOf("export async function mirrorCandidateCvsToDrive"));
  assert.ok(
    entry.slice(0, entry.indexOf("\n}\n")).includes("catch (error)"),
    "the merge relies on the candidate-level mirror swallowing its own errors — if that stops being true the merge needs its own catch",
  );
}
