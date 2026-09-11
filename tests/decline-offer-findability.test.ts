import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The owner's requirement was explicit: a declined-offer exit must be a genuinely
 * distinct, findable-later record, never folded silently into an ordinary resignation.
 * This pins the three surfaces that requirement depends on.
 */
export function runDeclineOfferFindabilityTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");
  const viewModel = readFileSync("src/lib/resignations/view-model.ts", "utf8");
  const workspace = readFileSync("src/components/resignations/resignations-workspace.tsx", "utf8");
  const employeeDirectory = readFileSync("src/lib/employees/employee-directory.ts", "utf8");

  // (a) the no-pay branch (employment_status = "declined_offer") must still surface on the
  // Resignations/Exits page via the legacy/compatibility read path — it never gets an
  // employee_resignations row, so this IN-list is the only thing that finds it.
  assert.match(
    service,
    /"declined_offer",\s*\n\];/,
    "terminalEmployeeStatuses must include \"declined_offer\" so the no-pay branch surfaces on the Exits page",
  );

  // (b) the dashboard's historical-employee query selects exit_category, and the legacy
  // mapper threads it onto the record — otherwise isDeclinedOfferResignation always reads
  // null and the badge below can never render.
  assert.ok(
    service.includes(
      "hr_id,full_name,nickname,job_title,employment_status,resignation_date,last_working_date,exit_category,exit_reason,exit_status,created_at,updated_at,lines(name),positions(title)",
    ),
    "loadHistoricalResignedEmployees must select exit_category",
  );
  assert.match(
    service,
    /exitCategory:\s*row\.exit_category\s*\?\?\s*null/,
    "mapLegacyResignationEmployee must thread exit_category onto the ResignationRecord",
  );

  // (c) a dedicated, employment_status-independent helper exists (checking exitCategory
  // specifically, not employeeStatus) — required because the pay branch reuses
  // employeeStatus "terminated" and would otherwise be indistinguishable from an ordinary
  // termination.
  assert.match(
    viewModel,
    /export function isDeclinedOfferResignation\(record: Pick<ResignationRecord, "exitCategory">\)/,
    "view-model.ts must export isDeclinedOfferResignation, keyed on exitCategory",
  );

  // (d) the workspace actually renders a distinct badge from it, in both the card and
  // table views — not merely computed and left unread.
  assert.match(
    workspace,
    /const declinedOffer = isDeclinedOfferResignation\(record\);/,
    "the workspace must call isDeclinedOfferResignation for each rendered record",
  );
  const declinedOfferBadgeCount = (workspace.match(/"Declined Offer"/g) ?? []).length;
  assert.ok(
    declinedOfferBadgeCount >= 2,
    "the \"Declined Offer\" label must render in both the card view and the table view",
  );

  // (e) the new status is a legal value and is guarded the same way resigned/terminated
  // are, so a routine field edit through the general Employee form can never silently
  // resurrect or overwrite a declined-offer record.
  assert.match(
    employeeDirectory,
    /const statusOptions = \[.*"declined_offer".*\];/,
    "statusOptions must include \"declined_offer\"",
  );
  assert.match(
    employeeDirectory,
    /employmentStatus === "declined_offer"/,
    "employeePayload must guard against editing a declined_offer employee through the general form",
  );
}
