// Recruitment / ATS — the DB half of a candidate merge (rules: candidate-merge.ts).
//
// Kept apart from candidate-merge.ts so the refusal rules stay unit testable without a Supabase
// client, the same split as contact-review / contact-review-service.

import type { AccessContext } from "@/lib/auth/permissions";
import { canReviewCandidateContacts } from "@/lib/recruitment/access";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import {
  normalizeEmail,
  normalizeNationalId,
  normalizePhone,
} from "@/lib/recruitment/candidate-matching";
import {
  borrowableFields,
  describeBorrowedFields,
  describeCopiedHistoryLine,
  mergeBlockReason,
  mergeScreeningExtraAnswers,
  splitRowsByExistingKey,
  type BorrowedField,
  type MergeApplicationFacts,
} from "@/lib/recruitment/candidate-merge";
import { getCandidate } from "@/lib/recruitment/candidates";
import { mapCandidate, recruitmentDb, type CandidateDbRow } from "@/lib/recruitment/db";
import { mirrorCandidateCvsToDrive } from "@/lib/recruitment/drive-cv-mirror";
import { logError } from "@/lib/observability/log";
import type { Candidate } from "@/lib/recruitment/types";
import { fetchAllRows } from "@/lib/supabase/paginated";

export type CandidateMergeResult = {
  borrowedFields: string[];
  candidate: Candidate;
  /** History lines AND comments: both are copied, because neither can be re-pointed. */
  copiedAppendOnlyRows: number;
  duplicateName: string;
  /** What could not travel, in the recruiter's words. Empty on a clean merge. */
  leftBehind: string[];
  movedApplications: number;
  movedFiles: number;
  /** Booked interviews carried onto the survivor. Reported because a human already promised one. */
  movedInterviews: number;
  summary: string;
};

/**
 * Every table whose rows a merge simply re-points at the survivor, in the order it must move them.
 *
 * `ats_applications` goes FIRST on purpose. It is the only one here carrying a unique constraint
 * (`recruitment_applications_active_uidx`, one live application per person per requisition), so it
 * is the only move in this list that can be rejected by the database. Moving it before anything
 * else means a refusal we failed to predict leaves the duplicate whole rather than half-emptied.
 *
 * Two kinds of table are deliberately NOT here, each with its own list below, because an UPDATE of
 * `candidate_id` is the wrong verb for them:
 *
 *  - `dedupedChildTables` — unique on `(candidate_id, something)`, so a blind move can be refused.
 *  - `appendOnlyChildTables` — `ats_candidate_status_events`, where an UPDATE can NEVER succeed.
 *
 * `ats_candidate_source_context` is NOT here and must never be added — it is a VIEW over
 * `ats_cv_intake_events`, so it follows that table automatically.
 *
 * ── `ats_interview_bookings` — THE BOOKED INTERVIEW, ADDED 2026-09-27 ──────────────────────────
 *
 * It carries `candidate_id` with `ON DELETE CASCADE` and sat in none of the three lists, so a merge
 * DELETED the duplicate's booked interview. Silently: a cascade is not a refusal, so nothing was
 * reported and nothing was left behind to notice. The 2026-09-04 pass that rescued the five tables
 * below missed this one.
 *
 * And it is the likeliest row of all to be on the duplicate rather than the survivor, because
 * booking an interview is what CREATED these duplicates: `createInterviewBooking` makes a candidate
 * for an outside person, so the record a recruiter merges away is precisely the one holding the
 * interview. Measured on production 2026-09-27, all three byte-identical-CV duplicate pairs were one
 * intake record with 0 bookings and one calendar record with exactly 1 — merging the calendar record
 * away, which is the direction the owner chose on the Norhan Gamal Hamed pair, would have destroyed
 * three booked interviews and told nobody.
 *
 * Safe as a plain reassign: the only UNIQUE index on the table is its primary key on `id`, so
 * moving `candidate_id` cannot collide, and two interviews for one person is an ordinary state.
 */
const childTables = [
  "ats_applications",
  "ats_interview_bookings",
  "ats_files",
  "ats_candidate_cv_extractions",
  "ats_cv_intake_events",
] as const;

