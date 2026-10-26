import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import type { AuditLogInput } from "../src/lib/admin/audit.ts";
import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import {
  DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY,
  DIRECT_WEEKLY_FROM_ORDERS_CYCLE,
  directWeeklyUploadRefusal,
  isDirectOrdersWeeklyBatch,
} from "../src/lib/sales/weekly/distributors.ts";
import { deleteWeeklyBatch, retagWeeklyBatch } from "../src/lib/sales/weekly/service.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * DIRECT ORDERS ARE INJECTED INTO WEEKLY SALES BY THE DATABASE — NOBODY UPLOADS THEM, NOBODY EDITS THEM.
 *
 * Owner rule, 2026-09-19: weekly sales carry direct orders on the same rules as the Source of Sales
 * (an order counts in the month Finance books it). From 2026-08 the batches are written by
 * `phx_rebuild_direct_order_weekly_batches` (template_key `direct_orders_system`). Three things stop
 * that from double counting or going stale, and this file breaks each one:
 *
 *   1. an uploaded Direct sheet for 2026-08 onwards is refused (the same orders would count twice);
 *   2. the system batch cannot be deleted or re-tagged by hand (the rebuild owns the month);
 *   3. the SQL and the TypeScript agree on the floor and the template key, so neither can drift.
 *
 * NOTHING HERE MAY REACH A REAL DATABASE. The suite runs with production credentials, so the two batch
 * functions are handed the fixture client and a recording audit writer; the ids are not UUIDs.
 */

const SYSTEM_BATCH = "direct-orders-system-2026-09-week-4";
const UPLOADED_BATCH = "direct-uploaded-2026-07-week-4";

function seededClient() {
  return fakeSupabaseClient(
    {
      weekly_sales_batches: [
        {
          id: SYSTEM_BATCH,
          distributor_code: "Direct",
          distributor_name: "Direct (Company)",
          template_key: DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY,
          file_name: "direct-orders-2026-09-week-4",
          week_start: "2026-09-22",
          cycle_month: "2026-09-01",
          week_number: 4,
          status: "validated",
          total_rows: 5,
          total_net_qty: 900,
          total_sales_value: 304599.3,
          uploaded_by: "system",
          created_at: "2026-09-19T12:00:00+00:00",
        },
        {
          id: UPLOADED_BATCH,
          distributor_code: "Direct",
          distributor_name: "Direct (Company)",
          template_key: "Direct",
          file_name: "Direct July week 4.xlsx",
          week_start: "2026-07-22",
          cycle_month: "2026-07-01",
          week_number: 4,
          status: "validated",
          total_rows: 40,
          total_net_qty: 1200,
          total_sales_value: 96000,
          uploaded_by: "B-10",
          created_at: "2026-07-28T10:00:00+00:00",
        },
      ],
      weekly_sales_rows: [
        { id: "row-sys-1", batch_id: SYSTEM_BATCH, cycle_month: "2026-09-01", week_number: 4 },
        { id: "row-up-1", batch_id: UPLOADED_BATCH, cycle_month: "2026-07-01", week_number: 4 },
      ],
    },
    { projectColumns: true },
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

async function rejectsWith(action: () => Promise<unknown>, code: string, label: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SalesWorkflowError, `${label}: a SalesWorkflowError, not a raw failure`);
    assert.equal(error.code, code, `${label}: the refusal carries its own code`);
    assert.equal(error.status, 409, `${label}: a conflict, the shape the route already renders`);
    return true;
  });
}

function anUploadedDirectSheetIsRefusedFromAugust() {
  for (const cycle of ["2026-08-01", "2026-09-01", "2027-01-01"]) {
    const message = directWeeklyUploadRefusal("Direct", cycle, `${cycle.slice(0, 7)}-08`);
    assert.ok(message, `an uploaded Direct sheet for ${cycle.slice(0, 7)} is refused`);
    assert.match(message!, new RegExp(cycle.slice(0, 7)), "the refusal names the month it is refusing");
    assert.match(message!, /Direct Orders module/, "the refusal says where the numbers come from instead");
  }
  assert.ok(directWeeklyUploadRefusal("direct", "2026-09-01", null), "the distributor code is matched case-insensitively");
  assert.equal(DIRECT_WEEKLY_FROM_ORDERS_CYCLE, "2026-08-01", "the floor is August 2026, the month the uploads stopped");
}

