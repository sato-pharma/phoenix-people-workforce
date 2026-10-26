import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import { todayInCairo } from "../src/lib/date-only.ts";
import { assertStoreSplitCurrentBeforePublish, spokenPeriod } from "../src/lib/sales/closing-publish-split-gate.ts";
import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import { assertPeriodNotLocked } from "../src/lib/sales/monthly-distributor-import.ts";
import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import { healAddressCorrectionHistory } from "../src/lib/sales/normalizer/customer-map.ts";
import { backfillCustomerRows } from "../src/lib/sales/normalizer/mapping.ts";
import { IMPORT_TAIL_HOLD_MS, holdImportTailRepair, releaseImportTailRepair } from "../src/lib/sales/import-tail-repair.ts";
import { FINALIZE_REQUEST_TIMEOUT_MS, runFinalizeWithRecovery } from "../src/lib/sales/source-of-sales-batch-supersede.ts";
import { normalizeNumber, parseSalesRow } from "../src/lib/sales/validation.ts";
import { stripSqlComments } from "./support/comment-strip.ts";
import type { WeeklyBranchRegionIndex } from "../src/lib/sales/weekly/branch-region-map.ts";
import { normalizeCode, normalizeKey } from "../src/lib/sales/weekly/mapping-normalize.ts";
import {
  parseWeeklyWorkbookBuffer,
  readWeeklyDateText,
  readWeeklyNumberText,
  resolveAmbiguousWeeklyDates,
  unreadableNumbersMessage,
} from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyProductAliasIndex } from "../src/lib/sales/weekly/product-aliases.ts";
import {
  MAX_SPREADSHEET_UPLOAD_BYTES,
  MAX_STORED_SPREADSHEET_UPLOAD_BYTES,
  spreadsheetTooLargeMessage,
  spreadsheetUploadLimitBytes,
  validateSpreadsheetFile,
} from "../src/lib/uploads/spreadsheets.ts";

// The sales-import findings of the 23 Oct 2026 technical audit (C2). Each block below pins one
// finding by its behaviour, with the database replaced by a fake: no test here reaches a network.

const ROOT = process.cwd();
const source = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

// ── weekly workbook fixtures (the Ibn Sina and Direct layouts, as in weekly-file-totals-self-check) ──

function references(distributorCode: string, distributorName: string): SalesReferenceData {
  return {
    distributors: [{ code: distributorCode, name: distributorName }],
    products: [
      { productCode: "SA001", productName: "SAGINKGO 30 CAP", factoryPrice: 10, family: "", familyCode: "", line: "CNS", source: "Sato" },
    ],
    regions: [{ areaCode: "CA1", areaName: "Cairo", regionCode: "CA", regionName: "Cairo" }],
  };
}

function aliasIndex(distributorCode: string, codeMap: Record<string, string>): WeeklyProductAliasIndex {
  const byCode = new Map<string, string>();
  for (const [alias, product] of Object.entries(codeMap)) byCode.set(normalizeCode(alias), product);
  const index: WeeklyProductAliasIndex = new Map();
  index.set(distributorCode, { byCode, byName: new Map() });
  return index;
}

function branchIndex(keys: string[]): WeeklyBranchRegionIndex {
  const byBranch = new Map<string, { regionCode: string; regionName: string; areaCode: string | null; excluded: boolean }>();
  const entry = { regionCode: "CA", regionName: "Cairo", areaCode: null, excluded: false };
  for (const key of keys) {
    byBranch.set(`sales|${normalizeKey(key)}`, entry);
    byBranch.set(`stock|${normalizeKey(key)}`, entry);
  }
  return { byBranch, byColumnIndex: new Map(), bySoftName: new Map() };
}

async function bufferOf(build: (wb: ExcelJS.Workbook) => void): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return wb.xlsx.writeBuffer();
}

/** One Ibn Sina row whose Sales Quantity cell holds `sales` exactly as given (text or number). */
async function isWorkbook(sales: string | number): Promise<ExcelJS.Buffer> {
  return bufferOf((wb) => {
    const sheet = wb.addWorksheet("Sheet2");
    const header = new Array(10).fill("");
    header[2] = "Item Code";
    header[3] = "Item name";
    header[4] = "Branch Code";
    header[5] = "Branch Name";
    header[6] = "Stock";
    header[8] = "Sales Quantity";
    sheet.addRow(header);
    const row = new Array(10).fill("");
    row[2] = "IS-SAG";
    row[3] = "SAGINKGO";
    row[4] = "B01";
    row[5] = "Cairo Branch";
    row[6] = 25;
    row[8] = sales;
    sheet.addRow(row);
  });
}

