import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AuditLogInput } from "../src/lib/admin/audit.ts";
import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import { deleteWeeklyBatch, retagWeeklyBatch } from "../src/lib/sales/weekly/service.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * A DELETED OR RE-TAGGED WEEKLY UPLOAD SAYS WHO DID IT, WHEN, AND WHICH UPLOAD IT WAS.
 *
 * Measured on production 2026-09-17: `weekly_sales_batches` carries no trigger, and deleting a batch
 * takes every row it stored with it (`weekly_sales_rows_batch_id_fkey`, ON DELETE CASCADE). The
 * service deleted the row and wrote nothing, so once a weekly upload was gone nothing said it had
 * ever existed, let alone who removed it; a re-tag moved a sheet to another week just as silently.
 * The audit row is now that record. For a delete it has to carry the before-image, because
 * afterwards there is nothing left to read.
 *
 * The real functions run against the in-memory fixture with column projection ON, so a SELECT
 * narrowed later drops its field from the audit row here exactly as it would in production.
 *
 * NOTHING HERE MAY REACH A REAL DATABASE. The suite runs with production credentials, so both
 * functions are handed the fixture client AND a recording audit writer. The batch ids are
 * deliberately not UUIDs: if the injection seam is ever dropped, the first real query fails on the
 * uuid cast before any upload, or any audit row, can be touched.
 */

const BATCH_ID = "weekly-batch-ibn-sina-week-2";
const OTHER_BATCH_ID = "weekly-batch-ramco-week-1";
const MISSING_BATCH_ID = "weekly-batch-that-was-never-uploaded";

function seededClient(options: { failOn?: Record<string, string> } = {}) {
  return fakeSupabaseClient(
    {
      weekly_sales_batches: [
        {
          id: BATCH_ID,
          distributor_code: "IS",
          distributor_name: "Ibn Sina",
          template_key: "IS",
          file_name: "Ibn Sina weekly 2026-09-08.xlsx",
          sheet_name: "Sales",
          week_start: "2026-09-08",
          cycle_month: "2026-09-01",
          week_number: 2,
          status: "validated",
          total_rows: 812,
          importable_rows: 812,
          failed_rows: 0,
          warning_rows: 3,
          total_sales_qty: 5130,
          total_return_qty: 40,
          total_net_qty: 5090,
          total_bonus_qty: 12,
          total_sales_value: 418250.75,
          total_stock_qty: 9120,
          blocking_reasons: [],
          // Uploaded by one person and removed by another, so the actor can never be read off
          // the upload by mistake.
          uploaded_by: "A-2",
          column_contract_source: "code",
          created_at: "2026-09-16T08:40:26.432059+00:00",
          updated_at: "2026-09-16T08:40:26.432059+00:00",
        },
        {
          id: OTHER_BATCH_ID,
          distributor_code: "RM",
          distributor_name: "RAMCO",
          template_key: "RM",
          file_name: "RAMCO 2026-09-01.xlsx",
          sheet_name: "Sales",
          week_start: "2026-09-01",
          cycle_month: "2026-09-01",
          week_number: 1,
          status: "validated",
          total_rows: 240,
          importable_rows: 240,
          failed_rows: 0,
          warning_rows: 0,
          total_sales_qty: 1200,
          total_return_qty: 0,
          total_net_qty: 1200,
          total_bonus_qty: 0,
          total_sales_value: 96000,
          total_stock_qty: 3000,
          blocking_reasons: [],
          uploaded_by: "B-10",
          column_contract_source: "code",
          created_at: "2026-09-02T10:00:00+00:00",
          updated_at: "2026-09-02T10:00:00+00:00",
        },
      ],
      weekly_sales_rows: [
        { id: "row-1", batch_id: BATCH_ID, cycle_month: "2026-09-01", week_number: 2 },
        { id: "row-2", batch_id: BATCH_ID, cycle_month: "2026-09-01", week_number: 2 },
        { id: "row-3", batch_id: OTHER_BATCH_ID, cycle_month: "2026-09-01", week_number: 1 },
      ],
    },
    { failOn: options.failOn, projectColumns: true },
  );
}

function recordingAuditWriter() {
  const written: AuditLogInput[] = [];
  return {
    written,
    writeAudit: async (input: AuditLogInput) => {
      written.push(input);
    },
  };
}