function monthsBeforeAugustAndOtherDistributorsAreUntouched() {
  assert.equal(
    directWeeklyUploadRefusal("Direct", "2026-07-01", "2026-07-25"),
    null,
    "July and earlier came from uploaded sheets and stay as published — the guard must not reach back",
  );
  assert.equal(directWeeklyUploadRefusal("Direct", null, null), null, "an undated sheet has no month to refuse");
  for (const code of ["IS", "IS-S", "PS", "EG"]) {
    assert.equal(
      directWeeklyUploadRefusal(code, "2026-09-01", "2026-09-08"),
      null,
      `${code} is a real distributor sheet and is never affected by the Direct rule`,
    );
  }
}

function aSheetTaggedJulyButDatedAugustIsStillAugust() {
  assert.ok(
    directWeeklyUploadRefusal("Direct", "2026-07-01", "2026-08-02"),
    "cycle_month is operator-tagged, so the sheet's own date is checked as well",
  );
  assert.ok(
    directWeeklyUploadRefusal("Direct", "2026-09-01", "2026-07-25"),
    "and a sheet dated July but tagged September is refused on its tag",
  );
}

function theSystemBatchIsRecognisedByItsTemplateKeyOnly() {
  assert.equal(isDirectOrdersWeeklyBatch(DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY), true);
  assert.equal(isDirectOrdersWeeklyBatch(" direct_orders_system "), true, "whitespace does not hide it");
  assert.equal(isDirectOrdersWeeklyBatch("Direct"), false, "an uploaded Direct sheet is NOT a system batch");
  assert.equal(isDirectOrdersWeeklyBatch(null), false);
}

async function theSystemBatchCannotBeDeletedByHand() {
  const client = seededClient();
  const audit = recordingAuditWriter();

  await rejectsWith(
    () => deleteWeeklyBatch({ actorLoginId: "B-10", batchId: SYSTEM_BATCH }, { client: client as never, writeAudit: audit.writeAudit }),
    "direct_orders_batch",
    "deleting the system batch",
  );
  assert.deepEqual(
    client.rows("weekly_sales_batches").map((row) => row.id).sort(),
    [SYSTEM_BATCH, UPLOADED_BATCH].sort(),
    "the refused delete removed nothing",
  );
  assert.equal(audit.written.length, 0, "a refused delete writes no audit row — nothing changed");

  const deleted = await deleteWeeklyBatch(
    { actorLoginId: "B-10", batchId: UPLOADED_BATCH },
    { client: client as never, writeAudit: audit.writeAudit },
  );
  assert.equal(deleted, true, "an ordinary uploaded Direct batch (July) can still be deleted");
  assert.equal(audit.written.length, 1, "and that delete is audited as before");
}

async function theSystemBatchCannotBeRetaggedByHand() {
  const client = seededClient();
  const audit = recordingAuditWriter();

  await rejectsWith(
    () =>
      retagWeeklyBatch(
        { actorLoginId: "B-10", batchId: SYSTEM_BATCH, cycleMonth: "2026-08-01", weekNumber: 2 },
        { client: client as never, writeAudit: audit.writeAudit },
      ),
    "direct_orders_batch",
    "re-tagging the system batch",
  );
  const [batch] = client.rows("weekly_sales_batches").filter((row) => row.id === SYSTEM_BATCH);
  assert.equal(batch.cycle_month, "2026-09-01", "the refused re-tag left the batch in its month");
  assert.equal(batch.week_number, 4, "and in its week");
  assert.equal(audit.written.length, 0, "a refused re-tag writes no audit row");

  const moved = await retagWeeklyBatch(
    { actorLoginId: "B-10", batchId: UPLOADED_BATCH, cycleMonth: "2026-07-01", weekNumber: 3 },
    { client: client as never, writeAudit: audit.writeAudit },
  );
  assert.equal(moved, true, "an ordinary uploaded batch can still be re-tagged");
}