async function parseIS(sales: string | number) {
  return parseWeeklyWorkbookBuffer({
    buffer: (await isWorkbook(sales)) as ArrayBuffer,
    distributorCode: "IS",
    distributorName: "Ibn Sina",
    fileName: "IS.xlsx",
    references: references("IS", "Ibn Sina"),
    aliasIndex: aliasIndex("IS", { "IS-SAG": "SA001" }),
    branchMapIndex: branchIndex(["B01"]),
    periodDate: "2026-08-01",
  });
}

async function parseDirect(invoiceDates: string[], periodDate: string | null) {
  const buffer = await bufferOf((wb) => {
    const sheet = wb.addWorksheet("Direct Orders");
    sheet.addRow(["Pharmacy Name", "Distrub ID", "Region ID", "Product ID", "Product", "Qty", "Invoice Date", "Value"]);
    for (const date of invoiceDates) sheet.addRow(["Cairo Pharmacy A", "Direct", "CA", "SA001", "SAGINKGO", 10, date, 500]);
  });
  return parseWeeklyWorkbookBuffer({
    buffer: buffer as ArrayBuffer,
    distributorCode: "Direct",
    distributorName: "Direct",
    fileName: "Direct.xlsx",
    references: references("Direct", "Direct"),
    aliasIndex: aliasIndex("Direct", { SA001: "SA001" }),
    branchMapIndex: branchIndex(["CA"]),
    periodDate,
  });
}

/** P4-01 — the weekly parser reads number cells held as text the way the monthly engine does. */
export async function runWeeklyNumberCellTests() {
  // HEADLINE: "12,5" is 12.5 or 125, and the file says which nowhere — the upload is refused with
  // both readings named. It used to strip the comma and store 125.
  {
    const parsed = await parseIS("12,5");
    assert.equal(parsed.ok, true, "the file still parses");
    if (parsed.ok) {
      assert.equal(parsed.result.status, "blocked", 'a weekly "12,5" quantity blocks the upload instead of becoming 125');
      const reason = parsed.result.blockingReasons.find((text) => text.includes("can only be read by guessing"));
      assert.ok(reason, "the refusal names the guessing");
      assert.match(reason ?? "", /cell I2/, "the cell is named");
      assert.match(reason ?? "", /could be 12\.5 or 125/, "both readings are named");
      assert.match(reason ?? "", /Nothing was imported/, "the refusal says nothing landed");
    }
  }
  // Arabic-Indic digits are one number, read as such.
  {
    const parsed = await parseIS("٨");
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.result.status, "validated", "an Arabic-Indic 8 imports");
      const units = parsed.rows.reduce((sum, row) => sum + Number(row.salesQty ?? 0), 0);
      assert.equal(units, 8, "and it is read as 8");
    }
  }
  // The plain forms are unchanged.
  assert.deepEqual(readWeeklyNumberText("1,200"), { value: 1200 }, "a whole thousands group is 1200");
  assert.deepEqual(readWeeklyNumberText("(500)"), { value: -500 }, "an accounting negative stays negative");
  assert.deepEqual(readWeeklyNumberText("12.5"), { value: 12.5 });
  assert.deepEqual(readWeeklyNumberText("1 200"), { value: 1200 }, "a space-grouped thousand is 1200");
  assert.deepEqual(readWeeklyNumberText("12 5"), { readings: null }, '"12 5" is never 125');
  assert.deepEqual(readWeeklyNumberText("1.234"), { readings: ["1.234", "1234"] }, "a dot before three digits is two readings");
  assert.deepEqual(readWeeklyNumberText("12 units"), { value: 12 }, "text with a word keeps the old reading");
  assert.deepEqual(readWeeklyNumberText("31.03.2026"), { value: 0 }, "a date under a quantity header is no quantity (the old 0), never a blocking two-reading cell");

  assert.equal(unreadableNumbersMessage("Ibn Sina", []), null, "no cells, no message");
  const many = Array.from({ length: 10 }, (_, index) => ({
    kind: "number" as const,
    readings: ["1.5", "15"] as [string, string],
    text: "1,5",
    where: `cell I${index + 2}`,
  }));
  assert.match(unreadableNumbersMessage("Ibn Sina", many) ?? "", /There are 2 more like them\./, "past eight cells the rest are counted");
}

