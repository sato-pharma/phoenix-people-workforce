import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { filterCustomerSubjectsForViewer } from "../src/lib/customer-360/access.ts";
import {
  buildCustomerSalesView,
  type CustomerSalesRollupRow,
} from "../src/lib/customer-360/sales-visibility.ts";
import type { CustomerSubjectSummary } from "../src/lib/customer-360/service.ts";
import {
  validationStatusLabel,
  venueTypeLabel,
} from "../src/lib/customer-360/labels.ts";
import {
  decodeCustomerSubjectId,
  encodeCustomerSubjectId,
} from "../src/lib/customer-360/subject.ts";

const UUID_A = "11111111-2222-3333-4444-555555555555";

/**
 * The shape production actually returns, measured 2026-09-03: Head Office reports its whole value
 * in BOTH value_all and value_restricted, and every tracked line reports 0 restricted.
 */
const PRODUCTION_SHAPED_ROWS: CustomerSalesRollupRow[] = [
  { officialLine: "Head Office", period: "2026-07", unitsAll: 100, unitsRestricted: 100, valueAll: 4000, valueRestricted: 4000 },
  { officialLine: "Pedia", period: "2026-07", unitsAll: 30, unitsRestricted: 0, valueAll: 1400, valueRestricted: 0 },
  { officialLine: "CNS", period: "2026-08", unitsAll: 20, unitsRestricted: 0, valueAll: 900, valueRestricted: 0 },
];

function subject(overrides: Partial<CustomerSubjectSummary>): CustomerSubjectSummary {
  return {
    areaCode: "GZ3",
    areaName: "Giza 3",
    codeCount: 1,
    displayName: "Test Pharmacy",
    id: encodeCustomerSubjectId({ recordId: UUID_A, register: "marketing" }),
    lineName: "Pedia",
    ownerName: null,
    register: "marketing",
    regionName: "Giza",
    validationStatus: null,
    venueType: null,
    ...overrides,
  };
}

