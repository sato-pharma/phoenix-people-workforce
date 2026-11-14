import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  fingerprintClashMessage,
  pickFingerprintClash,
  type assertNotADuplicateUpload,
  type StoredFingerprintBatch,
} from "../src/lib/sales/import-duplicate-guard.ts";
import { applyImportStoreRules, type PeriodLockReader } from "../src/lib/sales/import-store-rules.ts";
import { productPeriodPricesFromRows } from "../src/lib/sales/product-period-price.ts";
import { fileSha256, uploadFingerprint, uploadPartQualifier } from "../src/lib/sales/upload-fingerprint.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE SAME FILE, RENAMED, IS REFUSED (enterprise audit REC-069, F-SAL-002; owner, 14 Nov 2026: "refuse,
// like today").
//
// The duplicate guard matched a file by its name and figures only, so a renamed copy of a month's workbook
// loaded under another month walked through. Every batch now stores `file_sha256`, the fingerprint of the
// bytes the person chose, and the guard refuses the same fingerprint under another month or another
// distributor, naming the upload it repeats. The same distributor and month stays the replace flow.
//
// This file pins:
//   1. the fingerprint itself — one file, several files in any order, one upload split into parts;
//   2. what the guard refuses and what it leaves alone;
//   3. the message names the upload it repeats;
//   4. the door hands the fingerprint to the guard;
//   5. every front door fingerprints the bytes the person CHOSE (never the Normalizer's coded copy) and
//      both writers store it;
//   6. the Uploaded Sheets list shows it.
// Pinned by substring, never by byte window (AGENTS.md §2.1).
// ─────────────────────────────────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const APRIL_BYTES = new TextEncoder().encode("IS-S April workbook bytes");
const APRIL = fileSha256(APRIL_BYTES);

/** A stored batch, validated, for IS-S April, read from APRIL's bytes. */
function stored(input: Partial<StoredFingerprintBatch> = {}): StoredFingerprintBatch {
  return {
    created_at: "2026-06-03T09:15:00.000Z",
    distributor_code: "IS-S",
    distributor_name: "Ibn Sina Specialty",
    file_name: "Monthly_Sales_by_Client_for_SATO_PHARMA_(PAS).xlsx",
    file_sha256: APRIL,
    id: "batch-april",
    period: "2026-04",
    status: "validated",
    total_rows: 1141,
    total_value: 349266.46,
    ...input,
  };
}

function testTheFingerprintIsTheFilesOwnSha256() {
  assert.equal(APRIL, sha("IS-S April workbook bytes"), "one file's fingerprint is the SHA-256 of its bytes");
  assert.equal(fileSha256(APRIL_BYTES.buffer.slice(0) as ArrayBuffer), APRIL, "an ArrayBuffer and its bytes fingerprint alike");
  assert.equal(uploadFingerprint([APRIL]), APRIL, "a batch read from one file stores that file's fingerprint");
  assert.equal(uploadFingerprint([APRIL.toUpperCase()]), APRIL, "a fingerprint is compared in one case");
  assert.equal(uploadFingerprint([]), null, "a batch with no file hashed stores no fingerprint, never an invented one");
}

function testSeveralSheetsFingerprintTogetherInAnyOrder() {
  const a = sha("branch 1");
  const b = sha("branch 2");
  const both = uploadFingerprint([a, b]);
  assert.ok(both && both !== a && both !== b, "several sheets in one batch are one fingerprint of their own");
  assert.equal(uploadFingerprint([b, a]), both, "the order the sheets were chosen in does not change it");
  assert.equal(both, sha(`multi:${[a, b].sort().join(",")}`), "it is the SHA-256 of the sorted fingerprints");
}