/** One unique-constrained child table, and how to move its rows safely. */
type DedupedChildTable = {
  /** The column naming the exact rows to move. `id` everywhere except ats_candidate_views. */
  identityColumn: string;
  /** The column the unique INDEX is on, alongside candidate_id. */
  keyColumn: string;
  /** Set when the unique index is PARTIAL; rows outside the predicate can never collide. */
  onlyWhen: { column: string; value: string } | null;
  /** True when the table has NO foreign key, so a blocked row would outlive the duplicate. */
  orphansOnDelete: boolean;
  plural: string;
  singular: string;
  table: string;
};

/**
 * The child tables that are UNIQUE on `(candidate_id, <key>)`, so moving a row can be refused.
 *
 * A collision here is ordinary rather than exceptional — the same manager being sent both records
 * of one person is exactly what makes them a duplicate — so the merge predicts it instead of
 * letting the database raise a 23505 half-way through. `splitRowsByExistingKey` decides; the
 * survivor's own row always wins, and the duplicate's is reported to the recruiter and then left to
 * die with the delete.
 *
 * `keyColumn` must name the column the unique INDEX is actually on, which is not always the
 * obvious one: `ats_candidate_manager_folders` is unique on `manager_hr_id_norm`, not on the
 * `manager_hr_id` sitting beside it.
 *
 * `identityColumn` is how the movable rows are then named in the UPDATE. It is `id` everywhere
 * except `ats_candidate_views`, which HAS NO `id` COLUMN AT ALL — its primary key is
 * `(candidate_id, viewer_hr_id)`. Selecting `id` there answers 42703, which is why that table
 * cannot simply be appended to `childTables` above.
 *
 * ── ONE CHILD TABLE IS DELIBERATELY IN NONE OF THE THREE LISTS ─────────────────────────────────
 *
 * `ats_candidate_call_actions` — the manager's "I will call" / "Skip" — is not registered anywhere
 * here, and that is a decision rather than an omission. It carries TWO unique indexes, not one:
 * (candidate_id, manager_hr_id) and a PARTIAL one on (candidate_id) where action = 'will_call',
 * which is what keeps a reservation single across every manager. This shape models one index per
 * table, so a survivor claimed by manager A and a duplicate claimed by manager B would move cleanly
 * past the first index and raise 23505 on the second, HALF WAY THROUGH a merge that has already
 * moved the other tables.
 *
 * So its rows are left to the foreign key, which cascades them away with the duplicate. The loss is
 * bounded and fails in the safe direction: a claim that disappears leaves the CV unreserved with its
 * phone number hidden from everybody, which is where every CV starts, and a skip that disappears
 * puts one CV back in one manager's folder. Both are one press to redo. Reserving the survivor to
 * the wrong manager, or failing a live merge outright, are the two outcomes this avoids.
 */
const dedupedChildTables: readonly DedupedChildTable[] = [
  {
    identityColumn: "id",
    keyColumn: "manager_hr_id",
    onlyWhen: null,
    orphansOnDelete: false,
    plural: "manager sends",
    singular: "manager send",
    table: "ats_candidate_manager_sends",
  },
  {
    identityColumn: "id",
    keyColumn: "manager_hr_id_norm",
    onlyWhen: null,
    // No foreign key, so a row left pointing at the duplicate survives the delete as an orphan
    // rather than cascading away. Blocked rows here are removed by hand below.
    orphansOnDelete: true,
    plural: "manager filings",
    singular: "manager filing",
    table: "ats_candidate_manager_folders",
  },
  {
    identityColumn: "id",
    keyColumn: "manager_hr_id",
    // `ats_candidate_district_returns_open_unique` is PARTIAL — it constrains open rows only, so a
    // resolved return never collides and always travels.
    onlyWhen: { column: "status", value: "open" },
    orphansOnDelete: false,
    plural: "district returns",
    singular: "district return",
    table: "ats_candidate_district_returns",
  },
  {
    identityColumn: "viewer_hr_id",
    keyColumn: "viewer_hr_id",
    onlyWhen: null,
    orphansOnDelete: false,
    plural: "view markers",
    singular: "view marker",
    table: "ats_candidate_views",
  },
  {
    identityColumn: "id",
    keyColumn: "folder_id",
    onlyWhen: null,
    // Unique on (folder_id, candidate_id) and, by design, no foreign key — a filing must never block a
    // candidate delete. Unlisted, the duplicate's filings survived every merge as ghosts: the folder
    // counted a CV nobody could open, and the survivor was missing from a folder the recruiter had put
    // them in (audit, 2026-09-12). A folder BOTH records sit in keeps the survivor's row; the
    // duplicate's is removed below.
    orphansOnDelete: true,
    plural: "folder filings",
    singular: "folder filing",
    table: "ats_cv_folder_items",
  },
];

