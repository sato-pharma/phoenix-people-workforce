import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { PDFDocument } from "pdf-lib";

import {
  BULK_PRINT_CONCURRENCY,
  bulkPrintFileName,
  bulkPrintUrl,
  filterBulkCandidates,
  joinPdfs,
  runPool,
} from "../src/lib/hiring-pack/bulk-print.ts";

// Printing one HR paper for many employees at once — the owner's ask of 2026-10-04: "print contract
// or form1 or 6 or any other form for 15 20 maybe 30 employee at once".
//
// What is pinned: the request is the SINGLE-print route's own (so numbering, versions and the
// permission check cannot be skipped), a stamp is never inherited by thirty papers, the pool keeps the
// order people were selected in and survives one failure, and the join really is one PDF whose
// double-sided pairing holds.

async function pdfOf(pageCount: number, size: [number, number]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage(size);
  return document.save();
}

function testTheRequestIsTheSinglePrintRoute() {
  const url = bulkPrintUrl({
    address: "office",
    copies: 3,
    document: "form1",
    hrId: "A-12",
    versionId: null,
  });
  const parsed = new URL(url, "https://example.test");
  assert.equal(parsed.pathname, "/api/hiring-pack/A-12/print", "must reuse the single-print route");
  assert.equal(parsed.searchParams.get("document"), "form1");
  assert.equal(parsed.searchParams.get("copies"), "3");
  assert.equal(parsed.searchParams.get("format"), "pdf", "the join needs a PDF per person");
  assert.equal(parsed.searchParams.get("address"), "office");
  assert.equal(parsed.searchParams.get("version"), null, "no version means the one the employee signed");
  assert.equal(
    parsed.searchParams.get("marks"),
    null,
    "a stamp is ticked for ONE print, never inherited by every paper in a run",
  );
  assert.equal(parsed.searchParams.get("preview"), null, "a preview would skip the paper number");

  const template = new URL(
    bulkPrintUrl({
      address: null,
      copies: 0,
      document: "custom:1857bafe-d3f9-4576-a850-abe82f884f0d",
      hrId: "B 10/x",
      versionId: "ver-1",
    }),
    "https://example.test",
  );
  assert.equal(template.pathname, "/api/hiring-pack/B%2010%2Fx/print", "an HR id is encoded, not trusted");
  assert.equal(template.searchParams.get("document"), "custom:1857bafe-d3f9-4576-a850-abe82f884f0d");
  assert.equal(template.searchParams.get("version"), "ver-1");
  assert.equal(template.searchParams.get("copies"), "1", "a run never asks for fewer than one copy");
  assert.equal(template.searchParams.get("address"), null);
}

function testTheFileNameIsAsciiAndDated() {
  assert.equal(bulkPrintFileName("form6", 25, "2026-10-04"), "form6-25-employees-2026-10-04.pdf");
  const custom = bulkPrintFileName("custom:1857bafe-d3f9", 3, "2026-10-04");
  assert.ok(!custom.includes(":"), "a colon is not legal in a Windows file name");
  assert.match(custom, /^[A-Za-z0-9._-]+$/u);
}

function testTheListFiltersByTextAndScope() {
  const people = [
    { departed: false, fullName: "Kareem Fouad", hrId: "A-1", jobTitle: "Medical Representative", nameAr: "كريم فؤاد" },
    { departed: true, fullName: "Mona Samir", hrId: "A-2", jobTitle: "District Manager", nameAr: null },
    { departed: false, fullName: "Omar Adel", hrId: "B-7", jobTitle: null, nameAr: "عمر عادل" },
  ];
  const ids = (list: typeof people) => list.map((person) => person.hrId);
  assert.equal(filterBulkCandidates(people, "", "all").length, 3, "a blank search keeps everyone");
  assert.deepEqual(ids(filterBulkCandidates(people, "", "left")), ["A-2"]);
  assert.deepEqual(ids(filterBulkCandidates(people, "", "current")), ["A-1", "B-7"]);
  assert.deepEqual(ids(filterBulkCandidates(people, "KAREEM", "all")), ["A-1"]);
  assert.deepEqual(ids(filterBulkCandidates(people, "عمر", "all")), ["B-7"]);
  assert.deepEqual(ids(filterBulkCandidates(people, "district", "all")), ["A-2"]);
  assert.deepEqual(ids(filterBulkCandidates(people, "b-7", "all")), ["B-7"]);
  assert.deepEqual(
    filterBulkCandidates(people, "mona", "current"),
    [],
    "the scope applies on top of the search, not instead of it",
  );
}