function testOneUploadSplitIntoPartsTellsThemApart() {
  const one = [{ distributorCode: "IS", period: "2026-10" }];
  assert.equal(uploadPartQualifier(one[0], one), "", "an upload stored as one batch is not qualified");

  const byDistributor = [
    { distributorCode: "IS", period: "2026-10" },
    { distributorCode: "PS", period: "2026-10" },
  ];
  assert.equal(uploadPartQualifier(byDistributor[0], byDistributor), "distributor=IS");
  assert.equal(uploadPartQualifier(byDistributor[1], byDistributor), "distributor=PS");
  assert.ok(
    !uploadPartQualifier(byDistributor[0], byDistributor).includes("period"),
    "a template split only by distributor is not qualified by month, so the same template re-dated is still refused",
  );

  const byMonth = [
    { distributorCode: "IS", period: "2026-09" },
    { distributorCode: "IS", period: "2026-10" },
  ];
  assert.equal(uploadPartQualifier(byMonth[1], byMonth), "period=2026-10");

  const template = uploadFingerprint([APRIL], uploadPartQualifier(byDistributor[0], byDistributor));
  const sibling = uploadFingerprint([APRIL], uploadPartQualifier(byDistributor[1], byDistributor));
  assert.ok(template && sibling && template !== sibling, "two parts of one upload never share a fingerprint");
  assert.notEqual(template, APRIL, "a qualified part does not read as the bare file");

  // The second part of the SAME upload must not read as the first one's file under another distributor.
  const firstPartStored = stored({ distributor_code: "IS", file_sha256: template, period: "2026-10" });
  assert.equal(
    pickFingerprintClash([firstPartStored], { distributorCode: "PS", fileSha256: sibling, period: "2026-10" }),
    null,
    "the second part of one upload is not refused as the first part's bytes",
  );
}

function testTheSameBytesUnderAnotherMonthAreRefusedWhateverTheName() {
  const clash = pickFingerprintClash([stored()], { distributorCode: "IS-S", fileSha256: APRIL, period: "2026-05" });
  assert.ok(clash, "the same bytes under another month are refused, renamed or not (the guard never reads the name)");
  assert.equal(clash.id, "batch-april");
  assert.equal(clash.period, "2026-04");
  assert.equal(clash.matchedBy, "fingerprint");
  assert.equal(clash.distributorName, "Ibn Sina Specialty");
}

function testTheSameBytesForAnotherDistributorAreRefused() {
  const clash = pickFingerprintClash([stored()], { distributorCode: "IS", fileSha256: APRIL, period: "2026-04" });
  assert.ok(clash, "the same bytes filed under another distributor, same month, are refused");
  assert.equal(clash.distributorCode, "IS-S");
}

function testTheSameDistributorAndMonthIsTheReplaceFlow() {
  assert.equal(
    pickFingerprintClash([stored()], { distributorCode: "IS-S", fileSha256: APRIL, period: "2026-04" }),
    null,
    "re-uploading the same file for the same distributor and month replaces it — never refused",
  );
  assert.equal(
    pickFingerprintClash([stored()], { distributorCode: " is-s ", fileSha256: APRIL.toUpperCase(), period: "2026-04" }),
    null,
    "the distributor code and the fingerprint are compared in one case",
  );
}

function testABlockedBatchAndAnUnfingerprintedOneNeverMatch() {
  assert.equal(
    pickFingerprintClash([stored({ status: "blocked" })], { distributorCode: "IS-S", fileSha256: APRIL, period: "2026-05" }),
    null,
    "a blocked batch never became sales",
  );
  assert.equal(
    pickFingerprintClash([stored({ file_sha256: null })], { distributorCode: "IS-S", fileSha256: APRIL, period: "2026-05" }),
    null,
    "a batch stored before 14 Nov 2026 has no fingerprint and is left to the name-and-figures rule",
  );
  assert.equal(
    pickFingerprintClash([stored()], { distributorCode: "IS-S", fileSha256: null, period: "2026-05" }),
    null,
    "a save with no fingerprint compares none",
  );
  assert.equal(
    pickFingerprintClash([stored({ file_sha256: sha("another file") })], { distributorCode: "IS-S", fileSha256: APRIL, period: "2026-05" }),
    null,
    "different bytes are not a match",
  );
}