/** One table whose rows may only be copied, never re-pointed. */
type AppendOnlyChildTable = {
  /**
   * Whether the duplicate's originals can be removed once copied.
   *
   * This is the ONE thing the two tables disagree about, and getting it wrong fails in opposite
   * directions: deleting where it is forbidden throws, and NOT deleting where it is allowed leaves
   * orphans behind, since neither table has a foreign key to cascade them away.
   */
  canDeleteOriginals: boolean;
  /** The columns carried over verbatim, so a copy sits in history where it actually happened. */
  columns: string[];
  /** The free-text column the provenance note is appended to. */
  noteColumn: string;
  plural: string;
  singular: string;
  table: string;
};

/**
 * Tables a merge may only ever APPEND to, so their rows are copied rather than moved.
 *
 * Both refuse an UPDATE of `candidate_id` outright, and BOTH were reached the hard way:
 *
 *  - `ats_candidate_status_events` carries `ats_candidate_status_events_immutable`, a
 *    BEFORE DELETE OR UPDATE row trigger raising `restrict_violation` for every role, plus a
 *    TRUNCATE guard. It sat in `childTables` — and LAST — until 2026-09-04, so its guaranteed
 *    failure landed after the files, extractions and intake events had already moved. Two of
 *    twenty-three production merges stopped there, each leaving the duplicate an empty shell that
 *    reads as "a candidate with no CV" rather than as a merge that stopped half-way.
 *  - `ats_candidate_comments` carries `ats_candidate_comments_no_update`, which refuses the same
 *    UPDATE with a different message ("delete and write a new comment instead"). The 2026-09-04 fix
 *    for the first table left this one in `childTables`, where it would have failed in EXACTLY the
 *    same way for any duplicate carrying a comment. Caught by rehearsing a full merge on staging,
 *    which is the only step that would have caught it: every catalogue read had been about the
 *    table the incident named.
 *
 * A trigger sweep across every child table of `ats_candidates` confirms these two are the whole
 * set — no other one carries a trigger at all.
 *
 * They differ on the originals. Status events cannot be deleted either, so the duplicate's rows
 * stay behind pointing at a candidate that no longer exists — not a leak to tidy up later, but an
 * append-only audit table keeping its own history, which is what was asked for. A comment CAN be
 * deleted, and has no foreign key, so its original must be removed or it outlives the duplicate as
 * an orphan.
 */
const appendOnlyChildTables: readonly AppendOnlyChildTable[] = [
  {
    canDeleteOriginals: false,
    columns: ["actor_hr_id", "created_at", "from_status", "note", "to_status"],
    noteColumn: "note",
    plural: "history lines",
    singular: "history line",
    table: "ats_candidate_status_events",
  },
  {
    canDeleteOriginals: true,
    columns: ["author_hr_id", "author_job_title", "author_name", "body", "created_at"],
    noteColumn: "body",
    plural: "comments",
    singular: "comment",
    table: "ats_candidate_comments",
  },
];

/**
 * Rows that point at a candidate through a column of their OWN naming, which `reassign` cannot
 * move — it keys every child on `candidate_id`.
 *
 * The WhatsApp classification session is the only one today, and it is deliberately not in
 * `childTables` above: it is not a child record. It outlives the merge, it holds the applicant's
 * own answers, and `applied_candidate_id` is the note saying which record those answers were
 * written onto. Left pointing at the deleted duplicate it says they went somewhere that no longer
 * exists, so anything resolving a conversation back to a candidate finds nothing — which reads as
 * "this applicant never applied", not as a broken link. Two sessions were found in exactly that
 * state in production on 2026-09-02, both stranded by a merge run minutes earlier.
 *
 * Keep this list BELOW childTables: recruitment-candidate-merge.test.ts slices childTables to the
 * first `] as const` in the file, so a second one above it silently empties what that test reads.
 */
const linkedByOwnColumn = [
  { column: "applied_candidate_id", table: "ats_whatsapp_classification_sessions" },
] as const;

type ApplicationScopeRow = {
  candidate_id: unknown;
  converted_employee_hr_id?: unknown;
  requisition_id: unknown;
  stage: unknown;
};

