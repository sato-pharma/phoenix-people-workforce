import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  applyLegacyMarketingAreaAlias,
  buildValidatedCustomerCompleteness,
  canOpenValidatedCustomerRegister,
  canTransferValidatedCustomers,
  getValidatedMarketingCustomerDetail,
  listValidatedMarketingCustomers,
  resolveTransferredVenueOwnerHrId,
  revertValidatedCustomerTransfer,
  transferValidatedCustomerToDirectOrders,
} from "../src/lib/marketing-requests/validated-customer-transfer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The admin Validated Customers register, and the hand-off to Direct Orders.
//
// Two things are pinned here, and they are the two that would actually cost something if they
// broke:
//
//   1. THE GATE, in two halves. READ (list, detail) admits Super Admin and SFE Manager — owner
//      decision 2026-09-21, "view only". WRITE (transfer, revert) stays Super Admin only — owner
//      ruling 2026-08-22: "Super admin only, SFE cannot do this thing." The transfer WRITES to a
//      second module, so a hole there is not a visibility bug, it is an unauthorized write. Each assertion drives the real service function; the gate throws before
//      any Supabase call, so no database is needed.
//
//   2. THE COMPLETENESS VERDICT. Its whole job is to tell a tired admin at 2am what the automatic
//      validation did NOT check. If a missing field silently reads as "ok", the screen becomes
//      worse than nothing, because it looks like a check happened.
//
// What is deliberately NOT asserted: that a blocker prevents a transfer. It must not. The owner
// ruled that the admin decides and the confirmation dialog is the only gate — "Don't block." The
// `blockerDoesNotImplyRefusal` case below pins that ruling so a later reader cannot "fix" the
// completeness panel into a hard gate.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles that must never reach this register at all — every role except Super Admin and SFE Manager. */
const FORBIDDEN_ROLES = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Finance Manager",
  "Training Manager",
  "HR Advisory",
  "HR Operations",
  "Manager",
  "CEO",
] as const;

/** May open the register and the detail. SFE Manager is VIEW ONLY (owner, 2026-09-21). */
const VIEW_ROLES = ["Super Admin", "SFE Manager"] as const;

/** May transfer and revert. Everyone else — the view-only SFE Manager included — is refused. */
const TRANSFER_ROLES = ["Super Admin"] as const;

/** Refused a transfer or a revert: every forbidden role, plus the view-only SFE Manager. */
const TRANSFER_FORBIDDEN_ROLES = [...FORBIDDEN_ROLES, "SFE Manager"] as const;

const SOME_CUSTOMER_ID = "00000000-0000-0000-0000-000000000001";
const SOME_TRANSFER_ID = "00000000-0000-0000-0000-000000000002";

/** A record with nothing missing, used as the baseline every failure case deviates from. */
function completeInput() {
  return {
    capturedAccuracyMeters: 12,
    capturedAddress: "1 Test Street, Shibin el Kom",
    capturedLatitude: 30.55,
    capturedLongitude: 31.01,
    contactMobile: "01000000000",
    contactName: "Dr Test",
    customerType: "account",
    displayName: "Test Pharmacy",
    distributorCode: "DIST-1",
    distributorCustomerCode: "CUST-1",
    duplicateCount: 0,
    evidenceStatus: "complete",
    hasEvidencePhoto: true,
    linkedPharmacyCount: 1,
    marketingAreaName: "Menoufia 1",
    resolvedAreaCode: "D12",
  };
}

function itemFor(result: ReturnType<typeof buildValidatedCustomerCompleteness>, key: string) {
  const item = result.items.find((entry) => entry.key === key);
  assert.ok(item, `completeness result must contain an item keyed "${key}"`);
  return item;
}

async function testReadGateRefusesNonAdmins() {
  for (const role of FORBIDDEN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => listValidatedMarketingCustomers(access),
      /Forbidden/i,
      `${role} must not be able to list every rep's validated customers`,
    );
  }
}

async function testDetailGateRefusesNonAdmins() {
  // The detail page returns a shop-front photo, an address and a mobile number for a customer
  // anywhere in the company. It is the widest read in the feature, so it gates like the rest.
  for (const role of FORBIDDEN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => getValidatedMarketingCustomerDetail(access, SOME_CUSTOMER_ID),
      /Forbidden/i,
      `${role} must not be able to open another rep's customer detail`,
    );
  }
}

async function testTransferGateRefusesNonAdmins() {
  for (const role of TRANSFER_FORBIDDEN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => transferValidatedCustomerToDirectOrders(access, { customerId: SOME_CUSTOMER_ID, venueType: "pharmacy" }),
      /Forbidden/i,
      `${role} must not be able to write a pharmacy into Direct Orders`,
    );
  }
}

