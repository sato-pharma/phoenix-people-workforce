import assert from "node:assert/strict";

import {
  aliasDistributorLookupKey,
  aliasProductLookupKey,
  resolveDistributorRegistryName,
  buildRoiImportPreview,
  mapSheetRequestType,
  mapSheetStatus,
  normalizeCustomerCode,
  parseRoiSheetRows,
  recoverSwappedDates,
  type RoiImportLookups,
  type RoiSheetRawRow,
} from "../src/lib/marketing-requests/roi-sheet-import.ts";

function lookups(): RoiImportLookups {
  return {
    productByCode: new Map([
      ["LA001", { id: 20, factoryPrice: 225.06 }],
      ["GU001", { id: 19, factoryPrice: 60.75 }],
      ["IV001", { id: 18, factoryPrice: 30.375 }],
      ["SA001", { id: 16, factoryPrice: 126.72 }],
      ["RO001", { id: 17, factoryPrice: 60.7 }],
    ]),
    productByName: new Map([
      ["lacto advanced 1", { id: 20, factoryPrice: 225.06 }],
      ["guamusin", { id: 19, factoryPrice: 60.75 }],
      ["ivyronc", { id: 18, factoryPrice: 30.375 }],
      ["saginko", { id: 16, factoryPrice: 126.72 }],
    ]),
    requestTypeIdByCode: new Map([
      ["special_request", 1],
      ["deal", 3],
      ["conference", 5],
      ["other", 6],
    ]),
    employeeHrIds: new Set(["B-74", "B-5"]),
    knownPharmacyCodes: new Set(["1569882", "1544892"]),
  };
}