/** Both candidates' applications, with the job title of the opening each one is against. */
async function loadApplicationFacts(candidateIds: readonly string[]): Promise<Map<string, MergeApplicationFacts[]>> {
  const byCandidate = new Map<string, MergeApplicationFacts[]>();
  for (const id of candidateIds) byCandidate.set(id, []);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .select("candidate_id,converted_employee_hr_id,requisition_id,stage")
    .in("candidate_id", [...candidateIds]);
  if (error) throw error;

  const rows = (data ?? []) as ApplicationScopeRow[];
  const requisitionIds = [...new Set(rows.map((row) => String(row.requisition_id ?? "")).filter(Boolean))];
  const titles = new Map<string, string>();
  if (requisitionIds.length > 0) {
    const { data: requisitions, error: requisitionError } = await supabase
      .from("ats_requisitions")
      .select("id,job_title")
      .in("id", requisitionIds);
    if (requisitionError) throw requisitionError;
    for (const row of (requisitions ?? []) as { id: unknown; job_title: unknown }[]) {
      titles.set(String(row.id ?? ""), String(row.job_title ?? ""));
    }
  }

  for (const row of rows) {
    const candidateId = String(row.candidate_id ?? "");
    const bucket = byCandidate.get(candidateId);
    if (!bucket) continue;
    const requisitionId = String(row.requisition_id ?? "");
    bucket.push({
      convertedEmployeeHrId: row.converted_employee_hr_id ? String(row.converted_employee_hr_id) : null,
      requisitionId,
      requisitionTitle: titles.get(requisitionId) ?? null,
      stage: String(row.stage ?? ""),
    });
  }
  return byCandidate;
}