/** P4-02 — weekly dates: no host parse, no rounding into the next day, no guessed order. */
export async function runWeeklyDateCellTests() {
  // HEADLINE: "05/10/2026" alone, with no period given, refuses instead of choosing a week.
  {
    const parsed = await parseDirect(["05/10/2026"], null);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const reason = parsed.result.blockingReasons.find((text) => text.includes("Provide the period date"));
      assert.ok(reason, 'an ambiguous "05/10/2026" date with no period refuses rather than guessing the week');
      assert.match(reason ?? "", /5 October 2026 or 10 May 2026/, "both readings are spelled out");
    }
  }
  // The same file's own "13/10/2026" proves day-first, so its "05/10/2026" is 5 October.
  {
    const parsed = await parseDirect(["13/10/2026", "05/10/2026"], "2026-10-03");
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.result.blockingReasons.some((text) => text.includes("could be")), false, "a file that proves its order is not refused");
    }
  }
  // With the period named, an ambiguous date never overrides it.
  {
    const parsed = await parseDirect(["05/10/2026"], "2026-10-03");
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.result.weekStart, "2026-10-03", "the named period is used");
  }
  assert.deepEqual(readWeeklyDateText("2026-10-05"), { iso: "2026-10-05" });
  assert.deepEqual(readWeeklyDateText("13/10/2026"), { iso: "2026-10-13", orientation: "dayFirst" });
  assert.deepEqual(readWeeklyDateText("10/13/2026"), { iso: "2026-10-13", orientation: "monthFirst" });
  assert.deepEqual(readWeeklyDateText("05/05/2026"), { iso: "2026-05-05" }, "equal parts need no order");
  assert.deepEqual(readWeeklyDateText("05/10/2026"), { ambiguous: { first: 5, second: 10, year: 2026 } });
  // A serial with an afternoon fraction stays on its own day (it was rounded into the next).
  const day = new Date(Date.UTC(1899, 11, 30) + 46000 * 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(readWeeklyDateText("46000.6"), { iso: day }, "14:24 on a day is still that day");
  const resolved = resolveAmbiguousWeeklyDates({
    ambiguousDates: [{ cell: { kind: "date", readings: null, text: "05/10/2026", where: "cell G2" }, first: 5, second: 10, year: 2026 }],
    dayFirstVotes: 0,
    monthFirstVotes: 1,
  });
  assert.deepEqual(resolved.resolved, ["2026-05-10"], "a month-first file reads it as 10 May");
}

/** The old sales upload's number reader no longer strips the comma out of "12,5". */
export async function runOldSalesUploadNumberTests() {
  // HEADLINE.
  assert.ok(Number.isNaN(normalizeNumber("12,5")), 'the old upload reads "12,5" as unreadable, never 125');
  assert.equal(normalizeNumber("1,200"), 1200, "a thousands group still reads");
  assert.equal(normalizeNumber("١٢٠"), 120, "Arabic-Indic digits read");
  assert.equal(normalizeNumber(45), 45);
  const record = parseSalesRow(
    {
      HR_ID: "P-1043",
      "D.M.": "Sample DM",
      Line: "Pedia",
      Sys: "Giza 2",
      "Type of Sales": "Pharmacy",
      Family: "Guamusin",
      PRODUCT: "Guamusin",
      Month: 5,
      Year: 2026,
      "Sales Units": "12,5",
      "Sales Value": 2430,
    },
    "Pedia",
    7,
    { skipFactoryPrice: true },
  );
  const notes = record.validationNotes.join("\n");
  assert.match(notes, /Row 7, column "Sales Units" reads "12,5", which could be 12\.5 or 125/, "the row names the cell and both readings");
  assert.doesNotMatch(notes, /Sales Units is not numeric/, "and does not also say 'not numeric'");
}

/** Weekly Sales resolves today's manager by Cairo's date, not UTC's. */
export async function runWeeklyCairoDayTests() {
  // HEADLINE: neither weekly file reads "today" off UTC any more.
  for (const file of ["src/lib/sales/weekly/manager-attribution.ts", "src/lib/sales/weekly/branch-area-split.ts"]) {
    const text = source(file);
    assert.doesNotMatch(text, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, `${file} no longer takes today from UTC`);
    assert.match(text, /todayInCairo\(\)/, `${file} takes today from Cairo`);
  }
  // 01:30 Cairo on 5 October is still 4 October in UTC — the three hours the manager went missing.
  assert.equal(todayInCairo(new Date("2026-10-04T22:30:00Z")), "2026-10-05");
}