async function aDeleteRecordsWhoRemovedWhichUpload() {
  const client = seededClient();
  const audit = recordingAuditWriter();

  const deleted = await deleteWeeklyBatch(
    { actorLoginId: "B-10", batchId: BATCH_ID },
    { client: client as never, writeAudit: audit.writeAudit },
  );

  assert.equal(deleted, true, "deleting an upload that exists reports that it was deleted");
  assert.deepEqual(
    client.rows("weekly_sales_batches").map((row) => row.id),
    [OTHER_BATCH_ID],
    "the named upload is gone and no other upload went with it",
  );
  assert.equal(
    audit.written.length,
    1,
    "a delete writes exactly one audit row: without it nothing says the upload ever existed, or who removed it",
  );

  const [row] = audit.written;
  assert.equal(row.entityType, "weekly_sales_batch", "the row is filed under the weekly upload's own entity type");
  assert.equal(row.entityId, BATCH_ID, "the row points at the upload that was deleted");
  assert.equal(row.actorLoginId, "B-10", "the row names the person who deleted the upload, not the one who uploaded it");
  assert.deepEqual(
    row.oldValues,
    {
      distributorCode: "IS",
      distributorName: "Ibn Sina",
      fileName: "Ibn Sina weekly 2026-09-08.xlsx",
      weekStart: "2026-09-08",
      cycleMonth: "2026-09-01",
      weekNumber: 2,
      status: "validated",
      totalRows: 812,
      totalNetQty: 5090,
      totalSalesValue: 418250.75,
      uploadedBy: "A-2",
      uploadedAt: "2026-09-16T08:40:26.432059+00:00",
    },
    "the row keeps the upload as it was: distributor, file, week, totals, and who uploaded it when — read BEFORE the delete, because nothing is left to read after it",
  );
  assert.equal(
    row.summary,
    "Weekly sales upload deleted: Ibn Sina, Ibn Sina weekly 2026-09-08.xlsx, week 2 of September 2026.",
    "the summary the audit log screen shows names the distributor, the file and the week, never a batch id",
  );
}

async function aDeleteThatFindsNoUploadWritesNothing() {
  const client = seededClient();
  const audit = recordingAuditWriter();

  const deleted = await deleteWeeklyBatch(
    { actorLoginId: "B-10", batchId: MISSING_BATCH_ID },
    { client: client as never, writeAudit: audit.writeAudit },
  );

  assert.equal(deleted, false, "an upload that is not there is reported as not found, so the route answers 404");
  assert.equal(audit.written.length, 0, "and no audit row claims a delete that removed nothing");
  assert.equal(client.rows("weekly_sales_batches").length, 2, "and no other upload is touched");
}

async function aRetagRecordsTheWeekItMovedFromAndTo() {
  const client = seededClient();
  const audit = recordingAuditWriter();

  const retagged = await retagWeeklyBatch(
    { actorLoginId: "B-10", batchId: BATCH_ID, cycleMonth: "2026-08-01", weekNumber: 4 },
    { client: client as never, writeAudit: audit.writeAudit },
  );

  assert.equal(retagged, true, "a re-tag of an upload that exists succeeds");
  const header = client.rows("weekly_sales_batches").find((row) => row.id === BATCH_ID);
  assert.equal(header?.cycle_month, "2026-08-01", "the upload moves to the new month");
  assert.equal(header?.week_number, 4, "and to the new week");
  assert.deepEqual(
    client.rows("weekly_sales_rows").map((row) => [row.id, row.cycle_month, row.week_number]),
    [
      ["row-1", "2026-08-01", 4],
      ["row-2", "2026-08-01", 4],
      ["row-3", "2026-09-01", 1],
    ],
    "its stored rows move with it, and another upload's rows stay where they were",
  );

  assert.equal(audit.written.length, 1, "a re-tag writes exactly one audit row");
  const [row] = audit.written;
  assert.equal(row.entityType, "weekly_sales_batch", "the row is filed under the weekly upload's own entity type");
  assert.equal(row.entityId, BATCH_ID, "the row points at the upload that was moved");
  assert.equal(row.actorLoginId, "B-10", "the row names the person who moved it");
  assert.deepEqual(
    row.oldValues,
    { cycleMonth: "2026-09-01", weekNumber: 2 },
    "the week it moved FROM is read before the update — read after, it would only repeat the new week",
  );
  assert.deepEqual(
    row.newValues,
    { cycleMonth: "2026-08-01", rowsRetagged: true, weekNumber: 4 },
    "the week it moved TO, and that its rows followed",
  );
  assert.equal(
    row.summary,
    "Weekly sales upload re-tagged: Ibn Sina, Ibn Sina weekly 2026-09-08.xlsx, moved from week 2 of September 2026 to week 4 of August 2026.",
    "the summary names the distributor, the file, and both weeks",
  );
}