// 🔴 A TRANSFER IS REFUSED UNTIL THE ADMIN SAYS PHARMACY OR NURSERY (2026-10-20). The row used to be written
// with no venue type, the column's default filed حضانه الجمعيه الشرعيه as a PHARMACY, and the Direct Order desk
// then refused to approve it for want of a code or a licence. Absent is unanswered, never "pharmacy". The
// refusal fires before any database read, so no database is needed here.
async function testTransferRefusesAnUnansweredVenueType() {
  const access = createAccessContext({ hrId: "TEST-1", role: "Super Admin" });
  for (const venueType of [null, undefined, "", "clinic", "Hospital"]) {
    await assert.rejects(
      () => transferValidatedCustomerToDirectOrders(access, { customerId: SOME_CUSTOMER_ID, venueType: venueType as string | null }),
      /pharmacy or nursery/i,
      `a transfer with venue type ${JSON.stringify(venueType)} must be refused, never filed as a pharmacy`,
    );
  }
}

// 🔴 A NURSERY IS NEVER TRANSFERRED FROM MARKETING (owner, 2026-10-21: "any thing with no distributor code
// never reach the marketing requests"). Refused before any database read, in the shared sentence and code.
async function testTransferRefusesANursery() {
  const access = createAccessContext({ hrId: "TEST-1", role: "Super Admin" });
  await assert.rejects(
    () => transferValidatedCustomerToDirectOrders(access, { customerId: SOME_CUSTOMER_ID, venueType: "nursery" }),
    (error: unknown) =>
      (error as { code?: string }).code === "venue_without_distributor_code"
      && /validated in Direct Orders/.test(String((error as Error).message)),
    "a nursery transfer must be refused as a venue without a distributor code",
  );
  const source = readFileSync(new URL("../src/lib/marketing-requests/validated-customer-transfer.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(!link \|\| !text\(link, "distributor_code_id"\)\) \{\s*\n\s*throw validationError\(/,
    "a customer whose venue link names no distributor code is refused too — the pharmacy path alone transfers",
  );
}

function testTransferFilesTheVenueWithTheAnsweredType() {
  const source = readFileSync(new URL("../src/lib/marketing-requests/validated-customer-transfer.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /trust_state: "provisional",\s*venue_type: venueType,/,
    "the Direct Order venue row carries the type the admin answered",
  );
  assert.match(
    source,
    /if \(venueRequiresDistributorCode\(venueType\) && distributorCode && distributorCustomerCode\)/,
    "a nursery has no distributor account, so no code is linked onto it",
  );
  const route = readFileSync(
    new URL("../app/api/marketing-requests/validated-customers/[id]/transfer/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /venueType: body\.venueType \?\? null/, "the route forwards the admin's answer to the service");
  const dialog = readFileSync(new URL("../src/components/marketing-requests/validated-customer-detail.tsx", import.meta.url), "utf8");
  assert.match(dialog, /useState<VenueTypeChoice>\(null\)/, "the dialog starts the venue type unanswered");
  assert.match(
    dialog,
    /disabled=\{busy \|\| !venueTypeIsAnswered\(venueType\) \|\| !choiceRequiresDistributorCode\(venueType\)\}/,
    "Yes, transfer it stays disabled until it is answered — and for a nursery, which is never transferred from Marketing (2026-10-21)",
  );
  assert.match(dialog, /JSON\.stringify\(\{ venueType \}\)/, "the dialog sends the answer");
}

async function testRevertGateRefusesNonAdmins() {
  for (const role of TRANSFER_FORBIDDEN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => revertValidatedCustomerTransfer(access, { transferId: SOME_TRANSFER_ID }),
      /Forbidden/i,
      `${role} must not be able to revert a transfer`,
    );
  }
}

function testAllowedRolesPassThePredicate() {
  for (const role of VIEW_ROLES) {
    assert.equal(
      canOpenValidatedCustomerRegister({ role, scope: "company" }),
      true,
      `${role} must be able to open the validated customer register`,
    );
  }
  for (const role of TRANSFER_ROLES) {
    assert.equal(canTransferValidatedCustomers({ role, scope: "company" }), true, `${role} must be able to transfer`);
  }
  for (const role of TRANSFER_FORBIDDEN_ROLES) {
    assert.equal(
      canTransferValidatedCustomers({ role, scope: "company" }),
      false,
      `${role} must not pass the transfer predicate`,
    );
  }
  // The headline of the 2026-09-21 decision: SFE sees the register and cannot press the button.
  assert.equal(canOpenValidatedCustomerRegister({ role: "SFE Manager", scope: "company" }), true);
  assert.equal(canTransferValidatedCustomers({ role: "SFE Manager", scope: "company" }), false);
  for (const role of FORBIDDEN_ROLES) {
    assert.equal(
      canOpenValidatedCustomerRegister({ role, scope: "company" }),
      false,
      `${role} must not pass the register predicate`,
    );
  }
  // The page guard and the service gate share this predicate; a system-scope caller passes both.
  assert.equal(canOpenValidatedCustomerRegister({ role: "Employee", scope: "system" }), true);
  assert.equal(canTransferValidatedCustomers({ role: "Employee", scope: "system" }), true);
}

function testCompleteRecordReportsNothingOutstanding() {
  const result = buildValidatedCustomerCompleteness(completeInput());
  assert.equal(result.blockers, 0, "a fully populated record must report no blockers");
  assert.equal(result.warnings, 0, "a fully populated record must report no warnings");
  assert.equal(result.isComplete, true, "a fully populated record must read as complete");
}

function testMissingNameIsABlocker() {
  const result = buildValidatedCustomerCompleteness({ ...completeInput(), displayName: null });
  assert.equal(itemFor(result, "name").severity, "blocker");
  assert.equal(result.isComplete, false);
}

function testMissingAddressIsABlocker() {
  const result = buildValidatedCustomerCompleteness({ ...completeInput(), capturedAddress: "   " });
  assert.equal(
    itemFor(result, "address").severity,
    "blocker",
    "a whitespace-only address must not count as an address",
  );
}

function testMissingGpsIsABlocker() {
  const result = buildValidatedCustomerCompleteness({
    ...completeInput(),
    capturedLatitude: null,
    capturedLongitude: null,
  });
  assert.equal(itemFor(result, "gps").severity, "blocker");
}

function testNoLinkedPharmacyIsABlocker() {
  // Direct Orders validates a PHARMACY. A customer with none has nothing to send at all.
  const result = buildValidatedCustomerCompleteness({ ...completeInput(), linkedPharmacyCount: 0 });
  assert.equal(itemFor(result, "pharmacy").severity, "blocker");
}

function testUnresolvableAreaIsABlocker() {
  // A legacy slug that is NOT in LEGACY_MARKETING_AREA_ALIASES resolves to nothing, so a transfer
  // would land the shop in nobody's territory. `alex_delta` / "Alex-Delta" is a real such row.
  // Deliberately no longer "Delta (1)" — the owner ruled on that one, so it now resolves.
  const result = buildValidatedCustomerCompleteness({
    ...completeInput(),
    marketingAreaName: "Alex-Delta",
    resolvedAreaCode: null,
  });
  const item = itemFor(result, "area");
  assert.equal(item.severity, "blocker");
  assert.match(
    item.detail,
    /Alex-Delta/,
    "the admin must be told WHICH area failed to map, not just that one did",
  );
}

function testOwnerRuledDeltaOneIsMenoufiaOne() {
  // Owner, 2026-08-22, asked directly and answered in one line: "Delta (1) is Menoufia 1."
  // Menoufia 1 is area_code D12. Without this, four validated customers — including both copies of
  // حضانه النيل, his own example — resolve to no Direct Order area and cannot be transferred.
  assert.equal(applyLegacyMarketingAreaAlias("delta_1"), "D12");
  assert.equal(applyLegacyMarketingAreaAlias("  DELTA_1  "), "D12", "matching is case- and space-insensitive");

  // An area that is already current passes through untouched — this is a spelling fix, never a
  // reassignment. 35 of the 36 live areas take this path.
  assert.equal(applyLegacyMarketingAreaAlias("D12"), "D12");
  assert.equal(applyLegacyMarketingAreaAlias("UE9"), "UE9");

  // An unknown legacy slug is NOT guessed at. `delta_2` has no ruling, so it stays unresolved and
  // the completeness panel says so, rather than inventing a neighbouring territory.
  assert.equal(applyLegacyMarketingAreaAlias("delta_2"), "delta_2");
  assert.equal(applyLegacyMarketingAreaAlias(null), null);
  assert.equal(applyLegacyMarketingAreaAlias("   "), null);
}

function testMissingMobileIsOnlyAWarning() {
  // 9 of the 22 live validated customers have no mobile. Direct Orders does not require one, so
  // this must never harden into a blocker.
  const result = buildValidatedCustomerCompleteness({ ...completeInput(), contactMobile: null });
  assert.equal(itemFor(result, "mobile").severity, "warning");
  assert.equal(result.blockers, 0, "a missing mobile must not produce a blocker");
  assert.equal(result.isComplete, false, "but it must still stop the record reading as full");
}

function testUnmatchedDistributorCodeIsOnlyAWarning() {
  // Owner ruling, 2026-08-12: an unmatched code is released and FLAGGED, never blocked — a gap in
  // Phoenix's own reference table says nothing about whether the rep stood at the shop.
  const result = buildValidatedCustomerCompleteness({
    ...completeInput(),
    distributorCode: null,
    distributorCustomerCode: null,
  });
  assert.equal(itemFor(result, "distributor_code").severity, "warning");
  assert.equal(result.blockers, 0);
}

function testDuplicateNameIsSurfacedAsAWarning() {
  // The live case this exists for: حضانه النيل captured twice by the same rep eight minutes apart,
  // and محمد رويشة captured by two different reps. Neither is visible on a per-rep screen.
  const result = buildValidatedCustomerCompleteness({ ...completeInput(), duplicateCount: 1 });
  const item = itemFor(result, "duplicate");
  assert.equal(item.severity, "warning");
  assert.match(item.detail, /1 other active customer/, "the count must be named, not implied");
}

function testEvidencePendingIsAWarningNotABlocker() {
  // `sfe_validated` rows are cleared by a HUMAN and legitimately carry pending evidence. Treating
  // that as a blocker would flag six real records as broken.
  const result = buildValidatedCustomerCompleteness({
    ...completeInput(),
    evidenceStatus: "pending",
    hasEvidencePhoto: false,
  });
  assert.equal(itemFor(result, "evidence").severity, "warning");
  assert.equal(itemFor(result, "photo").severity, "warning");
  assert.equal(result.blockers, 0, "a human-validated record with no photo must not read as broken");
}

function testBlockerDoesNotImplyRefusal() {
  // Pins the owner's ruling: the completeness panel INFORMS, the confirmation dialog gates.
  // `buildValidatedCustomerCompleteness` is a pure verdict — it returns counts and nothing that
  // could be read as permission — so a caller cannot accidentally turn it into a hard gate.
  const result = buildValidatedCustomerCompleteness({
    ...completeInput(),
    capturedAddress: null,
    displayName: null,
  });
  assert.ok(result.blockers >= 2, "both missing fields must be reported");
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, "canTransfer"),
    false,
    "the completeness verdict must not carry a transfer permission — the admin decides, not this function",
  );
}

function testTransferredVenueBelongsToTheCapturingRep() {
  assert.equal(
    resolveTransferredVenueOwnerHrId({ created_by_hr_id: "B-154", owner_hr_id: "B-99" }, "B-10"),
    "B-154",
    "the rep who captured the customer owns the venue, not the admin who clicked Transfer",
  );
  assert.equal(
    resolveTransferredVenueOwnerHrId({ created_by_hr_id: null, owner_hr_id: "B-154" }, "B-10"),
    "B-154",
    "with no capturer on file the customer's owner is next",
  );
  assert.equal(
    resolveTransferredVenueOwnerHrId({ created_by_hr_id: "  ", owner_hr_id: "" }, "B-10"),
    "B-10",
    "the transferring admin owns it only when the capture record names nobody",
  );
  assert.equal(resolveTransferredVenueOwnerHrId(null, "B-10"), "B-10");
}

export async function runValidatedCustomerTransferTests() {
  // 🔴 A BRICK MAP THAT DID NOT LOAD REFUSES THE TRANSFER (code review, 19 Oct 2026). `loadBrickCentroids`
  // answers [] on a read failure; read as "no territory", the photo — the primary evidence — silently lost
  // to the master code or the inherited label, and the venue was filed where its photo says it is not.
  const transferSource = readFileSync(new URL("../src/lib/marketing-requests/validated-customer-transfer.ts", import.meta.url), "utf8");
  assert.match(
    transferSource,
    /const centroids = await loadBrickCentroids\(\);\s*if \(centroids\.length === 0\) throw new Error\(refusal\);/,
    "an empty brick map refuses rather than filing the venue without its photo's territory",
  );
  assert.match(transferSource, /could not be checked and nothing was transferred/, "the transfer says nothing was transferred");
  await testReadGateRefusesNonAdmins();
  await testDetailGateRefusesNonAdmins();
  await testTransferGateRefusesNonAdmins();
  await testRevertGateRefusesNonAdmins();
  await testTransferRefusesAnUnansweredVenueType();
  await testTransferRefusesANursery();
  testTransferFilesTheVenueWithTheAnsweredType();
  testAllowedRolesPassThePredicate();
  testCompleteRecordReportsNothingOutstanding();
  testMissingNameIsABlocker();
  testMissingAddressIsABlocker();
  testMissingGpsIsABlocker();
  testNoLinkedPharmacyIsABlocker();
  testUnresolvableAreaIsABlocker();
  testOwnerRuledDeltaOneIsMenoufiaOne();
  testMissingMobileIsOnlyAWarning();
  testUnmatchedDistributorCodeIsOnlyAWarning();
  testDuplicateNameIsSurfacedAsAWarning();
  testEvidencePendingIsAWarningNotABlocker();
  testBlockerDoesNotImplyRefusal();
  testTransferredVenueBelongsToTheCapturingRep();
}
