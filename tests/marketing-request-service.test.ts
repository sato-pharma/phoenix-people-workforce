import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  buildMarketingApprovedRequestRows,
  buildMarketingDraftProductScope,
  buildMarketingManagerChain,
  normalizeMarketingRequestDraftInput,
  prepareMarketingRequestDraft,
  resolveLineCcHrIds,
} from "@/lib/marketing-requests/service";
import type { MarketingRequest, MarketingRequestCreateDraft } from "@/lib/marketing-requests/types";

const baseInput: MarketingRequestCreateDraft = {
  customerId: "11111111-1111-1111-1111-111111111111",
  estimatedCost: 1000,
  payDate: "2026-06-01",
  pharmacies: [
    {
      distributorCodeId: "22222222-2222-2222-2222-222222222222",
      notes: "Main tracking pharmacy",
    },
  ],
  products: [
    {
      productId: 1,
      quantity: 500,
    },
    {
      productId: "2",
      quantity: 500,
    },
  ],
  requestDate: "2026-05-21",
  requestTypeId: 1,
  roiDurationMonths: 6,
};

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const requester = {
  areaId: 30,
  hrId: "MR001",
  lineId: 7,
  lineName: "Anti infective",
  managerHrId: "DM001",
};

const customer = {
  active: true,
  area_id: 40,
  id: baseInput.customerId,
  line_id: 8,
  manager_hr_id: "DM009",
  owner_hr_id: "MR001",
};

const requestType = {
  active: true,
  code: "special_request",
  description: null,
  id: 1,
  name: "Special request",
  requires_description: false,
  sort_order: 10,
};

const baseEmployee: EmployeeDirectoryRow = {
  areaId: 30,
  areaName: "Alex",
  birthDate: null,
  bankAccount: null,
  bankName: null,
  baseSalary: null,
  basicSalary: null,
  contractRenewalDate: null,
  contractType: null,
  createdAt: "2026-05-21T00:00:00.000Z",
  crmId: null,
  crmUsername: null,
  departmentId: null,
  departmentName: null,
  education: null,
  employmentStatus: "active",
  extraCostOfLiving: null,
  fullName: "Employee",
  displayName: "Employee",
  nickname: null,
  fuelAllowance: null,
  gender: null,
  grossSalary: null,
  hasBankAccount: null,
  hasPhoto: false,
  hireDate: null,
  hrId: "EMP000",
  jobTitle: "Medical Rep",
  lastWorkingDate: null,
  lineId: 7,
  lineName: "Anti infective",
  managerHrId: null,
  managerName: null,
  pendingManagerReplacementForHrId: null,
  medicalInsurance: null,
  medicalInsuranceNumber: null,
  medicalInsuranceStatus: null,
  mobileNumber: null,
  nameAr: null,
  nationalId: null,
  netSalary: null,
  organogramVisible: true,
  payrollEligible: true,
  positionId: null,
  positionTitle: null,
  regionName: "Alex",
  residenceAddress: null,
  residenceArea: null,
  residenceCity: null,
  residenceGeocodeStatus: null,
  residenceLatitude: null,
  residenceLongitude: null,
  resignationDate: null,
  salaryPaymentMode: "one_part",
  socialInsurance: null,
  socialInsuranceWage: null,
  socialInsuranceNumber: null,
  socialInsuranceStatus: null,
  taxes: null,
  teamId: null,
  teamName: null,
  updatedAt: "2026-05-21T00:00:00.000Z",
  workEmail: null,
};

function makeEmployee(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return { ...baseEmployee, ...overrides };
}

/** Minimal stub of the Supabase client surface resolveLineCcHrIds uses. */
function fakeCcSupabase(rows: Array<{ hr_id: string }>) {
  const builder = {
    eq() {
      return builder;
    },
    in() {
      return Promise.resolve({ data: rows, error: null });
    },
    select() {
      return builder;
    },
  };
  return { from: () => builder } as unknown as Parameters<typeof resolveLineCcHrIds>[0]["supabase"];
}

const ccRequest = { areaId: 30, id: "REQ-CC", lineId: 7 } as unknown as MarketingRequest;