function testTheRefusalNamesTheUploadItRepeats() {
  const clash = pickFingerprintClash([stored()], { distributorCode: "IS-S", fileSha256: APRIL, period: "2026-05" });
  assert.ok(clash);
  const message = fingerprintClashMessage(clash, { distributorCode: "IS-S", period: "2026-05" });
  assert.match(message, /Ibn Sina Specialty for 2026-04/, "it names the distributor and month of the upload it repeats");
  assert.match(message, /"Monthly_Sales_by_Client_for_SATO_PHARMA_\(PAS\)\.xlsx"/, "it names that upload's file");
  assert.match(message, /uploaded 3 Jun 2026/, "it gives the day it was uploaded, in Cairo");
  assert.match(message, /whatever the file is called now/, "it says a new name does not make it a new file");
  assert.match(message, /import it under that month instead/, "same distributor: it says how to replace that month");

  const other = pickFingerprintClash([stored()], { distributorCode: "IS", fileSha256: APRIL, period: "2026-04" });
  assert.ok(other);
  assert.match(
    fingerprintClashMessage(other, { distributorCode: "IS", period: "2026-04" }),
    /filed under the wrong distributor/,
    "another distributor: it says how to file it under the right one",
  );
}

type GuardInput = Parameters<typeof assertNotADuplicateUpload>[0];
const openMonth = {
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
} as unknown as PeriodLockReader;

async function testTheDoorHandsTheFingerprintToTheGuard() {
  const seen: GuardInput[] = [];
  const seams = {
    lockReader: openMonth,
    loadPrices: async () => productPeriodPricesFromRows([{ productCode: "IV001", factoryPrice: 10 }], []),
    assertNotADuplicate: async (input: GuardInput) => void seen.push(input),
  };
  const rows = [{ areaCode: "A01", distributorCode: "IS-S", productCode: "IV001", qty: 1, value: 10, invoicePeriod: "2026-05" }];
  const input = {
    period: "2026-05",
    distributorCode: "IS-S",
    fileName: "renamed copy.xlsx",
    sheetRows: rows,
    countsAsSales: true,
    deductionMonthOf: (row: (typeof rows)[number]) => row.invoicePeriod,
    priceMonthOf: (row: (typeof rows)[number]) => row.invoicePeriod,
    priceDistributorOf: (row: (typeof rows)[number]) => row.distributorCode,
    totalRows: rows.length,
  };
  await applyImportStoreRules({ ...input, fileSha256: APRIL }, seams);
  assert.equal(seen[0]?.fileSha256, APRIL, "the door hands the guard the fingerprint it was given");
  await applyImportStoreRules(input, seams);
  assert.equal(seen[1]?.fileSha256, null, "a save with no fingerprint hands the guard none");
}