/** S-SAL-09 — a lock that cannot be read refuses with a 503. */
export async function runPeriodLockReadTests() {
  const reader = (result: { data: unknown; error: { code?: string; message?: string } | null }) => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }),
  });
  // HEADLINE.
  await assert.rejects(
    assertPeriodNotLocked("2026-09", reader({ data: null, error: { code: "57014", message: "timeout" } })),
    (error: unknown) => error instanceof SalesWorkflowError && error.status === 503 && error.code === "period_lock_unreadable",
    "an unreadable lock refuses the upload with a 503",
  );
  await assertPeriodNotLocked("2026-09", reader({ data: null, error: { code: "PGRST205", message: "missing" } }));
  await assertPeriodNotLocked("2026-09", reader({ data: null, error: null }));
  await assert.rejects(
    assertPeriodNotLocked("2026-09", reader({ data: { locked: true }, error: null })),
    (error: unknown) => error instanceof SalesWorkflowError && error.status === 409,
    "a locked month still refuses with a 409",
  );
}

/** F-06 — the upload limit and its message are the limit actually enforced. */
export async function runUploadLimitTests() {
  // HEADLINE: no route or library still tells anyone a limit it does not enforce.
  const typed: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name) && /exceeds the \d+ ?MB/.test(source(relative))) typed.push(relative);
    }
  };
  walk("app/api");
  walk("src/lib");
  assert.deepEqual(typed, [], "no route or library carries a typed upload limit beside the one it enforces");
  assert.equal(spreadsheetTooLargeMessage("The weekly file"), "The weekly file is larger than the 4 MB upload limit.");
  assert.equal(spreadsheetUploadLimitBytes(false), MAX_SPREADSHEET_UPLOAD_BYTES);
  assert.equal(spreadsheetUploadLimitBytes(true), MAX_STORED_SPREADSHEET_UPLOAD_BYTES);
  const bigFile = { name: "big.xlsx", size: 6 * 1024 * 1024, type: "" } as unknown as File;
  const options = { allowedExtensions: [".xlsx"], allowedMimeTypes: [] as string[] };
  const direct = validateSpreadsheetFile(bigFile, options);
  assert.equal(direct.ok, false, "a 6 MB file posted directly is over the limit");
  if (!direct.ok) assert.equal(direct.message, "The uploaded file is larger than the 4 MB upload limit.");
  assert.equal(
    validateSpreadsheetFile(bigFile, { ...options, maxBytes: spreadsheetUploadLimitBytes(true) }).ok,
    true,
    "the same file through the storage bucket is accepted",
  );
  for (const file of [
    "src/lib/sales/monthly-import-request.ts",
    "app/api/sales/monthly-import/validate/route.ts",
    "app/api/sales/sales-upload/analyze/route.ts",
    "app/api/sales/sales-upload/commit/route.ts",
    "app/api/sales/weekly/upload/route.ts",
    "app/api/sales/weekly/validate/route.ts",
    "app/api/sales/weekly/verify/route.ts",
  ]) {
    assert.match(source(file), /spreadsheetUploadLimitBytes\(/, `${file} holds a stored workbook to the bucket's limit`);
  }
}