export function runMarketingRoiSheetImportTests() {
  // --- normalizeCustomerCode: padding + numeric-vs-junk ---
  assert.deepEqual(normalizeCustomerCode("0001569882"), {
    raw: "0001569882",
    matchKey: "1569882",
  });
  assert.deepEqual(normalizeCustomerCode(429182), { raw: "429182", matchKey: "429182" });
  assert.deepEqual(normalizeCustomerCode("429182.0"), { raw: "429182", matchKey: "429182" });
  // Arabic text in the code column is junk -> no match key.
  assert.equal(normalizeCustomerCode("المعادى").matchKey, null);

  // --- dd/mm date-swap recovery ---
  const md = (d: Date | null) => (d ? `${d.getMonth() + 1}-${d.getDate()}` : null);
  // No anomaly -> untouched.
  let rec = recoverSwappedDates(new Date("2026-05-16"), new Date("2026-05-23"));
  assert.equal(rec.dateSwapApplied, false);
  assert.equal(md(rec.requestDate), "5-16");
  // Future-looking request (Nov 5) with earlier pay (May 16): swap request -> May 11.
  rec = recoverSwappedDates(new Date("2026-11-05"), new Date("2026-05-16"));
  assert.equal(rec.dateSwapApplied, true);
  assert.equal(md(rec.requestDate), "5-11");
  assert.equal(md(rec.payDate), "5-16");
  // Request Jan 20 (day 20 unswappable) with pay Jan 3: swap pay -> Mar 1.
  rec = recoverSwappedDates(new Date("2026-01-20"), new Date("2026-01-03"));
  assert.equal(rec.dateSwapApplied, true);
  assert.equal(md(rec.payDate), "3-1");
  // Genuine 1-day reversal, both days > 12 -> cannot swap, left as-is for manual review.
  rec = recoverSwappedDates(new Date("2026-03-25"), new Date("2026-03-24"));
  assert.equal(rec.dateSwapApplied, false);
  assert.ok(rec.payDate && rec.requestDate && rec.payDate.getTime() < rec.requestDate.getTime());

  // --- product alias bridge ---
  assert.equal(aliasProductLookupKey("Saginkgo"), "saginko");
  assert.equal(aliasProductLookupKey("Lacto Advanced 1 "), "lacto advanced 1");

  // --- distributor alias bridge (sheet label -> registry normalized name) ---
  assert.equal(aliasDistributorLookupKey("IBNSINA "), "ibn sina");
  assert.equal(aliasDistributorLookupKey("EPDA Lacto "), "epda");
  assert.equal(aliasDistributorLookupKey("POS "), "overseas"); // POS aligned to Source-of-Sales "overseas"

  // --- distributor resolved by Distributor_ID (the system reference), name as fallback ---
  assert.equal(resolveDistributorRegistryName("IS", "IBNSINA"), "ibn sina");
  assert.equal(resolveDistributorRegistryName("EP", "EPDA Lacto"), "epda");
  assert.equal(resolveDistributorRegistryName("PS", null), "overseas");
  assert.equal(resolveDistributorRegistryName("CP", null), "chimipharm");
  // no code -> falls back to the (aliased) name; POS name resolves to overseas
  assert.equal(resolveDistributorRegistryName(null, "IBNSINA"), "ibn sina");
  assert.equal(resolveDistributorRegistryName(null, "POS"), "overseas");

  // --- label mapping ---
  assert.equal(mapSheetRequestType("Special request"), "special_request");
  assert.equal(mapSheetRequestType("0"), "other");
  assert.equal(mapSheetStatus("Approved by GM"), "approved");
  assert.equal(mapSheetStatus("Approved By SFE"), "pending_approval");
  assert.equal(mapSheetStatus("Declined"), "rejected");

  // --- grouping: header row + continuation product/pharmacy rows ---
  const rows: RoiSheetRawRow[] = [
    {
      requestCode: "REQ-001",
      name: "Ahmed.Abdallah",
      hrId: "B-74",
      contact: "Hospital",
      date: new Date("2026-01-15"),
      payDate: new Date("2026-01-18"),
      requestType: "Special request",
      duration: 3,
      roi: 21605.76,
      estimatedCost: 3600,
      productName: "Lacto Advanced 1 ",
      productId: "LA001",
      qty: 96,
      distributor: "POS ",
      distributorId: "PS",
      customerName: "Pharmacy A",
      customerCode: "0001569882",
      status: "Approved by GM",
    },
    // continuation: extra pharmacy (no product, no date)
    {
      requestCode: "REQ-001",
      customerName: "Pharmacy B",
      customerCode: "0001544892",
      distributor: "POS ",
      distributorId: "PS",
    },
    // second line-item under the same request code, with a continuation product row
    {
      requestCode: "REQ-002",
      name: "Ahmed.Abdallah",
      hrId: "B-74",
      contact: "Dr. X",
      date: new Date("2026-01-20"),
      payDate: new Date("2026-01-03"), // pay before request -> recovered via dd/mm swap
      requestType: "Deal",
      duration: 3,
      roi: 13668.75,
      estimatedCost: 2000,
      productName: "Guamusin ",
      productId: "GU001",
      qty: 150,
      customerName: "Pharmacy C",
      customerCode: "999999", // unknown pharmacy -> non-blocking flag
    },
    {
      requestCode: "REQ-002",
      productName: "Ivyronc ",
      productId: "IV001",
      qty: 150,
    },
  ];

  const lines = parseRoiSheetRows(rows);
  assert.equal(lines.length, 2, "two Date rows -> two line-items");
  assert.equal(lines[0].products.length, 1);
  assert.equal(lines[0].pharmacies.length, 2, "header pharmacy + continuation pharmacy");
  assert.equal(lines[1].products.length, 2, "header product + continuation product");

  const preview = buildRoiImportPreview(lines, lookups());

  // Line 1: LA001 96 * 225.06 = 21605.76 -> matches sheet ROI exactly, no roi_mismatch.
  const l1 = preview.lines[0];
  assert.equal(l1.computedExpectedRoi, 21605.76);
  assert.ok(!l1.flags.includes("roi_mismatch"));
  assert.equal(l1.mappedStatus, "approved");
  // 21605.76 >= 3600*10 = 36000? No -> under_target.
  assert.equal(l1.roiStatus, "under_target");

  // Line 2: GU 150*60.75 + IV 150*30.375 = 13668.75 -> matches.
  // pay (Jan 3) was before request (Jan 20): the dd/mm swap recovers pay to Mar 1, so the
  // row is flagged date_swap_applied and NO LONGER pay_before_request_date.
  const l2 = preview.lines[1];
  assert.equal(l2.computedExpectedRoi, 13668.75);
  assert.ok(!l2.flags.includes("roi_mismatch"));
  assert.ok(l2.flags.includes("date_swap_applied"));
  assert.ok(!l2.flags.includes("pay_before_request_date"), "swap resolved the anomaly");
  assert.equal(lines[1].payDate?.getMonth(), 2, "pay date recovered to March (month index 2)");
  assert.equal(lines[1].payDate?.getDate(), 1);
  assert.ok(l2.flags.includes("unresolved_pharmacy"));
  assert.equal(l2.unresolvedPharmacyCount, 1);

  // Summary: both lines importable (no blocking flags), 2 requester rows deduped to 1.
  assert.equal(preview.summary.totalLines, 2);
  assert.equal(preview.summary.importable, 2);
  assert.equal(preview.summary.distinctRequestCodes, 2);
  assert.equal(preview.summary.distinctRequesters, 1);

  // --- policy: an unresolved product is ADVISORY (flag), not a blocker ---
  // System is source of truth: the unknown product contributes 0 value, the row still
  // imports with a flag for manager review.
  const advisoryRows: RoiSheetRawRow[] = [
    {
      requestCode: "REQ-098",
      hrId: "B-74", // valid requester
      date: new Date("2026-02-01"),
      requestType: "Special request",
      roi: 1000,
      estimatedCost: 100,
      productName: "Unknown Product",
      productId: "ZZ001",
      qty: 10,
    },
  ];
  const advisoryPreview = buildRoiImportPreview(parseRoiSheetRows(advisoryRows), lookups());
  assert.ok(advisoryPreview.lines[0].flags.includes("unresolved_product"));
  assert.equal(
    advisoryPreview.summary.importable,
    1,
    "unresolved product is advisory — the row still imports",
  );

  // --- code-first bridge: a messy display name resolves via its clean Product_ID ---
  const messyNameRows: RoiSheetRawRow[] = [
    {
      requestCode: "REQ-097",
      hrId: "B-74",
      date: new Date("2026-02-01"),
      requestType: "Special request",
      roi: 6070,
      estimatedCost: 100,
      productName: "Royafloxacin 500 tab", // not a catalog name
      productId: "RO001", // but the code is clean
      qty: 100,
    },
  ];
  const messyPreview = buildRoiImportPreview(parseRoiSheetRows(messyNameRows), lookups());
  assert.ok(
    !messyPreview.lines[0].flags.includes("unresolved_product"),
    "RO001 resolves by code despite the messy display name",
  );
  assert.equal(messyPreview.lines[0].computedExpectedRoi, 6070); // 100 * 60.70

  // --- blocking: only a structurally impossible row (unknown requester) is kept out ---
  const blockedRows: RoiSheetRawRow[] = [
    {
      requestCode: "REQ-099",
      hrId: "Z-999", // not in employees -> requester FK cannot be satisfied
      date: new Date("2026-02-01"),
      requestType: "Special request",
      roi: 1000,
      estimatedCost: 100,
      productName: "Guamusin ",
      productId: "GU001",
      qty: 10,
    },
  ];
  const blockedPreview = buildRoiImportPreview(parseRoiSheetRows(blockedRows), lookups());
  assert.ok(blockedPreview.lines[0].flags.includes("unknown_requester"));
  assert.equal(blockedPreview.summary.importable, 0, "unknown requester blocks the row");
}