/** Points one table's rows at the survivor. Returns how many rows moved. */
async function reassign(table: string, fromCandidateId: string, toCandidateId: string): Promise<number> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(table)
    .update({ candidate_id: toCandidateId })
    .eq("candidate_id", fromCandidateId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * Repoints one table's own candidate column at the survivor. Returns how many rows moved.
 *
 * Separate from `reassign` rather than a parameter on it: that one moves CHILD rows, whose whole
 * existence belongs to the candidate, and this one repairs a reference held by a record that
 * stands on its own. Same UPDATE, different meaning — and a merge that confused the two would
 * either miss this link or try to write `candidate_id` onto a table that has no such column.
 */
async function relink(
  table: string,
  column: string,
  fromCandidateId: string,
  toCandidateId: string,
): Promise<number> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(table)
    .update({ [column]: toCandidateId })
    .eq(column, fromCandidateId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** PostgREST answers an over-long `.in()` with ZERO rows and no error, so filters are chunked. */
function chunk<T>(items: readonly T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

type DedupedMoveOutcome = {
  blocked: number;
  moved: number;
};

/**
 * Moves what can move from a table that is UNIQUE on `(candidate_id, key)`.
 *
 * The survivor's own rows are read first and the duplicate's are split against them, so a
 * collision is decided here rather than raised by the database part-way through the merge. The
 * survivor always keeps its own row: it is the record being kept, and its send or view marker is
 * the one already referred to elsewhere.
 */
async function moveDeduped(
  spec: DedupedChildTable,
  fromCandidateId: string,
  toCandidateId: string,
): Promise<DedupedMoveOutcome> {
  const supabase = recruitmentDb();
  const columns = [...new Set([spec.identityColumn, spec.keyColumn, ...(spec.onlyWhen ? [spec.onlyWhen.column] : [])])];

  // Every row of the candidate, paged to a short page by the table's own unique column. The split
  // below decides what moves and what is blocked, so a row cut off by the response cap would be
  // neither moved nor compared against the survivor's.
  const read = (candidateId: string) =>
    fetchAllRows<Record<string, unknown>>(
      () => supabase.from(spec.table).select(columns.join(",")).eq("candidate_id", candidateId),
      spec.identityColumn,
    );
  const [duplicateRows, survivorRows] = await Promise.all([read(fromCandidateId), read(toCandidateId)]);

  // A row outside a PARTIAL index's predicate is unconstrained, so it reports no key and always
  // moves — on BOTH sides, or a resolved return on the survivor would block an open one.
  const keyOf = (row: Record<string, unknown>): string | null => {
    if (spec.onlyWhen && String(row[spec.onlyWhen.column] ?? "") !== spec.onlyWhen.value) return null;
    const key = row[spec.keyColumn];
    return key === null || key === undefined ? null : String(key);
  };

  const { blocked, movable } = splitRowsByExistingKey(duplicateRows, survivorRows.map(keyOf), keyOf);

  let moved = 0;
  for (const batch of chunk(movable.map((row) => String(row[spec.identityColumn])))) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from(spec.table)
      .update({ candidate_id: toCandidateId })
      .eq("candidate_id", fromCandidateId)
      .in(spec.identityColumn, batch)
      .select(spec.identityColumn);
    if (error) throw error;
    moved += (data ?? []).length;
  }

  // Without a foreign key nothing cleans a blocked row up, and it would sit in the table pointing
  // at a candidate that no longer exists. The survivor already holds the equivalent row.
  if (spec.orphansOnDelete && blocked.length > 0) {
    for (const batch of chunk(blocked.map((row) => String(row[spec.identityColumn])))) {
      const { error } = await supabase
        .from(spec.table)
        .delete()
        .eq("candidate_id", fromCandidateId)
        .in(spec.identityColumn, batch);
      if (error) throw error;
    }
  }

  return { blocked: blocked.length, moved };
}

/**
 * Copies an append-only table's rows onto the survivor. Returns how many rows were copied.
 *
 * Every declared column is carried over verbatim so a copy sits in the survivor's history at the
 * moment it actually happened, rather than bunching at the merge. Only the note column is touched,
 * to say where the row came from — see `describeCopiedHistoryLine`.
 */
async function copyAppendOnlyRows(
  spec: AppendOnlyChildTable,
  fromCandidateId: string,
  toCandidateId: string,
  mergedOn: string,
): Promise<number> {
  const supabase = recruitmentDb();
  // Every row, paged to a short page: the originals are DELETED below with one filter on the
  // candidate, so a read cut off by the response cap would delete rows that were never copied.
  const rows = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from(spec.table)
        .select(spec.columns.join(","))
        .eq("candidate_id", fromCandidateId)
        .order("created_at", { ascending: true }),
    "id",
  );
  if (rows.length === 0) return 0;

  const copies = rows.map((row) => {
    const copy: Record<string, unknown> = { candidate_id: toCandidateId };
    for (const column of spec.columns) copy[column] = row[column] ?? null;
    const existing = row[spec.noteColumn];
    copy[spec.noteColumn] = describeCopiedHistoryLine({
      duplicateId: fromCandidateId,
      existingNote: existing === null || existing === undefined ? null : String(existing),
      mergedOn,
      table: spec.table,
    });
    return copy;
  });

  const { data: inserted, error: insertError } = await supabase.from(spec.table).insert(copies).select("id");
  if (insertError) throw insertError;

  // Only where the table allows it. ats_candidate_status_events refuses a DELETE as firmly as an
  // UPDATE, so its originals stay; a comment can be deleted and has no foreign key, so leaving it
  // would strand it on a candidate that no longer exists.
  if (spec.canDeleteOriginals) {
    const { error: deleteError } = await supabase.from(spec.table).delete().eq("candidate_id", fromCandidateId);
    if (deleteError) throw deleteError;
  }

  return (inserted ?? []).length;
}

/** Today in Cairo, as the recruiter would write it. */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * Joins a duplicate candidate record into the one being kept, then deletes the duplicate.
 *
 * The order is what makes this safe to interrupt. EVERY step the database could still refuse comes
 * before every step it cannot, so a refusal nobody predicted leaves the duplicate looking like a
 * whole candidate rather than an empty shell:
 *
 *  1. refuse outright if the merge cannot complete (candidate-merge.ts decides);
 *  2. move the deduped tables — the only moves whose collision is predicted from a separate read
 *     and could therefore still race, and the cheapest ones to have moved if a later step throws;
 *  3. move every plain child row — applications first, see childTables;
 *  4. copy the append-only history, which can only ever be appended to;
 *  5. repoint the records that link by a column of their own naming;
 *  6. delete the duplicate;
 *  7. only THEN fill the survivor's blanks from the values captured in step 1.
 *
 * Steps 2 and 4 are where this went wrong before 2026-09-04, and the shape of that failure is why
 * the ordering is spelled out here. `ats_candidate_status_events` sat LAST in `childTables` and was
 * moved with an UPDATE its immutability trigger refuses unconditionally — so the one step that
 * could never succeed ran after the files, the CV extractions and the intake events had already
 * moved. Two of twenty-three production merges stopped there, leaving a duplicate with 0 files and
 * 0 extractions that reads to a recruiter as "a candidate with no CV", not as a merge that failed.
 *
 * Step 7 comes last because `national_id` and `email` each carry a partial UNIQUE index (phone's
 * was dropped 2026-08-30, when phone stopped being an identity key).
 * Writing the duplicate's email onto the survivor while the duplicate still holds it is a 23505,
 * every time — the value has to be freed before it can be borrowed.
 */
export async function mergeCandidates(
  access: AccessContext,
  input: { duplicateId: string; survivorId: string },
): Promise<CandidateMergeResult> {
  // A merge writes the two columns dedupe itself is decided on (email_norm / phone_norm), so it is
  // gated on who may work the pipeline — the same authority as the contact review, not the broader
  // read gate. It is deliberately NOT Super Admin only: duplicates are Talent Acquisition's daily
  // problem, and a merge nobody with the problem can run is a merge that never happens.
  if (!canReviewCandidateContacts(access)) {
    throw new Error("Forbidden: only the Super Admin can merge candidate records.");
  }

  const survivorId = String(input.survivorId ?? "").trim();
  const duplicateId = String(input.duplicateId ?? "").trim();
  if (!survivorId || !duplicateId) throw new Error("Both the candidate to keep and the duplicate are required.");

  const [survivor, duplicate] = await Promise.all([getCandidate(survivorId), getCandidate(duplicateId)]);
  const applications = await loadApplicationFacts([survivorId, duplicateId]);

  const blocked = mergeBlockReason({
    duplicate,
    duplicateApplications: applications.get(duplicateId) ?? [],
    survivor,
    survivorApplications: applications.get(survivorId) ?? [],
  });
  if (blocked) throw new Error(blocked);
  if (!survivor || !duplicate) throw new Error("Candidate not found.");

  // Captured BEFORE the duplicate is deleted — after step 3 there is nothing left to read.
  const borrowed = borrowableFields(survivor, duplicate);
  // TWO DIFFERENT OFFER LETTERS CANNOT BOTH SURVIVE ONE MERGE, and this is the one skipped field
  // that has to be said out loud. `borrowableFields` fills a blank and steps over a collision, which
  // is the right rule for every fact on a CV — those can be re-read from the document. An offer
  // letter is joined to a person by this pointer and by nothing else, so a silent skip leaves a real
  // letter, in Offers, pointed at from nowhere. The letter itself is untouched; what is lost is the
  // only thread back to it, and only a human can say which of the two stands.
  const strandedOffer =
    Boolean(duplicate.offerId) && Boolean(survivor.offerId) && duplicate.offerId !== survivor.offerId;
  const { changed: extraAnswersChanged, merged: mergedExtraAnswers } = mergeScreeningExtraAnswers(
    survivor.screeningExtraAnswers,
    duplicate.screeningExtraAnswers,
  );
  // 40% of full_name holds a whole forwarded-mail envelope, so the stored value is not the name —
  // candidateDisplayName is what turns it back into one.
  const duplicateName = candidateDisplayName(duplicate.fullName) || "this duplicate record";

  // Step 2 — see the ordering note above. These run before the plain moves precisely because their
  // collision is a prediction: it is read from the survivor a moment earlier, so it can race.
  const blockedDeduped: { count: number; plural: string; singular: string }[] = [];
  const leftBehind: string[] = [];
  const movedDeduped: { count: number; plural: string; singular: string }[] = [];
  for (const spec of dedupedChildTables) {
    const { blocked, moved } = await moveDeduped(spec, duplicateId, survivorId);
    if (moved > 0) movedDeduped.push({ count: moved, plural: spec.plural, singular: spec.singular });
    if (blocked > 0) {
      blockedDeduped.push({ count: blocked, plural: spec.plural, singular: spec.singular });
      leftBehind.push(
        `${countedNoun(blocked, spec.singular, spec.plural)} could not move across — the record being `
        + `kept already had its own, so ${blocked === 1 ? "it was" : "they were"} dropped.`,
      );
    }
  }

  // Step 3.
  let movedApplications = 0;
  let movedFiles = 0;
  let movedInterviews = 0;
  for (const table of childTables) {
    const moved = await reassign(table, duplicateId, survivorId);
    if (table === "ats_applications") movedApplications = moved;
    if (table === "ats_files") movedFiles = moved;
    // Counted and reported, not merely moved. An interview is the one thing on a merged record that
    // a human has already promised to another human, so the recruiter has to be told which record
    // it now sits on — a silent move would leave them looking for it on the row that is gone.
    if (table === "ats_interview_bookings") movedInterviews = moved;
  }

  // Step 4. An INSERT is the only verb these tables permit, so their rows are copied, not moved —
  // and the summary says "copied" for exactly that reason.
  const mergedOn = cairoToday();
  const copied: { count: number; plural: string; singular: string }[] = [];
  let copiedAppendOnlyRows = 0;
  for (const spec of appendOnlyChildTables) {
    const count = await copyAppendOnlyRows(spec, duplicateId, survivorId, mergedOn);
    copiedAppendOnlyRows += count;
    if (count > 0) copied.push({ count, plural: spec.plural, singular: spec.singular });
  }

  // Step 5, before the delete, for the same reason the child rows move first: once the duplicate is
  // gone, a row still pointing at it cannot be found from either end.
  for (const link of linkedByOwnColumn) {
    await relink(link.table, link.column, duplicateId, survivorId);
  }

  // Step 6: the duplicate row itself. Every step that could be refused has already run, so reaching
  // here means the delete is the only thing left that can fail.
  const supabase = recruitmentDb();
  const { error: deleteError } = await supabase.from("ats_candidates").delete().eq("id", duplicateId);
  if (deleteError) throw deleteError;

  let merged = survivor;
  if (borrowed.length > 0 || extraAnswersChanged) {
    const payload: Record<string, unknown> = { ...borrowedPayload(borrowed) };
    if (extraAnswersChanged) payload.screening_extra_answers = mergedExtraAnswers;
    const { data, error } = await supabase
      .from("ats_candidates")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", survivorId)
      .select("*")
      .single();
    if (error) throw error;
    merged = mapCandidate(data as CandidateDbRow);
  }

  const summary = buildSummary({
    blockedDeduped,
    borrowed,
    copied,
    duplicateName,
    extraAnswersChanged,
    movedApplications,
    movedDeduped,
    movedFiles,
    movedInterviews,
    strandedOffer,
  });
  await recordMergeEvent({
    actorHrId: access.hrId ?? null,
    candidateId: survivorId,
    note: summary,
    status: merged.status,
  });

  // Step 8 — RE-FILE THE CABINET, because a merge is the one event that changes a CV's NAME without
  // ever touching the CV.
  //
  // A mirrored file is called `<person> - <number>.<ext>` and nothing else, and `copyLabelsFor` adds
  // an arrival-date label ONLY when one candidate holds more than one CV. Both records held one each
  // a moment ago, so both files sit in Drive under the plain name — and now that they are siblings on
  // one record, both names are wrong in the same way: identical, in one folder, with nothing to tell
  // a recruiter which document is which. The FOLDER can move too, since `cabinetPathFor` reads the
  // surviving record's answers and the duplicate's are gone.
  //
  // Measured on production 2026-09-21, after 19 merges: NINE folders were left holding two different
  // documents under one file name. Re-running the mirror renamed every one. Nothing else in the
  // system would have done it — the file rows are never written to again, so no later intake or
  // classification event revisits them, and the wrong name stays until somebody notices by hand.
  //
  // IT CANNOT FAIL THE MERGE. `mirrorCandidateCvsToDrive` logs and swallows its own errors, and the
  // database work above is already committed: a Drive outage must not turn a finished merge into an
  // exception the caller reads as "nothing happened".
  await mirrorCandidateCvsToDrive(survivorId);

  return {
    borrowedFields: borrowed.map((field) => field.label),
    candidate: merged,
    copiedAppendOnlyRows,
    duplicateName,
    leftBehind,
    movedApplications,
    movedFiles,
    movedInterviews,
    summary,
  };
}

/**
 * The borrowed values as columns — plus the `_norm` twin of each of the three identity columns.
 *
 * Nothing in the database maintains those: `candidatePayload`/`updateCandidatePayload` recompute
 * them in TypeScript on every write. A merge that set `email` without `email_norm` would leave the
 * survivor findable by a recruiter and invisible to dedup, which is how the duplicate got created.
 */
function borrowedPayload(borrowed: readonly BorrowedField[]): Record<string, string | number | null> {
  const payload: Record<string, string | number | null> = {};
  for (const field of borrowed) {
    payload[field.column] = field.value;
    if (field.key === "email") payload.email_norm = normalizeEmail(String(field.value));
    if (field.key === "phone") payload.phone_norm = normalizePhone(String(field.value));
    if (field.key === "nationalId") payload.national_id_norm = normalizeNationalId(String(field.value));
  }
  return payload;
}

/** "1 file" / "3 files" — the count is always shown, because "some" is not an answer. */
function countedNoun(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/** "a", "a and b", "a, b and c" — the house list, matching describeBorrowedFields. */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function buildSummary(input: {
  blockedDeduped: readonly { count: number; plural: string; singular: string }[];
  borrowed: readonly BorrowedField[];
  copied: readonly { count: number; plural: string; singular: string }[];
  duplicateName: string;
  extraAnswersChanged: boolean;
  movedApplications: number;
  movedDeduped: readonly { count: number; plural: string; singular: string }[];
  movedFiles: number;
  movedInterviews: number;
  strandedOffer: boolean;
}): string {
  const parts: string[] = [`Merged the duplicate record for ${input.duplicateName}.`];
  const moved: string[] = [];
  // Interviews lead the list: of everything a merge moves, the booked interview is the only row a
  // person is already expecting to happen, so it is the one the recruiter must see first.
  if (input.movedInterviews > 0) {
    moved.push(countedNoun(input.movedInterviews, "booked interview", "booked interviews"));
  }
  if (input.movedFiles > 0) moved.push(countedNoun(input.movedFiles, "file", "files"));
  if (input.movedApplications > 0) {
    moved.push(countedNoun(input.movedApplications, "application", "applications"));
  }
  for (const entry of input.movedDeduped) moved.push(countedNoun(entry.count, entry.singular, entry.plural));
  if (moved.length > 0) parts.push(`Moved ${listPhrase(moved)} across.`);
  if (input.copied.length > 0) {
    const copied = input.copied.map((entry) => countedNoun(entry.count, entry.singular, entry.plural));
    parts.push(
      `Copied ${listPhrase(copied)} onto this record — those are append-only, so the rows are copied `
      + "rather than moved.",
    );
  }
  const filledIn: string[] = [];
  if (input.borrowed.length > 0) filledIn.push(describeBorrowedFields(input.borrowed));
  if (input.extraAnswersChanged) filledIn.push("screening question answers");
  parts.push(filledIn.length > 0 ? `Filled in the ${listPhrase(filledIn)}.` : "Nothing was missing here, so no details changed.");
  // Last, and never omitted: a merge that dropped something has to say so on the one line the
  // recruiter is shown, or a partial merge is indistinguishable from a clean one. Grouped into ONE
  // sentence rather than one per table — three tables collide together far more often than any one
  // does alone, and three near-identical sentences in a row read as a stutter, not as three facts.
  if (input.blockedDeduped.length > 0) {
    const dropped = input.blockedDeduped.map((entry) => countedNoun(entry.count, entry.singular, entry.plural));
    const total = input.blockedDeduped.reduce((sum, entry) => sum + entry.count, 0);
    parts.push(
      `${listPhrase(dropped)} could not move across — the record being kept already had its own, so `
      + `${total === 1 ? "it was" : "they were"} dropped.`,
    );
  }
  // Said in full rather than counted, because it is one fact about one person and the recruiter has
  // to be able to act on it without opening anything: which letter stands is a decision, and this
  // sentence is the only place the question ever gets asked.
  if (input.strandedOffer) {
    parts.push(
      "The duplicate record pointed at a DIFFERENT job offer letter, and the record being kept "
      + "already had one of its own, so the letter itself is untouched in Offers but nothing points "
      + "at it from here any more. Re-link it on this record if it is the offer that stands.",
    );
  }
  return parts.join(" ");
}

/**
 * One line on the survivor's decision history saying what was joined into it.
 *
 * Best effort, and for the same reason updateCandidateStatus writes its own event that way: the
 * merge has already happened by this point and cannot be undone by throwing. A missing history
 * line is a gap; reporting a completed merge as a failure would invite a second click, and the
 * second click would refuse because the duplicate is already gone.
 */
async function recordMergeEvent(input: {
  actorHrId: string | null;
  candidateId: string;
  note: string;
  status: string;
}): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_candidate_status_events").insert({
    actor_hr_id: input.actorHrId,
    candidate_id: input.candidateId,
    // The status did not move — this line is here for its note. Writing the same value on both
    // sides keeps it out of any "changed from X to Y" reading of the history.
    from_status: input.status,
    note: input.note,
    to_status: input.status,
  });
  if (error) {
    logError("Candidates merged but the history line could not be written", {
      error,
      labels: {
        candidate_id: input.candidateId,
        event: "candidate_merge_event_write_failed",
      },
    });
  }
}