/** P4-05 — a mapping save rebuilds through the shared chain and queues a file it could not rebuild. */
export async function runMappingBackfillRebuildTests() {
  const queued: Array<Record<string, unknown>> = [];
  const fake = {
    from: (table: string) => ({
      upsert: (rows: Array<Record<string, unknown>>) => {
        assert.equal(table, "source_of_sales_brick_move_files");
        queued.push(...rows);
        return Promise.resolve({ error: null });
      },
    }),
    rpc: () => Promise.resolve({ data: [{ affected_batch_ids: ["batch-a", "batch-b"], updated_rows: 4 }], error: null }),
  };
  const rebuilt: string[] = [];
  const count = await backfillCustomerRows(
    fake,
    [{ brick_id: "B7", customer_code: "1001", distributor_code: "PS" }],
    {
      refresh: async (_client, batchId) => {
        if (batchId === "batch-b") throw new Error("rollup refresh failed: timeout");
        rebuilt.push(batchId);
      },
    },
  );
  assert.equal(count, 4);
  assert.deepEqual(rebuilt, ["batch-a"], "each touched file goes through the shared rebuild");
  // HEADLINE: the file whose rebuild failed is queued for the 20-minute clock, not dropped.
  assert.deepEqual(
    queued.map((row) => `${String(row.old_brick_id)} ${String(row.batch_id)}`),
    ["B7 batch-b"],
    "a file the mapping save could not rebuild is queued, keyed by the brick its rows now sit on",
  );
  assert.equal(queued[0]?.refreshed_at, null);
  const mapping = source("src/lib/sales/normalizer/mapping.ts");
  assert.doesNotMatch(mapping, /phx_refresh_sos_fact_rollup/, "no hand copy of the rebuild chain is left in mapping.ts");
  assert.doesNotMatch(mapping, /catch \{\s*\/\/ Rollup refresh/, "no empty catch swallows a failed rebuild");
}

/** P4-06 — each address correction's files are queued as soon as that correction lands. */
export async function runAddressCorrectionQueueTests() {
  const queuedBeforeCall: number[] = [];
  let queuedRows = 0;
  let calls = 0;
  const fake = {
    from: () => ({
      upsert: (rows: Array<Record<string, unknown>>) => {
        queuedRows += rows.length;
        return Promise.resolve({ error: null });
      },
    }),
    rpc: (_fn: string, args: Record<string, unknown>) => {
      queuedBeforeCall.push(queuedRows);
      calls += 1;
      // The third correction dies, as a deploy or a dropped connection would end the loop.
      if (args.p_customer === "1003") return Promise.reject(new Error("connection reset"));
      return Promise.resolve({ data: [{ affected_batch_ids: [`batch-${String(args.p_customer)}`], updated_rows: 2 }], error: null });
    },
  };
  await assert.rejects(
    healAddressCorrectionHistory(fake as never, [
      { brickId: "B3", customerCode: "1001", distributorCode: "PS", previousBrickId: "B2", source: "address" },
      { brickId: "B3", customerCode: "1002", distributorCode: "PS", previousBrickId: "B2", source: "address" },
      { brickId: "B3", customerCode: "1003", distributorCode: "PS", previousBrickId: "B2", source: "address" },
    ]),
  );
  assert.equal(calls, 3);
  // HEADLINE: the two corrections that landed before the failure are already queued.
  assert.equal(queuedRows, 2, "every correction that moved rows had its files queued before the loop died");
  assert.deepEqual(queuedBeforeCall, [0, 1, 2], "each correction's queue write happens before the next correction runs");
}

/**
 * P4-06 — the history correction queues the files it re-points in the SAME transaction as the
 * re-point, so no crash between two calls can leave rows moved and their files never rebuilt.
 */
export function runReconcileQueuesItsFilesTests() {
  const name = "sos_reconcile_import_rows_from_customer_map";
  const dir = join(ROOT, "supabase/migrations");
  // Comments stripped first: the header quotes the very statements the assertions look for.
  const sqlCode = (text: string) => stripSqlComments(text).replace(/(^|[^:])--[^\n]*/g, "$1");
  const flat = (text: string) => text.replace(/\s+/g, " ");
  // Migrations apply in filename order, so the LAST file creating the function is what runs.
  let latest: { body: string; file: string; header: string; sql: string } | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = flat(sqlCode(readFileSync(join(dir, file), "utf8")));
    const at = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i").exec(sql);
    if (!at) continue;
    const from = sql.slice(at.index);
    const open = from.indexOf("$function$");
    const close = from.indexOf("$function$", open + 10);
    latest = { body: from.slice(open + 10, close), file, header: from.slice(0, open), sql };
  }
  assert.ok(latest, `no migration creates ${name}`);
  const { body, file, header, sql } = latest;

  // HEADLINE: the queue write is part of the very statement that moves the rows.
  const statementAt = body.indexOf("with updated as ( update public.source_of_sales_import_rows r");
  assert.ok(statementAt > 0, `${file}: the re-point runs as a data-modifying WITH statement`);
  const statement = body.slice(statementAt, body.indexOf(";", statementAt));
  assert.ok(
    statement.includes("insert into public.source_of_sales_brick_move_files as f (old_brick_id, batch_id, moved_rows)"),
    `${file}: ${name} must queue the files it moved in the same statement as the move — a second call from the app `
      + "could die after the move committed and leave the files never rebuilt",
  );
  // Each file once: one queue row per file, safe to repeat, and a file already waiting keeps its row.
  assert.match(statement, /per_file as \( select u\.batch_id, count\(\*\)::integer as moved_rows from updated u group by u\.batch_id \)/,
    `${file}: one queue row per FILE, never one per row`);
  assert.ok(
    statement.includes("on conflict (old_brick_id, batch_id) do update set moved_rows = f.moved_rows + excluded.moved_rows, moved_at = now(), refreshed_at = null"),
    `${file}: a repeat re-stamps the queue row instead of failing, and a rebuild already running is not counted as covering the new move`,
  );
  assert.match(statement, /waiting as \( select distinct on \(q\.batch_id\) q\.batch_id, q\.old_brick_id from public\.source_of_sales_brick_move_files q join per_file pf on pf\.batch_id = q\.batch_id where q\.refreshed_at is null/,
    `${file}: a file already waiting in the queue is re-stamped, not queued a second time`);
  assert.ok(
    statement.includes("select coalesce(w.old_brick_id, lb.left_brick_id, v_brick) as old_brick_id, pf.batch_id, pf.moved_rows from per_file pf")
      && statement.includes("select k.old_brick_id, k.batch_id, k.moved_rows from keyed k on conflict"),
    `${file}: keyed on the waiting row, else the brick the rows left, else the brick they joined (which always exists)`,
  );
  assert.match(statement, /join public\.source_of_sales_bricks b on b\.brick_id = u\.left_brick_id/,
    `${file}: a left brick keys the row only when the brick master holds it — the queue's key references the master`);
  assert.match(statement, /returning r\.batch_id, pre\.brick_id as left_brick_id/,
    `${file}: the brick each row left is read from the row as the statement found it`);
  assert.ok(!/refresh_started_at/.test(body), `${file}: a claim in progress is left alone, so two rebuilds never run at once`);
  assert.ok(
    statement.includes("array_agg(q.batch_id order by q.batch_id) from queued q"),
    `${file}: every file the call reports as touched is a file it queued`,
  );

  // Nothing else changes: the same rows move, a locked file stays whole, and it is judged per file.
  assert.ok(body.includes("from unnest(v_files) as f(batch_id) where public.sos_import_batch_touches_locked_closing(f.batch_id)"),
    `${file}: the files are still judged once each`);
  assert.ok(statement.includes("and not (r.batch_id = any (v_frozen))"), `${file}: a file touching a locked month is still left whole`);
  assert.match(header, /returns table\(updated_rows integer, affected_batch_ids uuid\[\]\) language plpgsql security definer set search_path to 'public' as $/,
    `${file}: the signature, return shape, security definer and pinned search_path stay`);
  assert.ok(sql.includes(`revoke execute on function public.${name}(text, text) from public, anon, authenticated;`),
    `${file}: execute stays revoked from PUBLIC and the browser roles`);
  assert.ok(sql.includes(`grant execute on function public.${name}(text, text) to service_role;`), `${file}: the service role keeps it`);

  // The app's own write after the call stays, on the same key, so the two land on one row.
  const heal = source("src/lib/sales/normalizer/customer-map.ts");
  assert.match(heal, /\.from\("source_of_sales_brick_move_files"\)\s*\.upsert\([\s\S]*?\{ onConflict: "old_brick_id,batch_id" \}/,
    "the app's queue write keys the same conflict as the migration's");
}

/** P4-03 — a finalize that committed after the call failed is recognised and its tail runs. */
export async function runFinalizeRecoveryTests() {
  const client = (status: string | null, rpcError: unknown) => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: status ? { status } : null, error: null }) }) }),
    }),
    rpc: () => Promise.resolve({ data: null, error: rpcError }),
  });
  const input = { batchId: "b1", distributorCode: "PS", period: "2026-09" };
  // HEADLINE.
  const recovered = await runFinalizeWithRecovery(client("validated", { message: "fetch aborted" }), input);
  assert.equal(recovered.recovered, true, "a finalize that committed despite the error is treated as landed");
  await assert.rejects(
    runFinalizeWithRecovery(client("pending", { message: "fetch aborted" }), input),
    (error: unknown) => (error as { message?: unknown }).message === "fetch aborted",
    "a finalize that did not commit still fails with its own error",
  );
  const clean = await runFinalizeWithRecovery(
    { from: () => ({}), rpc: () => Promise.resolve({ data: { rowCount: 3 }, error: null }) },
    input,
  );
  assert.deepEqual(clean, { data: { rowCount: 3 }, recovered: false });
  assert.ok(FINALIZE_REQUEST_TIMEOUT_MS > 120_000, "the call waits longer than the finalize's 120-second statement timeout");
  assert.match(
    source("src/lib/sales/source-of-sales-batch-supersede.ts"),
    /getSupabaseAdmin\(\{ requestTimeoutMs: FINALIZE_REQUEST_TIMEOUT_MS \}\)/,
    "the finalize call uses the longer timeout",
  );
}

