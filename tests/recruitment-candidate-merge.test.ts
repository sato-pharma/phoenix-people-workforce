import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  borrowableFields,
  canMergeCandidates,
  describeBorrowedFields,
  isActiveApplicationStage,
  mergeBlockReason,
  mergeableFields,
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
  assert.ok(
    childTables.includes("ats_candidate_status_events"),
    "ats_candidate_status_events has NO foreign key onto ats_candidates, so a merge that does not move it silently orphans the duplicate's decision history",
  );
  assert.equal(
    childTables.includes("ats_candidate_source_context"),
    false,
    "ats_candidate_source_context is a VIEW over ats_cv_intake_events — updating it would throw, and it follows that table on its own",
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
}