export async function runMarketingRequestServiceTests() {
  const serviceSource = source("src/lib/marketing-requests/service.ts");
  const policySource = source("src/lib/notifications/policy.ts");
  const telegramTemplatesSource = source("src/lib/notifications/telegram-templates.ts");
  const telegramPlaceholderSource = source("src/lib/notifications/telegram-template-placeholders.ts");
  const decisionRouteSource = source("app/api/marketing-requests/[id]/decision/route.ts");
  const decisionPageSource = source("app/employee-portals/marketing-requests/decision/[requestId]/page.tsx");

  assert.match(serviceSource, /createMarketingApprovalSteps/, "marketing request submit must create approval steps");
  assert.match(serviceSource, /marketing_request_approval_steps/, "marketing workflow must use approval-step table");
  assert.match(serviceSource, /createSystemNotification/, "marketing workflow must use central notification engine");
  assert.match(serviceSource, /eventType:\s*"request_assigned"/, "marketing workflow must notify the assigned approver");
  assert.match(serviceSource, /assertMarketingStepAssignedToActor/, "marketing decisions must require the assigned approver");
  assert.match(serviceSource, /assignedHrId !== normalizeHrId\(actorHrId\)/, "wrong approver must be blocked");
  assert.match(serviceSource, /allow_return:\s*input\.step\.allowReturn/, "approval-step snapshots must preserve allow_return governance");
  assert.match(serviceSource, /marketingTelegramButtons/, "marketing Telegram buttons must be generated centrally");
  assert.doesNotMatch(serviceSource, /sendTelegramNotification|api\.telegram\.org/, "marketing module must never call Telegram directly");
  assert.match(policySource, /"marketing_requests\.request_assigned":[\s\S]*channels:\s*\["in_app",\s*"email",\s*"telegram"\]/, "request_assigned must use in-app, email, and Telegram");
  assert.match(policySource, /"marketing_requests\.request_submitted":[\s\S]*recipientStrategy:\s*\["workflow_step_approver"\]/, "request_submitted must stay scoped to workflow approver");
  assert.match(telegramTemplatesSource, /templateKey:\s*"marketing_requests"/, "Template Studio must expose marketing request Telegram template");
  assert.match(telegramPlaceholderSource, /\/employee-portals\/marketing-requests\/decision\//, "approve/reject labels must only be allowed for Phoenix marketing confirmation URLs");
  assert.match(decisionRouteSource, /assertSameOriginMutation/, "marketing decision API must remain CSRF guarded");
  assert.match(decisionRouteSource, /decideMarketingRequestWorkflow/, "marketing decision API must use governed workflow service");
  assert.match(decisionPageSource, /getMarketingRequestDecisionSummary/, "marketing decision page must re-check authorization before showing details");
  assert.match(decisionPageSource, /Login Required/, "marketing decision links must require a Phoenix session");

  // ── Notification wiring guard (verified end-to-end; lock against silent regression) ──
  // The workflow map once claimed this module had "no notification trigger code"; it is
  // fully wired. These assertions pin every transition + the daily SLA reminders so a
  // future refactor cannot quietly drop a notification.
  const dailyRouteSource = source("app/api/notifications/daily/route.ts");
  for (const eventType of ["request_submitted", "request_approved", "request_rejected", "request_returned"] as const) {
    assert.match(serviceSource, new RegExp(`"${eventType}"`), `marketing workflow must emit ${eventType}`);
  }
  // Reject/return branch to the right event; final approval notifies requester + participants.
  assert.match(serviceSource, /eventType:\s*decision === "reject" \? "request_rejected" : "request_returned"/, "decision must branch reject vs return");
  assert.match(serviceSource, /workflowParticipantHrIds:\s*steps\.map/, "final approval must notify all step participants");
  // SLA reminders exist and classify all three tiers (invocation from the daily cron is disabled).
  assert.match(serviceSource, /export async function runMarketingSlaDaily/, "marketing SLA daily job must exist");
  for (const slaEvent of ["due_date_reminder", "overdue_reminder", "escalation"] as const) {
    assert.match(serviceSource, new RegExp(slaEvent), `SLA classifier must cover ${slaEvent}`);
  }
  assert.doesNotMatch(dailyRouteSource, /runMarketingSlaDaily/, "marketing SLA reminders are intentionally disabled in the daily cron route");
  // Routing metadata keys the policy strategies depend on must be present.
  for (const key of ["requestOwnerHrId", "assignedApproverHrId", "workflowParticipantHrIds", "escalationOwnerHrId"] as const) {
    assert.match(serviceSource, new RegExp(key), `notification routing must set ${key}`);
  }
  // Idempotency keys (helper + explicit submit) prevent double-sends.
  assert.match(serviceSource, /marketing-request:\$\{params\.eventType\}:/, "workflow notifications must carry a per-event idempotency key");
  assert.match(serviceSource, /marketing-request-submitted:/, "submit notification must carry an idempotency key");
  // Notification failures surface (Sentry) but never throw into the workflow.
  assert.match(serviceSource, /console\.error/, "marketing notification failures must be surfaced, not silently swallowed");
  // Telegram delivery on the decision events too (not just request_assigned).
  for (const event of ["request_approved", "request_rejected", "request_returned"] as const) {
    assert.match(policySource, new RegExp(`"marketing_requests\\.${event}":[^\\n]*telegramAllowed:\\s*true`), `${event} must allow Telegram`);
  }

  const normalized = normalizeMarketingRequestDraftInput({
    ...baseInput,
    products: [
      { productId: 1, quantity: 200 },
      { productId: "1", quantity: 300 },
    ],
  });

  assert.equal(normalized.products.length, 1);
  assert.equal(normalized.products[0].productId, 1);
  assert.equal(normalized.products[0].quantity, 500);

  const prepared = prepareMarketingRequestDraft({
    customer,
    input: baseInput,
    pharmacyCodes: [
      {
        active: true,
        id: "22222222-2222-2222-2222-222222222222",
        pharmacy_id: "33333333-3333-3333-3333-333333333333",
      },
    ],
    products: [
      {
        active: true,
        factory_price: 6,
        id: 1,
        line: "Anti infective",
        product_name: "Saginko",
      },
      {
        active: true,
        factory_price: 14,
        id: 2,
        line: "Anti infective",
        product_name: "Royafloxacin",
      },
    ],
    requestCode: "MKT-REQ-TEST",
    requestType,
    requester,
  });

  assert.equal(prepared.requestRow.request_code, "MKT-REQ-TEST");
  assert.equal(prepared.requestRow.requester_hr_id, "MR001");
  assert.equal(prepared.requestRow.manager_hr_id, "DM009");
  assert.equal(prepared.requestRow.line_id, 7);
  assert.equal(prepared.requestRow.area_id, 40);
  assert.equal(prepared.requestRow.expected_roi_value, 10000);
  // Required ROI is flat: 1000 cost × 10 = 10,000; expected is 10,000 so it exactly covers.
  assert.equal(prepared.requestRow.roi_status, "covers_required");
  assert.equal(prepared.productRows[0].factory_price_snapshot, 6);
  assert.equal(prepared.productRows[0].forecast_quantity, 500);
  assert.equal(prepared.productRows[0].value_share, 0.3);
  assert.equal(prepared.productRows[1].value_share, 0.7);
  assert.equal(prepared.pharmacyRows[0].pharmacy_id, "33333333-3333-3333-3333-333333333333");

  assert.throws(
    () =>
      normalizeMarketingRequestDraftInput({
        ...baseInput,
        products: [],
      }),
    /at least one product/i,
  );

  assert.throws(
    () =>
      prepareMarketingRequestDraft({
        customer,
        input: {
          ...baseInput,
          otherRequestType: "",
        },
        products: [
          {
            active: true,
            factory_price: 6,
            id: 1,
            line: "Anti infective",
            product_name: "Saginko",
          },
          {
            active: true,
            factory_price: 14,
            id: 2,
            line: "Anti infective",
            product_name: "Royafloxacin",
          },
        ],
        requestType: {
          ...requestType,
          code: "other",
          requires_description: true,
        },
        requester,
      }),
    /other request type description/i,
  );

  assert.equal(createAccessContext({ hrId: "MR001", role: "Medical Rep" }).scope, "self");

  const approvedRows = buildMarketingApprovedRequestRows({
    customers: [{
      active: true,
      areaId: null,
      capturedAccuracyMeters: null,
      capturedAddress: null,
      capturedAt: null,
      capturedLatitude: null,
      capturedLongitude: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      createdByHrId: "MR001",
      customerCode: "CUST-1",
      customerType: "clinic",
      displayName: "El Safra Clinic",
      evidenceHasTimestamp: true,
      evidencePhotoCapturedAt: null,
      evidencePhotoName: null,
      evidenceStatus: "complete",
      extractedAreaName: "Asafra",
      extractedGovernorateName: "Alexandria",
      id: baseInput.customerId,
      lineId: 7,
      managerHrId: "DM001",
      normalizedName: "el safra clinic",
      otherTypeDescription: null,
      ownerHrId: "MR001",
      regionName: null,
      updatedAt: "2026-05-21T00:00:00.000Z",
      updatedByHrId: null,
      validatedAt: null,
      validatedByHrId: null,
      validationNotes: null,
      validationStatus: "sfe_validated",
    }],
    employeeRows: [{
      areaId: 30,
      areaName: "Alex",
      birthDate: null,
      bankAccount: null,
      bankName: null,
      baseSalary: null,
      basicSalary: null,
      contractRenewalDate: null,
      contractType: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      crmId: null,
      crmUsername: null,
      departmentId: null,
      departmentName: null,
      education: null,
      employmentStatus: "active",
      extraCostOfLiving: null,
      fullName: "Med Rep One",
      displayName: "Med Rep One",
      nickname: null,
      fuelAllowance: null,
      gender: null,
      grossSalary: null,
      hasBankAccount: null,
      hasPhoto: false,
      hireDate: null,
      hrId: "MR001",
      jobTitle: "Medical Rep",
      lastWorkingDate: null,
      lineId: 7,
      lineName: "Anti infective",
      managerHrId: "DM001",
      managerName: "District Manager",
      pendingManagerReplacementForHrId: null,
      medicalInsurance: null,
      medicalInsuranceNumber: null,
      medicalInsuranceStatus: null,
      mobileNumber: null,
      nameAr: null,
      nationalId: null,
      netSalary: null,
      organogramVisible: true,
      payrollEligible: true,
      positionId: null,
      positionTitle: null,
      regionName: "Alex",
      residenceAddress: null,
      residenceArea: null,
      residenceCity: null,
      residenceGeocodeStatus: null,
      residenceLatitude: null,
      residenceLongitude: null,
      resignationDate: null,
      salaryPaymentMode: "one_part",
      socialInsurance: null,
      socialInsuranceWage: null,
      socialInsuranceNumber: null,
      socialInsuranceStatus: null,
      taxes: null,
      teamId: null,
      teamName: null,
      updatedAt: "2026-05-21T00:00:00.000Z",
      workEmail: null,
    }],
    financeRequirements: [{
      createdAt: "2026-05-21T00:00:00.000Z",
      financeReviewerHrId: "FIN001",
      invoiceDeadlineDate: null,
      invoiceOriginalFileName: "invoice.pdf",
      invoiceRequired: true,
      invoiceStatus: "submitted",
      invoiceStoragePath: "request/invoice/invoice.pdf",
      invoiceUploadedAt: "2026-05-21T00:00:00.000Z",
      invoiceUploadedByHrId: "MR001",
      moneyTransferProofOriginalFileName: "proof.jpg",
      moneyTransferProofStoragePath: "request/proof/proof.jpg",
      moneyTransferProofUploadedAt: "2026-05-21T00:00:00.000Z",
      moneyTransferProofUploadedByHrId: "FIN001",
      notes: null,
      requestId: "REQ-1",
      reviewedAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    }],
    requests: [{
      approvedAt: "2026-05-21T00:00:00.000Z",
      areaId: 30,
      closedAt: null,
      createdAt: "2026-05-21T00:00:00.000Z",
      createdByHrId: "MR001",
      customerContactId: null,
      customerId: baseInput.customerId,
      estimatedCost: 1000,
      executedAt: null,
      expectedRoiValue: 10000,
      id: "REQ-1",
      lineId: 7,
      managerHrId: "DM001",
      notes: "RTD request",
      otherRequestType: null,
      payDate: "2026-06-01",
      rejectedAt: null,
      returnedAt: null,
      returnedStepSequence: null,
      requestCode: "MKT-REQ-1",
      requestDate: "2026-05-21",
      requesterHrId: "MR001",
      requestTypeId: 1,
      requiredRoiValue: 10000,
      roiCoverageRatio: 1,
      roiDurationMonths: 6,
      roiStatus: "covers_required",
      status: "approved",
      submittedAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
      updatedByHrId: "MR001",
    }],
  });

  assert.equal(approvedRows[0].moneyTransferDate, "2026-06-01");
  assert.equal(approvedRows[0].line, "Anti infective");
  assert.equal(approvedRows[0].contactForMoneyTransfer, "Med Rep One");
  assert.equal(approvedRows[0].customerName, "El Safra Clinic");
  assert.equal(approvedRows[0].sumOfAmount, 1000);
  assert.equal(approvedRows[0].financeProofFileName, "proof.jpg");
  assert.equal(approvedRows[0].invoiceFileName, "invoice.pdf");

  /* ---------------------------------------------------------------------- */
  /* Approval-chain reshape: managerial chain builder                        */
  /* ---------------------------------------------------------------------- */

  // Medical Rep submits -> Direct Manager -> National Sales Manager (stop).
  const repChainRows = [
    makeEmployee({ fullName: "Rep One", hrId: "MR001", jobTitle: "Medical Rep", managerHrId: "DM001" }),
    makeEmployee({ fullName: "District Mgr", hrId: "DM001", jobTitle: "District Manager", managerHrId: "NSM001" }),
    makeEmployee({ fullName: "National Mgr", hrId: "NSM001", jobTitle: "National Sales Manager", managerHrId: "CEO001" }),
    makeEmployee({ fullName: "Chief", hrId: "CEO001", jobTitle: "CEO", managerHrId: null }),
  ];
  const repChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: repChainRows,
    requester: repChainRows[0],
  });
  assert.deepEqual(
    repChain.map((step) => step.assignedHrId),
    ["dm001", "nsm001"],
    "Medical Rep chain must be Direct Manager then National Sales Manager",
  );
  assert.deepEqual(
    repChain.map((step) => step.assignedRole),
    ["District Manager", "National Sales Manager"],
    "Medical Rep chain roles must classify via job function",
  );

  // District Manager submits -> chain starts at National Sales Manager (self-skip).
  const dmChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: repChainRows,
    requester: repChainRows[1],
  });
  assert.deepEqual(
    dmChain.map((step) => step.assignedHrId),
    ["nsm001"],
    "District Manager chain must skip rep+DM and start at National Sales Manager",
  );

  // Cycle guard: A -> B -> A must terminate (no infinite loop) and not duplicate.
  const cycleRows = [
    makeEmployee({ hrId: "A001", jobTitle: "Medical Rep", managerHrId: "B001" }),
    makeEmployee({ hrId: "B001", jobTitle: "District Manager", managerHrId: "A001" }),
  ];
  const cycleChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: cycleRows,
    requester: cycleRows[0],
  });
  assert.ok(cycleChain.length <= 2, "cycle guard must stop the manager walk");
  assert.equal(new Set(cycleChain.map((step) => step.assignedHrId)).size, cycleChain.length, "cycle chain must not duplicate seats");

  // Missing NSM: rep -> DM only (DM has no resolvable manager) -> chain never reaches NSM.
  const noNsmRows = [
    makeEmployee({ hrId: "MR009", jobTitle: "Medical Rep", managerHrId: "DM009" }),
    makeEmployee({ hrId: "DM009", jobTitle: "District Manager", managerHrId: null }),
  ];
  const noNsmChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: noNsmRows,
    requester: noNsmRows[0],
  });
  assert.deepEqual(noNsmChain.map((step) => step.assignedHrId), ["dm009"], "chain stops when no NSM seat resolves");
  assert.ok(
    !noNsmChain.some((step) => step.assignedRole === "National Sales Manager"),
    "chain without an NSM seat must not contain a National Sales Manager step",
  );

  /* ---------------------------------------------------------------------- */
  /* Approval-chain reshape: line CC resolver (PM/GPM)                       */
  /* ---------------------------------------------------------------------- */

  const ccEmployees = [
    makeEmployee({ hrId: "PM001", jobTitle: "Product Manager", lineId: 7 }),
    makeEmployee({ hrId: "GPM001", jobTitle: "Group Product Manager", lineId: 8 }),
    makeEmployee({ hrId: "GPM002", jobTitle: "Group Product Manager", lineId: 7 }),
  ];

  // No CC roles configured -> no CC recipients (no DB call required).
  assert.deepEqual(
    await resolveLineCcHrIds({ ccRoles: [], employeeRows: ccEmployees, request: ccRequest, supabase: fakeCcSupabase([]) }),
    [],
    "empty cc roles must resolve to no recipients",
  );

  // Many candidates: only same-line PM/GPM are CC'd; other-line GPM excluded.
  const manyCc = await resolveLineCcHrIds({
    ccRoles: ["Product Manager", "Group Product Manager"],
    employeeRows: ccEmployees,
    request: ccRequest,
    supabase: fakeCcSupabase([{ hr_id: "PM001" }, { hr_id: "GPM001" }, { hr_id: "GPM002" }]),
  });
  assert.deepEqual(manyCc.sort(), ["gpm002", "pm001"], "only same-line PM/GPM are CC recipients");

  // Single candidate match.
  const oneCc = await resolveLineCcHrIds({
    ccRoles: ["Product Manager"],
    employeeRows: ccEmployees,
    request: ccRequest,
    supabase: fakeCcSupabase([{ hr_id: "PM001" }]),
  });
  assert.deepEqual(oneCc, ["pm001"], "single same-line PM resolves to one CC recipient");

  // Unknown CC role string is ignored (no throw).
  assert.deepEqual(
    await resolveLineCcHrIds({ ccRoles: ["Not A Role"], employeeRows: ccEmployees, request: ccRequest, supabase: fakeCcSupabase([]) }),
    [],
    "unknown cc role strings must be ignored",
  );

  /* ---------------------------------------------------------------------- */
  /* Approval-chain reshape: source + migration guards                      */
  /* ---------------------------------------------------------------------- */

  // Notification policy must expose the explicit "cc" recipient strategy and use it for assignment.
  assert.match(policySource, /"cc"/, "notification policy must define a cc recipient strategy");
  assert.match(
    policySource,
    /"marketing_requests\.request_assigned":[\s\S]*recipientStrategy:\s*\["assigned_approver",\s*"cc"\]/,
    "request_assigned must CC the line PM/GPM via the cc strategy",
  );
  assert.match(policySource, /strategy === "cc"/, "policy resolver must handle the cc strategy");

  // Service exposes resubmit, approver inbox, and request detail/tracking.
  assert.match(serviceSource, /resubmitReturnedMarketingRequest/, "service must support returned -> resubmit");
  assert.match(serviceSource, /getApproverPendingRequests/, "service must expose the approver inbox");
  assert.match(serviceSource, /getMarketingRequestDetail/, "service must expose request detail for tracking");
  assert.match(serviceSource, /stepProgressByRequestId/, "workspace must expose step progress for tracking");
  assert.match(serviceSource, /buildMarketingStepProgress/, "service must compute compact step progress");

  // ROI actuals must match by exact CUSTOMER CODE ONLY — the brick/geography fallback was removed
  // (owner directive). This guards the live behaviour, so it reads the latest migration that defines it.
  const roiMigration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260620140000_marketing_roi_customer_code_only.sql");
  const marketingTypesSource = source("src/lib/marketing-requests/types.ts");
  // The ROI workspace was rebuilt as the filter-engine; attribution is now surfaced via the
  // per-row result status + attribution-gap reason rather than a standalone badge.
  const roiWorkspaceSource = source("src/components/marketing-requests/roi-filter-engine.tsx");
  assert.match(roiMigration, /r\.client_code/, "ROI actuals must match Source-of-Sales rows by exact client_code");
  assert.match(roiMigration, /mpdc\.normalized_pharmacy_code/, "ROI actuals must use the request pharmacy distributor code as the customer key");
  assert.doesNotMatch(roiMigration, /fallback_hits/, "ROI actuals must NOT match sales by brick fallback (customer-code-only)");
  assert.doesNotMatch(roiMigration, /fallback_bricks/, "ROI actuals must NOT build brick fallback candidates");
  assert.doesNotMatch(roiMigration, /exact_covered_keys/, "no brick fallback means no exact-covered-keys suppression CTE");
  assert.match(roiMigration, /attribution_quality/, "ROI actuals must expose attribution quality");
  assert.match(roiMigration, /'exact_customer'/, "attribution quality must still surface exact_customer");
  assert.match(marketingTypesSource, /MarketingRoiAttributionQuality/, "ROI tracking type must model attribution quality");
  // The legacy ROI workspace service was retired; the filter-engine report service now carries
  // attribution quality per row, so the "service surfaces attribution quality" guard points there.
  const roiReportServiceSource = source("src/lib/marketing-requests/roi-report-service.ts");
  assert.match(roiReportServiceSource, /attributionQuality/, "ROI report service must return attribution quality");
  assert.match(roiReportServiceSource, /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/, "ROI report must resolve historical (terminated) requesters so region/name/line never go unassigned");
  assert.match(roiWorkspaceSource, /attributionGapReason|resultStatus/, "ROI tracking UI must surface attribution status");
  assert.match(roiReportServiceSource, /ROI_INDEX_CACHE_TTL_MS/, "ROI tracking must cache the scoped index briefly to avoid duplicate rebuilds");
  assert.match(roiReportServiceSource, /function getCachedRoiIndex/, "ROI tracking must centralize scoped index cache access");
  assert.match(
    roiReportServiceSource,
    /getMarketingRoiFilterOptions[\s\S]*getCachedRoiIndex\(access/,
    "ROI filter options must use the cached scoped index",
  );
  assert.match(
    roiReportServiceSource,
    /getMarketingRoiReport[\s\S]*getCachedRoiIndex\(access/,
    "ROI reports must reuse the cached scoped index when visibility allows it",
  );
  assert.match(roiWorkspaceSource, /Promise\.all\(\[filterOptionsPromise, presetsPromise\]\)/, "ROI tracking must fetch filter options and presets in parallel");
  assert.match(roiWorkspaceSource, /ROI_ROWS_PER_PAGE/, "ROI tracking must paginate the browser row render");
  assert.match(roiWorkspaceSource, /visibleRows\.map/, "ROI tracking must render visible rows instead of every report row at once");
  assert.match(roiWorkspaceSource, /React\.memo\(function ReportRow/, "ROI desktop report rows must be memoized");
  assert.match(roiWorkspaceSource, /React\.memo\(function ReportCard/, "ROI mobile report cards must be memoized");

  // New API routes exist.
  assert.match(source("app/api/marketing-requests/[id]/resubmit/route.ts"), /resubmitReturnedMarketingRequest/, "resubmit route must call the service");
  assert.match(source("app/api/marketing-requests/inbox/route.ts"), /getApproverPendingRequests/, "inbox route must call the service");
  assert.match(source("app/api/marketing-requests/[id]/route.ts"), /getMarketingRequestDetail/, "request detail route must call the service");

  // Migration reshape tokens.
  const chainMigration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260606180000_marketing_workflow_chain_reshape.sql");
  for (const token of ["step_kind", "chain_target_role", "cc_roles", "terminal_status", "allow_reject", "manager_chain", "sfe_validation", "marketing_review", "ceo_approval", "finance_execution"]) {
    assert.match(chainMigration, new RegExp(token), `chain reshape migration must define ${token}`);
  }
  const sfeValidateMigration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260621130000_marketing_chain_sfe_validate_no_finance.sql");
  assert.match(
    sfeValidateMigration,
    /UPDATE marketing_request_approval_steps[\s\S]*allow_return = false[\s\S]*assigned_role = 'SFE Manager'[\s\S]*step_code = 'sfe_validation'/,
    "SFE validate-only migration must repair existing approval-step allow_return snapshots",
  );

  /* ---------------------------------------------------------------------- */
  /* Drafts workspace resilience: requester-not-found must not 400 the page  */
  /* ---------------------------------------------------------------------- */

  // The drafts workspace must degrade gracefully (non-throwing requester lookup +
  // scoped creation affordance) instead of hard-failing for legitimate reviewers.
  assert.match(serviceSource, /function tryFindRequester/, "workspace must use a non-throwing requester lookup");
  assert.match(serviceSource, /buildMarketingDraftProductScope/, "workspace must compute draft scope without hard-failing");

  const draftScopeProducts = [
    { active: true, factory_price: 6, id: 1, line: "Anti infective", line_id: 7, product_name: "Saginko" },
    { active: true, factory_price: 14, id: 2, line: "Anti infective", line_id: 7, product_name: "Royafloxacin" },
    { active: true, factory_price: 9, id: 3, line: "Cardio", line_id: 8, product_name: "Cardiox" },
  ];

  // 1) Resolved requester (restricted role) -> line-scoped products + creation scope.
  const repScope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "MR001", role: "Medical Rep" }),
    productRows: draftScopeProducts,
    requester,
  });
  assert.equal(repScope.canCreateDraft, true, "a resolved requester can create drafts");
  assert.deepEqual(repScope.products.map((product) => product.id), [1, 2], "products must be scoped to the requester line");
  assert.equal(repScope.requesterLineId, 7, "resolved requester keeps its line id");
  assert.equal(repScope.requesterLineName, "Anti infective", "resolved requester keeps its line name");

  // 2) Company-wide reviewer who is NOT a directory requester -> read-only, no throw.
  //    This is the bug fix: previously this path raised `requester_not_found` (HTTP 400)
  //    and blocked the entire workspace for valid Marketing Manager reviewers.
  const reviewerScope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "A-9", role: "Marketing Manager" }),
    productRows: draftScopeProducts,
    requester: null,
  });
  assert.equal(reviewerScope.canCreateDraft, false, "a non-requester reviewer cannot create drafts");
  assert.equal(reviewerScope.products.length, 0, "a non-requester reviewer has no creation product scope");
  assert.equal(reviewerScope.requesterLineId, null, "a non-requester reviewer has no requester line id");
  assert.equal(reviewerScope.requesterLineName, null, "a non-requester reviewer has no requester line name");

  // 3) Unrestricted oversight role (SFE Manager) -> every product line, creation allowed
  //    even without a directory requester row.
  const sfeScope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "SFE001", role: "SFE Manager" }),
    productRows: draftScopeProducts,
    requester: null,
  });
  assert.equal(sfeScope.canCreateDraft, true, "an unrestricted oversight role can create drafts");
  assert.equal(sfeScope.products.length, 3, "an unrestricted oversight role sees every product line");
  assert.equal(sfeScope.requesterLineName, "All product lines", "unrestricted scope labels all product lines");
  assert.equal(sfeScope.requesterLineId, null, "unrestricted scope without a requester has no line id");

  /* ---------------------------------------------------------------------- */
  /* Additive product_scope_override: a PM (e.g. B-155) covering one product  */
  /* per line may see + create for a product outside their own line, without  */
  /* narrowing their line default or affecting anyone with no override.       */
  /* ---------------------------------------------------------------------- */

  const codedProducts = [
    { active: true, factory_price: 6, id: 1, line: "Anti infective", line_id: 7, product_code: "SA001", product_name: "Saginko" },
    { active: true, factory_price: 9, id: 3, line: "Neuro", line_id: 9, product_code: "NX001", product_name: "Neurox" },
  ];

  // Picker: requester is on line 7; the override grants a line-9 product code. The result is a
  // UNION — the requester's own line (id 1) plus the granted cross-line product (id 3).
  const overridePickerScope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "MR001", role: "Product Manager" }),
    productRows: codedProducts,
    requester,
    allowedProductCodes: new Set(["NX001"]),
  });
  assert.deepEqual(
    overridePickerScope.products.map((product) => product.id).sort((a, b) => a - b),
    [1, 3],
    "product override adds the cross-line product (union) without dropping the requester-line default",
  );

  // Submit: the same requester may submit the granted cross-line product, and the request is
  // tagged with the PRODUCT's line (9) — not the requester line (7) or the customer line (8).
  const overrideSubmit = prepareMarketingRequestDraft({
    customer,
    input: { ...baseInput, products: [{ productId: 3, quantity: 500 }] },
    pharmacyCodes: [
      { active: true, id: "22222222-2222-2222-2222-222222222222", pharmacy_id: "33333333-3333-3333-3333-333333333333" },
    ],
    products: [
      { active: true, factory_price: 9, id: 3, line: "Neuro", line_id: 9, product_code: "NX001", product_name: "Neurox" },
    ],
    requestType,
    requester,
    allowedProductCodes: new Set(["NX001"]),
  });
  assert.equal(overrideSubmit.requestRow.line_id, 9, "override request is tagged with the product's line, not the requester/customer line");

  // No-override regression guard: the SAME cross-line product is rejected without the override,
  // so the additive grant is strictly override-gated (A-8/A-10 and normal PMs are unaffected).
  assert.throws(
    () =>
      prepareMarketingRequestDraft({
        customer,
        input: { ...baseInput, products: [{ productId: 3, quantity: 500 }] },
        pharmacyCodes: [
          { active: true, id: "22222222-2222-2222-2222-222222222222", pharmacy_id: "33333333-3333-3333-3333-333333333333" },
        ],
        products: [
          { active: true, factory_price: 9, id: 3, line: "Neuro", line_id: 9, product_code: "NX001", product_name: "Neurox" },
        ],
        requestType,
        requester,
      }),
    /assigned line/i,
    "without a product override a cross-line product stays rejected",
  );

  /* ---------------------------------------------------------------------- */
  /* B-155 named exception: marketing is hard-clamped to EXACTLY the override */
  /* codes (matching sales), not the usual native-line + override union.     */
  /* ---------------------------------------------------------------------- */

  const b155Requester = { areaId: 30, hrId: "B-155", lineId: 7, lineName: "Pedia", managerHrId: "A-8" };
  const b155Products = [
    { active: true, factory_price: 6, id: 10, line: "Pedia", line_id: 7, product_code: "GU001", product_name: "Guamusin" },
    { active: true, factory_price: 0, id: 11, line: "Pedia", line_id: 7, product_code: "TG001", product_name: "Tigogrow" },
    { active: true, factory_price: 0, id: 12, line: "Anti infective", line_id: 1, product_code: "OS001", product_name: "Osteosat" },
  ];
  const b155AllowedCodes = new Set(["TG001", "OS001"]);

  const b155Scope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "B-155", role: "Product Manager" }),
    productRows: b155Products,
    requester: b155Requester,
    allowedProductCodes: b155AllowedCodes,
  });
  assert.deepEqual(
    b155Scope.products.map((product) => product.id).sort((a, b) => a - b),
    [11, 12],
    "B-155 exception: product picker is EXACTLY his override codes, excluding his own native-line product (Guamusin) which isn't one of them",
  );

  assert.throws(
    () =>
      prepareMarketingRequestDraft({
        customer,
        input: { ...baseInput, products: [{ productId: 10, quantity: 500 }] },
        pharmacyCodes: [
          { active: true, id: "22222222-2222-2222-2222-222222222222", pharmacy_id: "33333333-3333-3333-3333-333333333333" },
        ],
        products: b155Products,
        requestType,
        requester: b155Requester,
        allowedProductCodes: b155AllowedCodes,
      }),
    /assigned line/i,
    "B-155 exception: his own native-line product (Guamusin) is rejected on submit because it's not in his override",
  );

  const b155Submit = prepareMarketingRequestDraft({
    customer,
    input: { ...baseInput, products: [{ productId: 12, quantity: 500 }] },
    pharmacyCodes: [
      { active: true, id: "22222222-2222-2222-2222-222222222222", pharmacy_id: "33333333-3333-3333-3333-333333333333" },
    ],
    products: b155Products,
    requestType,
    requester: b155Requester,
    allowedProductCodes: b155AllowedCodes,
  });
  assert.equal(b155Submit.requestRow.line_id, 1, "B-155's Osteosat request is tagged with the product's line (Anti infective), not his own Pedia line");

  // Deeper audit finding E: the "marketing request submitted" approver notification failure
  // was swallowed with no logging — the approver could silently never learn a request needs
  // their action. Now uses the shared logNotificationSendFailure helper (the same one PR #684
  // used to fix 6 sibling instances of this exact defect class elsewhere in the codebase).
  assert.match(
    serviceSource,
    /import \{ createSystemNotification, logNotificationSendFailure \} from "@\/lib\/notifications\/system";/,
    "marketing-requests service must import the shared notification-failure logger",
  );
  assert.doesNotMatch(
    serviceSource,
    /title:\s*"Marketing request submitted",\s*\}\)\.catch\(\(\) => undefined\);/,
    "the request-submitted notification failure must not be swallowed without logging",
  );
  assert.match(
    serviceSource,
    /title:\s*"Marketing request submitted",\s*\}\)\.catch\(\(error: unknown\) => logNotificationSendFailure\("marketingRequests\.createMarketingRequestDraft\.submitted", error\)\);/,
    "the request-submitted notification failure must be logged via the shared helper",
  );
}