async function testThePoolKeepsOrderAndSurvivesOneFailure() {
  const items = [0, 1, 2, 3, 4, 5, 6];
  let inFlight = 0;
  let peak = 0;
  const progress: number[] = [];

  const results = await runPool<number, string>(
    items,
    BULK_PRINT_CONCURRENCY,
    async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Earlier items take LONGER, so completion order is not input order.
      await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 3));
      inFlight -= 1;
      if (item === 3) throw new Error("no record");
      return `ok-${item}`;
    },
    (item) => `failed-${item}`,
    (finished) => progress.push(finished),
  );

  assert.deepEqual(
    results,
    ["ok-0", "ok-1", "ok-2", "failed-3", "ok-4", "ok-5", "ok-6"],
    "results follow the order people were SELECTED in, and one failure leaves the other six alone",
  );
  assert.ok(peak <= BULK_PRINT_CONCURRENCY, `${peak} renders ran at once; the limit is ${BULK_PRINT_CONCURRENCY}`);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7], "progress counts every completion exactly once");

  const empty = await runPool<number, string>([], 2, async () => "x", () => "e");
  assert.deepEqual(empty, [], "an empty selection is an empty run, not a hang");
}

async function testTheJoinIsOnePdfAndKeepsTheDuplexPairing() {
  const legal: [number, number] = [612.12, 1008.12];
  const a4: [number, number] = [595.28, 841.89];

  // Form 1 / Form 6 shape: two pages a copy, three copies — even by construction.
  const form = await pdfOf(6, legal);
  const joinedForms = await joinPdfs([form, form, form], { startEachOnNewSheet: true });
  assert.equal(joinedForms.pages, 18, "an even paper never gains a blank page");
  const reloaded = await PDFDocument.load(joinedForms.bytes);
  assert.equal(reloaded.getPageCount(), 18);
  assert.deepEqual(
    [reloaded.getPage(0).getWidth(), reloaded.getPage(0).getHeight()].map((value) => Math.round(value * 100)),
    [61212, 100812],
    "the official US Legal size is copied as issued, never reflowed",
  );

  // A three-page contract is odd: with the option each person starts on a fresh sheet.
  const contract = await pdfOf(3, a4);
  const padded = await joinPdfs([contract, contract], { startEachOnNewSheet: true });
  assert.equal(padded.pages, 8, "an odd paper gets one blank back page so the next person starts a sheet");
  const paddedDoc = await PDFDocument.load(padded.bytes);
  assert.equal(
    Math.round(paddedDoc.getPage(3).getWidth() * 100),
    Math.round(a4[0] * 100),
    "the blank page matches the paper it follows",
  );

  const plain = await joinPdfs([contract, contract], { startEachOnNewSheet: false });
  assert.equal(plain.pages, 6, "without the option the papers run on, exactly as the pages came");

  const none = await joinPdfs([], { startEachOnNewSheet: true });
  assert.equal(none.pages, 0);
}

function testTheDriveOffersItAndTheUiKeepsItsPromises() {
  const drive = readFileSync(new URL("../src/components/hiring-pack/forms-drive.tsx", import.meta.url), "utf8");
  assert.ok(drive.includes("<BulkPrintPanel"), "the HR Forms drive must offer printing for many");
  assert.ok(drive.includes('value: "bulk"'), "the drive's fill modes must include printing for many");

  const panel = readFileSync(new URL("../src/components/hiring-pack/bulk-print-panel.tsx", import.meta.url), "utf8");
  assert.ok(panel.includes("<PrintOptionsDialog"), "the copies and address questions are asked before any paper prints");
  assert.ok(panel.includes("documentTakesAddressChoice"), "Form 1 and Form 6 never carry the address choice");
  assert.ok(panel.includes("PAPER_ISSUED_EVENT"), "the paper register refreshes after a run");
  assert.ok(!panel.includes("overflow-x-auto"), "the fits-the-screen rule: never a horizontal scroll");
  assert.ok(!/rounded-(lg|md|xl|full)/u.test(panel), "the square-edge rule: no rounded corners");
}

export async function runHrFormsBulkPrintTests() {
  testTheRequestIsTheSinglePrintRoute();
  testTheFileNameIsAsciiAndDated();
  testTheListFiltersByTextAndScope();
  await testThePoolKeepsOrderAndSurvivesOneFailure();
  await testTheJoinIsOnePdfAndKeepsTheDuplexPairing();
  testTheDriveOffersItAndTheUiKeepsItsPromises();
}