async function aRetagWhoseRowsCannotFollowStillRecordsTheHeaderMove() {
  const client = seededClient({ failOn: { weekly_sales_rows: "canceling statement due to statement timeout" } });
  const audit = recordingAuditWriter();

  await assert.rejects(
    retagWeeklyBatch(
      { actorLoginId: "B-10", batchId: BATCH_ID, cycleMonth: "2026-08-01", weekNumber: 4 },
      { client: client as never, writeAudit: audit.writeAudit },
    ),
    (error: unknown) => error instanceof SalesWorkflowError && error.status === 500,
    "a re-tag whose rows could not be moved still fails, exactly as before",
  );
  assert.equal(
    client.rows("weekly_sales_batches").find((row) => row.id === BATCH_ID)?.week_number,
    4,
    "the header had already moved by then, which is why the audit row cannot wait for the rows",
  );
  assert.equal(
    audit.written.length,
    1,
    "the header move is still recorded: a header on one week with its rows on another would otherwise leave no trace",
  );
  assert.equal(audit.written[0].newValues?.rowsRetagged, false, "and the row says the rows did not follow");
  assert.match(
    audit.written[0].summary,
    /but its stored rows could not be moved with it\.$/,
    "and so does the summary the audit log screen shows",
  );
}

async function aRetagOfAMissingUploadWritesNothing() {
  const client = seededClient();
  const audit = recordingAuditWriter();

  await assert.rejects(
    retagWeeklyBatch(
      { actorLoginId: "B-10", batchId: MISSING_BATCH_ID, cycleMonth: "2026-08-01", weekNumber: 4 },
      { client: client as never, writeAudit: audit.writeAudit },
    ),
    (error: unknown) => error instanceof SalesWorkflowError && error.status === 404,
    "re-tagging an upload that is not there still answers 404",
  );
  assert.equal(audit.written.length, 0, "and no audit row claims a move that never happened");
}

// The service has no session: the actor can only come from the route. The chain is the weekly
// upload's own, so the person who uploaded a sheet and the person who deleted it are stored the
// same way (B-10, never b-10) and one exact match finds both.
function theRouteHandsTheActingUserToBothWrites() {
  const route = readFileSync(fileURLToPath(new URL("../app/api/sales/weekly/batches/route.ts", import.meta.url)), "utf8");
  const actor = String.raw`hrIdForStorage\(access\.hrId\) \?\? resolveEmployeeIdentityId\(access\) \?\? access\.loginId \?\? "system"`;

  assert.match(
    route,
    new RegExp(String.raw`const actorLoginId = ${actor};\s*const deleted = await deleteWeeklyBatch\(\{ actorLoginId, batchId \}\);`),
    "the DELETE handler must pass the acting user into deleteWeeklyBatch, stored the way the upload stores uploaded_by",
  );
  assert.match(
    route,
    /if \(!deleted\) \{[\s\S]*?status: 404/,
    "a delete that found no upload answers 404 instead of reporting a success that removed nothing",
  );
  assert.match(
    route,
    new RegExp(String.raw`await retagWeeklyBatch\(\{\s*actorLoginId: ${actor},`),
    "the PATCH handler must pass the acting user into retagWeeklyBatch the same way",
  );
}

export async function runWeeklyBatchAuditTests() {
  await aDeleteRecordsWhoRemovedWhichUpload();
  await aDeleteThatFindsNoUploadWritesNothing();
  await aRetagRecordsTheWeekItMovedFromAndTo();
  await aRetagWhoseRowsCannotFollowStillRecordsTheHeaderMove();
  await aRetagOfAMissingUploadWritesNothing();
  theRouteHandsTheActingUserToBothWrites();
}
