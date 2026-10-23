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
import { FINALIZE_REQUEST_TIMEOUT_MS, runFinalizeWithRecovery } from "../src/lib/sales/source-of-sales-batch-supersede.ts";
import { normalizeNumber, parseSalesRow } from "../src/lib/sales/validation.ts";
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