/**
 * P4-03 — an import writes its repair note BEFORE finalize and crosses it off after the tail, so a
 * process that dies between the committed finalize and the split net still gets its file rebuilt.
 */
export async function runImportTailRepairNoteTests() {
  const fakeClient = (options: { any?: string[]; finishError?: unknown; known?: string[]; upsertError?: unknown }) => {
    const upserts: Array<{ onConflict: string; rows: Array<Record<string, unknown>> }> = [];
    const rpcs: Array<{ args: Record<string, unknown>; fn: string }> = [];
    const masterReads: string[][] = [];
    const client = {
      from: (table: string) => {
        if (table === "source_of_sales_bricks") {
          return {
            select: (columns: string) => {
              assert.equal(columns, "brick_id");
              return {
                in: (column: string, values: string[]) => {
                  assert.equal(column, "brick_id");
                  masterReads.push(values);
                  const known = new Set(options.known ?? []);
                  return Promise.resolve({ data: values.filter((v) => known.has(v)).map((brick_id) => ({ brick_id })), error: null });
                },
                limit: () => Promise.resolve({ data: (options.any ?? []).map((brick_id) => ({ brick_id })), error: null }),
              };
            },
          };
        }
        assert.equal(table, "source_of_sales_brick_move_files", "the note goes to the queue the drain already empties");
        return {
          upsert: (rows: Array<Record<string, unknown>>, opts: { onConflict: string }) => {
            upserts.push({ onConflict: opts.onConflict, rows });
            return Promise.resolve({ error: options.upsertError ?? null });
          },
        };
      },
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ args, fn });
        return Promise.resolve({ data: options.finishError ? null : true, error: options.finishError ?? null });
      },
    };
    return { client, masterReads, rpcs, upserts };
  };

  // HEADLINE: the note is written already claimed, and the release crosses off exactly that row.
  const now = new Date("2026-10-26T08:00:00.000Z");
  const live = fakeClient({ known: ["B2"] });
  const hold = await holdImportTailRepair(live.client, "batch-1", ["B9", "B9", "B9", "B2", null, "  "], now);
  assert.deepEqual(hold, { batchId: "batch-1", brickId: "B2", movedAt: now.toISOString() }, "keyed on a brick the master holds");
  assert.deepEqual(live.masterReads, [["B9", "B2"]], "the batch's own bricks are offered first, most rows first");
  assert.equal(live.upserts.length, 1);
  assert.equal(live.upserts[0]?.onConflict, "old_brick_id,batch_id");
  const row = live.upserts[0]?.rows[0] ?? {};
  assert.equal(row.batch_id, "batch-1");
  assert.equal(row.old_brick_id, "B2");
  assert.equal(row.moved_at, now.toISOString());
  assert.equal(row.refreshed_at, null, "the file counts as NOT rebuilt until the tail crosses it off");
  assert.equal(
    Date.parse(String(row.refresh_started_at)) - now.getTime(),
    IMPORT_TAIL_HOLD_MS,
    "the claim is set ahead, so the drain leaves the file alone while the live tail runs",
  );
  // The drain takes a claim older than 5 minutes and fires every 20; a dead import's file must be
  // rebuilt before the one-hour stuck-file alert, and never while a healthy tail is still running.
  assert.ok(IMPORT_TAIL_HOLD_MS >= 20 * 60_000, "the hold outlasts any honest import tail");
  assert.ok(IMPORT_TAIL_HOLD_MS + 5 * 60_000 + 20 * 60_000 <= 60 * 60_000, "a dead import is rebuilt inside the stuck-file hour");
  assert.equal(await releaseImportTailRepair(live.client, hold), true);
  assert.deepEqual(
    live.rpcs,
    [
      {
        args: { p_batch_id: "batch-1", p_moved_at: now.toISOString(), p_old_brick: "B2", p_refreshed: true },
        fn: "sos_finish_brick_move_file",
      },
    ],
    "the release marks the row rebuilt only if no brick move re-stamped it since the hold",
  );

  // A batch whose bricks the master does not know, or that has none, is keyed on any known brick.
  const unknown = fakeClient({ any: ["B1"], known: [] });
  assert.equal((await holdImportTailRepair(unknown.client, "batch-2", ["X1"], now))?.brickId, "B1");
  const brickless = fakeClient({ any: ["B1"] });
  assert.equal((await holdImportTailRepair(brickless.client, "batch-3", [null, ""], now))?.brickId, "B1");
  assert.deepEqual(brickless.masterReads, [], "no brick to offer, so the master is read for any brick");

  // A failed note never fails the import: it logs and the tail runs as it did before.
  const refused = fakeClient({ known: ["B2"], upsertError: { message: "permission denied" } });
  assert.equal(await holdImportTailRepair(refused.client, "batch-4", ["B2"], now), null);
  assert.equal(await releaseImportTailRepair(refused.client, null), false);
  assert.deepEqual(refused.rpcs, [], "no note, nothing to cross off");
  const empty = fakeClient({});
  assert.equal(await holdImportTailRepair(empty.client, "batch-5", [], now), null, "an empty brick master writes no note and throws nothing");
  const stuck = fakeClient({ finishError: { message: "timeout" }, known: ["B2"] });
  const stuckHold = await holdImportTailRepair(stuck.client, "batch-6", ["B2"], now);
  assert.equal(await releaseImportTailRepair(stuck.client, stuckHold), false, "a failed release costs one extra rebuild, never an error");

  // Both import paths: note, then finalize, then the split net, then the cross-off.
  for (const [file, finalizeMarker] of [
    ["src/lib/sales/monthly-distributor-import.ts", 'if (result.status === "validated" && result.period) {'],
    ["src/lib/sales/normalizer/service.ts", "if (period) {\n    await finalizeSosBatchAndAuditSupersede"],
  ] as const) {
    const body = source(file);
    const holdAt = body.indexOf("await holdImportTailRepair(supabase, batchId,");
    const finalizeAt = body.indexOf(finalizeMarker);
    const netAt = body.indexOf("await writeStoreSplitNetForBatch(supabase, batchId);");
    const releaseAt = body.indexOf("await releaseImportTailRepair(supabase, tailRepair);");
    assert.ok(holdAt > 0, `${file} writes the repair note`);
    assert.ok(finalizeAt > holdAt, `${file} writes the note BEFORE finalize commits the batch`);
    assert.ok(netAt > finalizeAt, `${file} still writes the split net after finalize`);
    assert.ok(releaseAt > netAt, `${file} crosses the note off only after the tail`);
    assert.ok(
      releaseAt > body.indexOf('invalidateSalesDashboardCache("source of sales import — split net written'),
      `${file} crosses the note off after the last step of the tail`,
    );
    assert.equal(body.split("holdImportTailRepair(").length - 1, 1, `${file} writes one note per import`);
  }
  assert.match(
    source("src/lib/sales/monthly-distributor-import.ts"),
    /const tailRepair =\s*result\.status === "validated" \? await holdImportTailRepair\(/,
    "a rejected upload gets no note, as it gets no tail",
  );
}

