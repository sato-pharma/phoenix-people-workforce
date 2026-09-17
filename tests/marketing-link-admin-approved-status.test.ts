import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCustomerPharmacyApprovalPatch,
  CUSTOMER_PHARMACY_APPROVED_STATUS,
} from "@/lib/customer-pharmacy-mapping/actions.ts";
import {
  buildCustomerPharmacyReadiness,
  CUSTOMER_PHARMACY_VALIDATED_STATUSES,
  INFERRED_HISTORY_MARKER,
} from "@/lib/customer-pharmacy-mapping/readiness.ts";
import {
  inheritedLinkStatus,
  LINK_STATUS_PRECEDENCE,
  linkStatusIsSelectable,
  selectableLinkStatusSqlList,
} from "@/lib/marketing-requests/code-link-reach.ts";

/**
 * A person's Approve on Customer Pharmacy Mapping writes `admin_approved` (owner decision
 * 2026-09-17), never `system_validated`, which means NO HUMAN LOOKED (AGENTS.md 4.1), and never
 * the desk's `sfe_validated`. And the new status has to count as validated everywhere a link is
 * judged — a status the picker does not list would make every approval hide the customer instead.
 */

function testApproveWritesAdminApproved() {
  assert.equal(CUSTOMER_PHARMACY_APPROVED_STATUS, "admin_approved");

  const now = new Date("2026-09-17T16:00:00.000Z");
  const withNote = buildCustomerPharmacyApprovalPatch({
    accessHrId: "B-10",
    actorHrId: "B-10",
    existingNotes: null,
    notes: "  same shop, confirmed on the ruling sheet ",
    now,
  });
  assert.equal(
    withNote.validation_status,
    "admin_approved",
    "Approve must write admin_approved — system_validated would file a human ruling under the machine's label",
  );
  assert.notEqual(withNote.validation_status, "system_validated");
  assert.notEqual(withNote.validation_status, "sfe_validated", "sfe_validated is the desk status");
  assert.equal(withNote.validation_notes, "Approved: same shop, confirmed on the ruling sheet");
  assert.equal(withNote.updated_by_hr_id, "B-10");
  assert.equal(withNote.updated_at, "2026-09-17T16:00:00.000Z");

  const noNote = buildCustomerPharmacyApprovalPatch({
    accessHrId: "c-o1",
    actorHrId: "C-O1",
    existingNotes: `Inferred from historical marketing requests (${INFERRED_HISTORY_MARKER}).`,
    notes: "   ",
    now,
  });
  assert.equal(noNote.validation_status, "admin_approved");
  assert.equal(
    noNote.validation_notes,
    `Inferred from historical marketing requests (${INFERRED_HISTORY_MARKER}).\nApproved by C-O1.`,
    "the stamp still records who approved, and an inferred link keeps its marker",
  );

  const source = readFileSync("src/lib/customer-pharmacy-mapping/actions.ts", "utf8");
  assert.doesNotMatch(
    source,
    /validation_status:\s*"(system_validated|sfe_validated)"/,
    "no decision in actions.ts may write the machine's or the desk's status",
  );
  assert.match(
    source,
    /\.update\(\s*\n\s*buildCustomerPharmacyApprovalPatch\(/,
    "approveCustomerPharmacyLink must write the tested patch, not a hand-built copy of it",
  );
}

function testAdminApprovedCountsAsValidatedEverywhere() {
  assert.ok(
    (LINK_STATUS_PRECEDENCE as readonly string[]).includes("admin_approved"),
    "the request picker and the draft guard read LINK_STATUS_PRECEDENCE — without admin_approved an approval would HIDE the customer",
  );
  assert.equal(linkStatusIsSelectable("admin_approved"), true);
  assert.equal(linkStatusIsSelectable("pending"), false);
  assert.equal(linkStatusIsSelectable("rejected"), false);

  assert.equal(
    inheritedLinkStatus(["system_validated", "admin_approved", "sfe_validated"]),
    "admin_approved",
    "a person's ruling on this very pairing is the strongest status a sibling can inherit",
  );

  assert.deepEqual(
    [...CUSTOMER_PHARMACY_VALIDATED_STATUSES].sort(),
    [...LINK_STATUS_PRECEDENCE].sort(),
    "the mapping page's 'ready' set and the picker's set must be the same statuses, or the page calls a customer ready that no request can use",
  );

  const readiness = buildCustomerPharmacyReadiness({
    customers: [{ areaName: null, customerCode: null, customerName: "Approved only", customerType: null, governorateName: null, id: "c1" }],
    distributorCodes: [],
    distributors: [],
    links: [{ customerId: "c1", distributorCodeId: null, linkId: "l1", pharmacyId: "p1", validationNotes: "Approved by B-10.", validationStatus: "admin_approved" }],
    pharmacies: [{ id: "p1", pharmacyCode: null, pharmacyName: "Shop" }],
  });
  assert.equal(readiness.rows[0]?.bucket, "ready", "a customer whose only link was approved by a person is ready");
  assert.equal(readiness.rows[0]?.validatedLinkCount, 1);
  assert.equal(readiness.rows[0]?.pendingLinkCount, 0, "an approved link must not fall through to the pending count");

  assert.equal(
    selectableLinkStatusSqlList(),
    "('admin_approved', 'sfe_validated', 'system_validated')",
    "the SQL in-list is emitted from the same constant, so a script query matches the picker",
  );

  // Every link query that decides "validated" must take the list from the one constant — a
  // hand-typed ["system_validated", "sfe_validated"] is exactly how a new status goes missing.
  const service = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  assert.doesNotMatch(
    service,
    /\.in\("validation_status",\s*\[\s*"system_validated"/,
    "service.ts must not hand-type the validated link statuses",
  );
  const constantFilters = service.match(/\.in\("validation_status", \[\.\.\.LINK_STATUS_PRECEDENCE\]\)/g) ?? [];
  assert.equal(
    constantFilters.length,
    2,
    "both the draft guard (assertMarketingCustomerHasValidatedVenue) and the request picker must filter on LINK_STATUS_PRECEDENCE",
  );

  const script = readFileSync("scripts/marketing-pharmacy-code-questions.ts", "utf8");
  assert.doesNotMatch(
    script,
    /validation_status in \('system_validated'/,
    "the code-questions script's unlink fallout must match the picker, not a hand-typed pair",
  );

  for (const file of [
    "src/components/customer-pharmacy-mapping/customer-pharmacy-mapping-workspace.tsx",
    "src/components/employee-portal/marketing-validation-workspace.tsx",
    "src/components/employee-portal/marketing-customer-database.tsx",
  ]) {
    assert.match(
      readFileSync(file, "utf8"),
      /admin_approved|linkStatusIsSelectable/,
      `${file} must show an approved link as validated, not as an unknown grey status`,
    );
  }
  assert.match(
    readFileSync("src/components/customer-pharmacy-mapping/customer-pharmacy-mapping-workspace.tsx", "utf8"),
    /admin_approved: "Admin approved"/,
    "the page that writes the status must name it in words, never the raw code",
  );
}

function testDatabaseAllowsTheStatusOnLinksOnly() {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse()
    .find((name) => readFileSync(join(dir, name), "utf8").includes("add constraint marketing_customer_pharmacies_status_check"));
  assert.ok(file, "a migration must re-create marketing_customer_pharmacies_status_check");
  const sql = readFileSync(join(dir, file), "utf8");
  const checkBody = sql.slice(sql.indexOf("add constraint marketing_customer_pharmacies_status_check"));
  for (const status of ["pending", "rejected", ...LINK_STATUS_PRECEDENCE]) {
    assert.ok(
      checkBody.includes(`'${status}'`),
      `the link table's check must allow '${status}', or every write of it fails in the database`,
    );
  }
  assert.doesNotMatch(
    sql,
    /marketing_customers_validation_status_check|marketing_pharmacies_validation_status_check/,
    "admin_approved is a LINK decision — the customer and venue checks stay as they are",
  );
  assert.doesNotMatch(
    sql,
    /update\s+public\.marketing_customer_pharmacies/i,
    "the migration changes the rule only; relabelling any link is the owner's decision, never a migration's",
  );
}

export async function runMarketingLinkAdminApprovedStatusTests() {
  testApproveWritesAdminApproved();
  testAdminApprovedCountsAsValidatedEverywhere();
  testDatabaseAllowsTheStatusOnLinksOnly();
}