export function runCustomer360Tests() {
  // ── The money trap ────────────────────────────────────────────────────────────────────────────
  // `value_restricted` READS like "the safe figure" and IS the confidential money. Showing it to a
  // District Manager would show him a number that is 100% Head Office.
  const dmView = buildCustomerSalesView(PRODUCTION_SHAPED_ROWS, "District Manager");

  assert.equal(
    dmView.confidentialLines.length,
    0,
    "a role that may not see Head Office must never receive a Head Office line",
  );
  assert.equal(
    dmView.trackedValue,
    2300,
    "the tracked total must be the tracked lines only (1400 + 900), never Head Office money",
  );
  assert.ok(
    !dmView.trackedLines.some((line) => line.line.toLowerCase().includes("head office")),
    "Head Office must not appear among the tracked lines for an unprivileged viewer",
  );
  assert.equal(dmView.confidentialWithheld, true, "the viewer must be told confidential sales exist");

  // A privileged viewer sees Head Office, but it still never joins the headline total.
  const ceoView = buildCustomerSalesView(PRODUCTION_SHAPED_ROWS, "CEO");
  assert.equal(ceoView.confidentialLines.length, 1, "CEO may see the Head Office line");
  assert.equal(ceoView.confidentialLines[0]?.value, 4000, "the Head Office figure is shown in full to the CEO");
  assert.equal(
    ceoView.trackedValue,
    2300,
    "Head Office is kept OUT of the tracked total for every role, privileged or not",
  );
  assert.equal(ceoView.confidentialWithheld, false, "nothing is withheld from a viewer who may see it");

  // A restricted PRODUCT inside a tracked line is withheld the day it appears, not the day it is
  // noticed: the unprivileged total subtracts the restricted part of a tracked line too.
  const mixed = buildCustomerSalesView(
    [{ officialLine: "CNS", period: "2026-08", unitsAll: 50, unitsRestricted: 10, valueAll: 1000, valueRestricted: 400 }],
    "District Manager",
  );
  assert.equal(mixed.trackedValue, 600, "a restricted product inside a tracked line must be subtracted");
  assert.equal(mixed.confidentialWithheld, true, "and the viewer must be told something was withheld");

  // ── The picker is not wider than its viewer ───────────────────────────────────────────────────
  const inArea = subject({ areaCode: "GZ3", displayName: "In my area" });
  const elsewhere = subject({
    areaCode: "ALX1",
    areaName: "Alex 1",
    displayName: "Someone else's customer",
    id: encodeCustomerSubjectId({ recordId: "99999999-8888-7777-6666-555555555555", register: "direct-order" }),
    regionName: "Alex-BHR",
  });

  const areaScoped = filterCustomerSubjectsForViewer([inArea, elsewhere], {
    allowedAreaCodes: new Set(["gz3"]),
    allowedLineNames: null,
    allowedRegionNames: null,
    canViewAllSales: false,
  });
  assert.deepEqual(
    areaScoped.map((entry) => entry.displayName),
    ["In my area"],
    "an area-bounded viewer is offered only customers in that area (and the match is case-insensitive)",
  );

  // The headline guard: no bound at all must mean NOTHING, never the whole company.
  const unbounded = filterCustomerSubjectsForViewer([inArea, elsewhere], {
    allowedAreaCodes: null,
    allowedLineNames: null,
    allowedRegionNames: null,
    canViewAllSales: false,
  });
  assert.deepEqual(unbounded, [], "a viewer with no resolved scope must be offered NO customers, not all of them");

  assert.equal(
    filterCustomerSubjectsForViewer([inArea, elsewhere], {
      allowedAreaCodes: null,
      allowedLineNames: null,
      allowedRegionNames: null,
      canViewAllSales: true,
    }).length,
    2,
    "a company-scope viewer is offered every customer",
  );

  // A direct-order pharmacy declares no line; a line bound must not silently hide it.
  const noLine = subject({ displayName: "Direct order pharmacy", lineName: null, register: "direct-order" });
  assert.equal(
    filterCustomerSubjectsForViewer([noLine], {
      allowedAreaCodes: null,
      allowedLineNames: new Set(["CNS"]),
      allowedRegionNames: new Set(["Giza"]),
      canViewAllSales: false,
    }).length,
    1,
    "a customer that declares no line must not be dropped by a line bound",
  );

  // ── Subject identity ──────────────────────────────────────────────────────────────────────────
  const ref = { recordId: UUID_A, register: "direct-order" as const };
  assert.deepEqual(decodeCustomerSubjectId(encodeCustomerSubjectId(ref)), ref, "subject ids round-trip");
  assert.equal(decodeCustomerSubjectId("mkt_not-a-uuid"), null, "a non-UUID id is refused");
  assert.equal(decodeCustomerSubjectId("../../etc/passwd"), null, "a path-shaped id is refused");
  assert.equal(decodeCustomerSubjectId(""), null, "an empty id is refused");
  assert.notEqual(
    encodeCustomerSubjectId({ recordId: UUID_A, register: "marketing" }),
    encodeCustomerSubjectId({ recordId: UUID_A, register: "direct-order" }),
    "the same uuid in the two registers must never collapse to one subject",
  );

  // ── The page must not re-derive territory ─────────────────────────────────────────────────────
  const serviceSource = readFileSync(
    path.join(process.cwd(), "src", "lib", "customer-360", "service.ts"),
    "utf8",
  );
  assert.ok(
    serviceSource.includes("resolveCustomerGeography("),
    "Customer 360 must resolve territory through the shared place resolver, not its own query",
  );
  assert.ok(
    !/\.in\(\s*["']distributor_code["']/.test(serviceSource),
    "Customer 360 must never pair-match with two independent .in() filters",
  );

  // ── No raw code reaches the screen ────────────────────────────────────────────────────────────
  // The owner's standing rule is human-readable names, never raw codes. Two live values also carry
  // a meaning their plain English reading gets backwards, and both are pinned by name.
  for (const raw of ["pending", "system_validated", "sfe_validated"]) {
    const label = validationStatusLabel(raw);
    assert.ok(label && !label.includes("_"), `validation status "${raw}" must not render as a raw code`);
  }
  for (const raw of ["pharmacy", "nursery"]) {
    const label = venueTypeLabel(raw);
    assert.ok(label && !label.includes("_"), `venue type "${raw}" must not render as a raw code`);
  }

  // `system_validated` means NO HUMAN LOOKED. A bare "System validated" reads as an assurance,
  // which is the opposite of what the value records, so the label must say so outright.
  assert.match(
    validationStatusLabel("system_validated") ?? "",
    /no human review/i,
    "system_validated must never be presented as though a person had checked it",
  );

  // `nursery` is the owner's own filing for a venue with no distributor account — a clinic filed
  // this way is CORRECT. The label has to carry that, or the next reader "fixes" five right rows.
  assert.match(
    venueTypeLabel("nursery") ?? "",
    /no distributor account/i,
    "nursery must explain itself, or it reads as a data-quality defect it is not",
  );

  // A value nobody has mapped yet still arrives as English, never as a code and never as a blank.
  assert.equal(validationStatusLabel("field_validated"), "Field validated", "an unmapped status is humanised");
  assert.equal(venueTypeLabel(null), null, "an absent value stays absent rather than becoming a label");
}