function testTheGuardChecksTheBytesFirstAndCannotPassOnAnError() {
  const guard = read("src/lib/sales/import-duplicate-guard.ts");
  const assertBody = guard.slice(guard.indexOf("export async function assertNotADuplicateUpload"));
  assert.ok(
    assertBody.indexOf("findFingerprintClash(input)") > -1 &&
      assertBody.indexOf("findFingerprintClash(input)") < assertBody.indexOf("findDuplicateUploadBatch(input)"),
    "the same bytes are checked before name and figures",
  );
  assert.match(guard, /\.eq\("file_sha256", digest\)/, "the lookup asks for the fingerprint across every distributor");
  const lookup = guard.slice(guard.indexOf("export async function findFingerprintClash"), guard.indexOf("function cairoDay"));
  assert.ok(!lookup.includes('.eq("distributor_code"'), "the lookup is not narrowed to one distributor: another distributor's copy must be found");
  assert.match(lookup, /throw new SalesWorkflowError\(\s*"duplicate_check_failed"/, "a lookup that cannot read refuses, never passes");
}

function testEveryFrontDoorFingerprintsTheChosenBytes() {
  const monthly = read("src/lib/sales/monthly-distributor-import.ts");
  assert.match(monthly, /persistDistributorSalesUpload\(\{ \.\.\.parsed, fileSha256: fileSha256\(buffer\) \}/, "Monthly Import fingerprints the file it read");
  assert.match(monthly, /fileSha256: input\.fileSha256 \?\? fileSha256\(input\.buffer\)/, "the buffer import takes the caller's fingerprint, else hashes the chosen bytes");

  const office = read("src/lib/sales/office-upload.ts");
  assert.match(office, /persistOfficeAllocation\(\{ \.\.\.result, fileSha256: fileSha256\(input\.buffer\) \}/, "the Office upload fingerprints its workbook");

  const upload = read("src/lib/sales/sales-upload.ts");
  assert.match(upload, /fileSha256: fileSha256\(await input\.file\.arrayBuffer\(\)\)/, "the Sales Upload's one sheet is fingerprinted");
  assert.match(upload, /fileSha256: uploadFingerprint\(memberDigests\)/, "several sheets are fingerprinted by the files in each batch");
  assert.match(upload, /memberDigests\.push\(fileSha256\(await files\[i\]\.arrayBuffer\(\)\)\)/, "each batch's own member files, never the whole upload");

  const sos = read("src/lib/sales/source-of-sales-upload.ts");
  assert.match(sos, /fileSha256: fileSha256\(await input\.file\.arrayBuffer\(\)\)/, "the Source of Sales raw import fingerprints the chosen file, not its coded copy");

  for (const route of ["app/api/sales/normalizer/import/route.ts", "app/api/sales/normalizer/import-validated/route.ts"]) {
    const text = read(route);
    assert.match(
      text,
      /fileSha256: uploadFingerprint\(await digestsOfNamedFiles\(files, part\.fileNames\), uploadPartQualifier\(part, parts\)\)/,
      `${route} fingerprints the chosen sheets of each part, told apart from the other parts`,
    );
    assert.ok(!/fileSha256\(part\.buffer/.test(text), `${route} never fingerprints the coded copy, which hashes differently every run`);
  }

  // Both writers store the fingerprint and hand it to the door.
  const normalizer = read("src/lib/sales/normalizer/service.ts");
  for (const [name, text, given] of [
    ["persistDistributorSalesUpload", monthly, "result.fileSha256 ?? null"],
    ["persistNormalizedBatch", normalizer, "input.fileSha256 ?? null"],
  ] as const) {
    const start = text.indexOf(`export async function ${name}`);
    const body = text.slice(start, text.indexOf(".select(", text.indexOf('.from("source_of_sales_import_batches")', start)));
    assert.ok(body.includes(`fileSha256: ${given},\n  });`), `${name} hands the door the fingerprint`);
    assert.ok(body.includes(`file_sha256: ${given},`), `${name} stores the fingerprint on the batch`);
  }
}

function testTheUploadedSheetsListShowsIt() {
  const monthly = read("src/lib/sales/monthly-distributor-import.ts");
  assert.match(monthly, /fileSha256: typeof row\.file_sha256 === "string" && row\.file_sha256 \? row\.file_sha256 : null/, "the list reads the stored fingerprint");
  const panel = read("src/components/sales/uploaded-sheets-panel.tsx");
  assert.match(panel, /Fingerprint \{shortFingerprint\(batch\.fileSha256\)\}/, "the desktop table shows it under the file name");
  assert.match(panel, /label: "Fingerprint", value: shortFingerprint\(batch\.fileSha256\)/, "the phone card shows it");
  assert.match(panel, /title=\{batch\.fileSha256\}/, "the whole fingerprint is the tooltip");
}

function testTheMigrationAddsTheColumn() {
  const sql = read("supabase/migrations/20261114070433_sos_import_batch_file_sha256.sql");
  assert.match(sql, /add column if not exists file_sha256 text;/, "a nullable text column: nothing is invented for older batches");
  assert.match(sql, /on public\.source_of_sales_import_batches \(file_sha256\)\s+where file_sha256 is not null;/, "a partial index serves the lookup");
}

export async function runUploadFingerprintTests() {
  testTheFingerprintIsTheFilesOwnSha256();
  testSeveralSheetsFingerprintTogetherInAnyOrder();
  testOneUploadSplitIntoPartsTellsThemApart();
  testTheSameBytesUnderAnotherMonthAreRefusedWhateverTheName();
  testTheSameBytesForAnotherDistributorAreRefused();
  testTheSameDistributorAndMonthIsTheReplaceFlow();
  testABlockedBatchAndAnUnfingerprintedOneNeverMatch();
  testTheRefusalNamesTheUploadItRepeats();
  await testTheDoorHandsTheFingerprintToTheGuard();
  testTheGuardChecksTheBytesFirstAndCannotPassOnAnError();
  testEveryFrontDoorFingerprintsTheChosenBytes();
  testTheUploadedSheetsListShowsIt();
  testTheMigrationAddsTheColumn();
}