function theUploadPathAsksTheGuardBeforeAnythingIsStored() {
  const source = readFileSync(new URL("../src/lib/sales/weekly/service.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function importWeeklySalesFile");
  const persist = source.indexOf("await persistWeeklyUpload(", start);
  const guard = source.indexOf("directWeeklyUploadRefusal(", start);
  const dryRunGate = source.indexOf("if (!input.dryRun", start);
  assert.ok(start > -1 && persist > -1, "the upload function and its store call are where this test looks");
  assert.ok(guard > -1, "importWeeklySalesFile asks directWeeklyUploadRefusal");
  assert.ok(guard < dryRunGate, "the refusal fires on the dry-run too, so the review screen says it before anyone confirms");
  assert.ok(guard < persist, "and always before a batch is stored");
  assert.match(
    source.slice(guard, guard + 300),
    /throw new SalesWorkflowError\("direct_weekly_from_orders"/,
    "the refusal is thrown as the 409 the upload route already renders",
  );
}

/** The newest migration that (re)defines a function — the body production runs. LF, whatever the checkout. */
function newestDefinitionOf(fn: string): string {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const definers = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => readFileSync(new URL(name, dir), "utf8").includes(`create or replace function public.${fn}(`))
    .sort();
  assert.ok(definers.length > 0, `a migration defines ${fn}`);
  return readFileSync(new URL(definers[definers.length - 1], dir), "utf8").replace(/\r\n/g, "\n");
}

function theSqlAndTheTypescriptAgree() {
  const sql = newestDefinitionOf("phx_rebuild_direct_order_weekly_batches");
  const trigger = newestDefinitionOf("phx_direct_order_weekly_sync");

  assert.ok(
    sql.includes(`template_key     = '${DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY}'`),
    "the SQL supersedes only the template key the TypeScript refuses to edit",
  );
  assert.ok(
    sql.includes(`'${DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY}',\n           'direct-orders-'`),
    "and it writes its batches under that same key",
  );
  assert.ok(
    sql.includes(`p_period < '${DIRECT_WEEKLY_FROM_ORDERS_CYCLE.slice(0, 7)}'`),
    "the SQL floor is the month the upload guard starts refusing",
  );
  assert.ok(
    /and p >= '2026-08'/.test(trigger) && DIRECT_WEEKLY_FROM_ORDERS_CYCLE.startsWith("2026-08"),
    "the trigger applies the same floor, so a re-booked order can never rebuild an uploaded month",
  );
  assert.match(
    trigger,
    /exception when others then[\s\S]{0,900}weekly_sync_failed/,
    "the trigger swallows a weekly failure and records it — a reporting view must never roll back an approval",
  );
}

/**
 * A WEEKLY DIRECT ROW CARRIES ITS PHARMACY'S OWN AREA — never a region-wide row split evenly.
 *
 * Owner, 2026-10-26: "fix weekly direct orders to count at the pharmacy's own area". The writer used
 * to hard-code area_code null, so "Direct – Giza" was read as the whole region and one pharmacy's
 * order was shared by every rep there. Monthly Closing credits the pharmacy's area
 * (phx_rebuild_direct_order_sos_batch writes ph.area_code); Weekly must read the same column, keep it
 * in the grouping (or two areas' orders would merge into one row), and write it onto the row.
 */
function aWeeklyDirectRowCarriesThePharmacysOwnArea() {
  const sql = newestDefinitionOf("phx_rebuild_direct_order_weekly_batches");
  const closing = newestDefinitionOf("phx_rebuild_direct_order_sos_batch");
  assert.match(closing, /\bph\.area_code,/, "the closing's injection credits the pharmacy's own area (the rule this mirrors)");

  assert.match(
    sql,
    /nullif\(upper\(btrim\(coalesce\(ph\.area_code, ''\)\)\), ''\)\s+as area_code/,
    "the weekly writer reads the area from the pharmacy, the same column the closing writes",
  );
  assert.match(
    sql,
    /group by week_number, region_code, area_code, product_code, official_line/,
    "and keeps it in the grouping, so two areas' orders never merge into one region row",
  );
  assert.match(
    sql,
    /v_month_start, l\.week_number, l\.area_code\s*\n\s*from lines l/,
    "and writes it onto the weekly row, so the region split never sees the order",
  );
  assert.doesNotMatch(
    sql,
    /v_month_start, l\.week_number, null\s*\n\s*from lines l/,
    "the hard-coded null area is gone",
  );
}

export async function runWeeklyDirectOrdersInjectionTests() {
  anUploadedDirectSheetIsRefusedFromAugust();
  monthsBeforeAugustAndOtherDistributorsAreUntouched();
  aSheetTaggedJulyButDatedAugustIsStillAugust();
  theSystemBatchIsRecognisedByItsTemplateKeyOnly();
  await theSystemBatchCannotBeDeletedByHand();
  await theSystemBatchCannotBeRetaggedByHand();
  theUploadPathAsksTheGuardBeforeAnythingIsStored();
  theSqlAndTheTypescriptAgree();
  aWeeklyDirectRowCarriesThePharmacysOwnArea();
}