/** P4-07 — publishing refuses a stored city split that no longer matches today's rows. */
export async function runPublishSplitGateTests() {
  const settled: string[] = [];
  const deps = (drifted: boolean, overrides: Record<string, unknown> = {}) => ({
    isFrozen: async () => false,
    loadDrift: async () => ({ absoluteValueDelta: 19_752.26, byArea: drifted ? [{}, {}, {}] : [], drifted }),
    settle: async (period: string) => {
      settled.push(period);
    },
    splitApplies: () => true,
    ...overrides,
  });
  // HEADLINE.
  await assert.rejects(
    assertStoreSplitCurrentBeforePublish({ line: "Pedia", period: "2026-09" }, deps(true)),
    (error: unknown) =>
      error instanceof SalesWorkflowError &&
      error.status === 409 &&
      /September 2026's stored city split no longer matched today's sales rows \(3 areas, 9,876 EGP between them\)/.test(error.message) &&
      /Publish again/.test(error.message),
    "a drifted split refuses the publish and says it was rebuilt",
  );
  assert.deepEqual(settled, ["2026-09"], "and the period's net is rebuilt so the next press publishes");
  await assertStoreSplitCurrentBeforePublish({ line: "Pedia", period: "2026-09" }, deps(false));
  await assertStoreSplitCurrentBeforePublish({ line: "Pedia", period: "2026-09" }, deps(true, { isFrozen: async () => true }));
  await assertStoreSplitCurrentBeforePublish({ line: "Pedia", period: "2026-05" }, deps(true, { splitApplies: () => false }));
  await assert.rejects(
    assertStoreSplitCurrentBeforePublish(
      { line: "Pedia", period: "2026-09" },
      deps(false, { loadDrift: async () => Promise.reject(new Error("timeout")) }),
    ),
    (error: unknown) => error instanceof SalesWorkflowError && error.status === 503,
    "a drift that cannot be read refuses with a 503",
  );
  await assert.rejects(
    assertStoreSplitCurrentBeforePublish(
      { line: "Pedia", period: "2026-09" },
      deps(true, { settle: async () => Promise.reject(new Error("locked")) }),
    ),
    (error: unknown) => error instanceof SalesWorkflowError && error.status === 503 && /could not be rebuilt just now/.test(error.message),
  );
  assert.equal(spokenPeriod("2026-09"), "September 2026");
  const publication = source("src/lib/sales/monthly-closing-publication.ts");
  const gateAt = publication.indexOf("await assertStoreSplitCurrentBeforePublish({ line, period });");
  const upsertAt = publication.indexOf('.from("monthly_closing_publications")\n    .upsert(');
  assert.ok(gateAt > 0 && upsertAt > gateAt, "publishClosing runs the split gate before it writes the publication");
  assert.match(source("app/api/sales/monthly-closing/publish/route.ts"), /error instanceof SalesWorkflowError/, "the route answers with the gate's own status");
}
