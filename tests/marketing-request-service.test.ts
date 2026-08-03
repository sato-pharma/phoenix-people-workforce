import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  canUseEmployeePortalMarketingAllRequests,
  canUseEmployeePortalMarketingCustomerDatabase,
} from "@/lib/employee-portal/navigation";
import {
  marketingRequestNotificationUrl,
  resolveMarketingRequestDestination,
} from "@/lib/marketing-requests/notification-link";
import {
  buildMarketingApprovedRequestRows,
  buildMarketingDraftProductScope,
  buildMarketingManagerChain,
  isPhoenixOriginatedRequest,
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
  assert.match(policySource, /"marketing_requests\.request_assigned":[\s\S]*channels:\s*\["in_app",\s*"email",\s*"telegram",\s*"push"\]/, "request_assigned must use in-app, email, Telegram, and push");
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
  // SLA reminders exist and classify all three tiers (invocation from the daily cron is restored
  // behind a real admin toggle — see marketing_sla_reminder in role-recipients.ts).
  assert.match(serviceSource, /export async function runMarketingSlaDaily/, "marketing SLA daily job must exist");
  for (const slaEvent of ["due_date_reminder", "overdue_reminder", "escalation"] as const) {
    assert.match(serviceSource, new RegExp(slaEvent), `SLA classifier must cover ${slaEvent}`);
  }
  assert.match(dailyRouteSource, /runMarketingSlaDaily\(\)/, "marketing SLA reminders are restored in the daily cron route, gated by the marketing_sla_reminder enabled toggle");
  assert.match(serviceSource, /resolveNotificationRoleEnabled\("marketing_sla_reminder"\)/, "marketing SLA daily job must check its own enabled toggle before scanning any data");
  // Data-integrity guard: a pending_approval row with no `current` approval step is
  // undecidable by anyone — log it for engineering, don't fire a misleading business
  // notification. Scoped to pending_approval only (pending_validation / returned
  // legitimately have no current step by design).
  assert.match(serviceSource, /dataIntegrityIssues/, "SLA daily job must track pending_approval rows with no current step");
  assert.match(serviceSource, /request\.status === "pending_approval" && !hasCurrentStep/, "the missing-current-step guard must be scoped to pending_approval only");
  assert.match(serviceSource, /marketing_pending_approval_missing_current_step/, "missing-current-step rows must emit a distinct, greppable structured log event");
  // Routing metadata keys the policy strategies depend on must be present.
  for (const key of ["requestOwnerHrId", "assignedApproverHrId", "workflowParticipantHrIds", "escalationOwnerHrId"] as const) {
    assert.match(serviceSource, new RegExp(key), `notification routing must set ${key}`);
  }
  // Idempotency keys (helper + explicit submit) prevent double-sends.
  assert.match(serviceSource, /marketing-request:\$\{params\.eventType\}:/, "workflow notifications must carry a per-event idempotency key");
  assert.match(serviceSource, /marketing-request-submitted:/, "submit notification must carry an idempotency key");
  // Notification failures surface (Sentry) but never throw into the workflow.
  assert.match(serviceSource, /logError/, "marketing notification failures must be surfaced, not silently swallowed");
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

  // 4) Resolved requester whose employee record has NO line assigned. Creation stays allowed,
  //    so the create form renders, but the product list is EMPTY — the requester cannot pick
  //    anything and the draft can never be saved. requesterLineName MUST stay null here: it is
  //    the only field separating this state from case 3 (unrestricted, "All product lines"),
  //    and the portal's Products label branches on it. Branching on requesterLineId instead
  //    labelled this state "All available products" over an empty picker.
  const lineLessScope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "B-184", role: "District Manager" }),
    productRows: draftScopeProducts,
    requester: { ...requester, hrId: "B-184", lineId: null, lineName: null },
  });
  assert.equal(lineLessScope.canCreateDraft, true, "a directory requester without a line still reaches the create form");
  assert.equal(lineLessScope.products.length, 0, "a requester without a line has no products to choose from");
  assert.equal(lineLessScope.requesterLineId, null, "a requester without a line has no line id");
  assert.equal(
    lineLessScope.requesterLineName,
    null,
    "an unassigned line must stay null so the portal can tell it apart from unrestricted scope",
  );

  // ...and the portal must actually branch on that field. Guarding on requesterLineId instead
  // is the bug: a null id is ALSO produced by an unrestricted oversight role, so the label read
  // "All available products" while the picker underneath was empty and disabled.
  // Every failure on the drafts route must leave a row in app_error_events. The route used to
  // catch everything and return JSON only, so a requester blocked by a real gate was invisible
  // from the admin side — "she failed" could not be told apart from "she never finished the
  // form" without diffing tables by hand. All THREE exit paths must log: load, csrf reject,
  // create. A csrf reject returns early and never reaches the catch, so it needs its own call.
  const draftsRouteSource = source("app/api/marketing-requests/drafts/route.ts");
  assert.match(
    draftsRouteSource,
    /logAppError/,
    "the marketing drafts route must record failures in app_error_events",
  );
  assert.equal(
    (draftsRouteSource.match(/logMarketingDraftFailure\(\{/g) ?? []).length,
    3,
    "every drafts-route failure path (load, csrf reject, create) must be logged",
  );

  /* ---------------------------------------------------------------------- */
  /* Company-wide marketing oversight (owner instruction, 2026-08-03).        */
  /* ---------------------------------------------------------------------- */

  // The customer database carries raw submitted field evidence for the whole company — addresses,
  // phone numbers, live photos. SFE Manager joined Super Admin because it owns validation and must
  // see every customer employees submitted, validated or not. Nobody else is admitted.
  assert.equal(canUseEmployeePortalMarketingCustomerDatabase("SFE Manager"), true, "SFE Manager sees the customer database");
  assert.equal(canUseEmployeePortalMarketingCustomerDatabase("Super Admin"), true, "Super Admin sees the customer database");
  assert.equal(canUseEmployeePortalMarketingCustomerDatabase("Marketing Manager"), false, "Marketing Manager is not admitted to the customer database");
  assert.equal(canUseEmployeePortalMarketingCustomerDatabase("District Manager"), false, "a District Manager never sees company-wide customer evidence");
  assert.equal(canUseEmployeePortalMarketingCustomerDatabase("Medical Rep"), false, "a Medical Rep never sees company-wide customer evidence");

  // The request register is the oversight trio. A line/team role keeps its own bounded subtree
  // through the normal workspace and must NOT gain company-wide sight of every request.
  assert.equal(canUseEmployeePortalMarketingAllRequests("Marketing Manager"), true, "Marketing Manager sees every request");
  assert.equal(canUseEmployeePortalMarketingAllRequests("SFE Manager"), true, "SFE Manager sees every request");
  assert.equal(canUseEmployeePortalMarketingAllRequests("Super Admin"), true, "Super Admin sees every request");
  assert.equal(canUseEmployeePortalMarketingAllRequests("National Sales Manager"), false, "an NSM stays scoped to its own subtree");
  assert.equal(canUseEmployeePortalMarketingAllRequests("District Manager"), false, "a District Manager stays scoped to its own subtree");
  assert.equal(canUseEmployeePortalMarketingAllRequests("Medical Rep"), false, "a Medical Rep stays scoped to its own subtree");

  // The register must stay a SEPARATE surface. Folding it into the personal draft workspace would
  // undo scopeTrackingToOwnRequests, which exists so an oversight role's own Drafts / In-approval
  // lists are not flooded with every request in the company.
  assert.match(
    serviceSource,
    /export async function getMarketingAllRequestsWorkspace/,
    "the company-wide request register must exist as its own service entry point",
  );
  assert.match(
    serviceSource,
    /scopeTrackingToOwnRequests/,
    "the personal workspace must keep narrowing company-wide roles to their own requests",
  );

  // Tracking is the whole point of the register: a row must carry the step AND the person.
  const allRequestsSource = source("src/components/employee-portal/marketing-all-requests.tsx");
  assert.match(
    allRequestsSource,
    /currentApproverName[\s\S]{0,120}currentStepName/,
    "each register row must show who a request is pending with and which step it is stopped at",
  );
  assert.match(
    allRequestsSource,
    /Not submitted yet/,
    "a request with no approval chain must say so rather than render an empty tracking cell",
  );

  /* ---------------------------------------------------------------------- */
  /* Archived / imported must stay OFF the live register (owner, 2026-08-03). */
  /* ---------------------------------------------------------------------- */

  // The split axis is `origin`, NOT `status`. In production 217 of 218 rows are xlsx_import and
  // only 106 of those are `archived` — the other 111 are approved/rejected imports. Splitting on
  // status alone would leave those 111 legacy rows padding the live view, which is the exact
  // problem this separation exists to remove.
  assert.equal(isPhoenixOriginatedRequest("phoenix"), true, "a Phoenix-raised request is live work");
  assert.equal(isPhoenixOriginatedRequest("  Phoenix  "), true, "origin matching tolerates casing and padding");
  assert.equal(isPhoenixOriginatedRequest("xlsx_import"), false, "the legacy spreadsheet import is not Phoenix work");

  // Fail-safe direction: anything that is not explicitly Phoenix lands in the archive. A future
  // import that forgets to set `origin` must not silently pad the live register.
  assert.equal(isPhoenixOriginatedRequest(null), false, "a null origin is treated as imported, never as live Phoenix work");
  assert.equal(isPhoenixOriginatedRequest(""), false, "an empty origin is treated as imported");
  assert.equal(isPhoenixOriginatedRequest("some_future_import"), false, "an unknown origin defaults to the archive side");

  assert.match(
    allRequestsSource,
    /isPhoenixSubmission/,
    "the register must filter its rows by Phoenix origin, not by status",
  );
  assert.match(
    allRequestsSource,
    /Archived \/ imported/,
    "the archived side must stay reachable behind its own switch rather than being dropped",
  );
  // Status counts must describe the Phoenix side only — counting all 218 would report a June
  // spreadsheet import's "101 approved" as live Phoenix work.
  assert.match(
    serviceSource,
    /const phoenixRows = rows\.filter\(\(row\) => row\.isPhoenixSubmission\)/,
    "summary counts must be computed from the Phoenix subset",
  );

  /* ---------------------------------------------------------------------- */
  /* An approver must stay in their OWN shell through the decision.           */
  /* ---------------------------------------------------------------------- */

  // MarketingRequestInbox defaults decisionBasePath to the PORTAL. The admin inbox rendered it
  // with no prop, so an SFE Manager — an admin-shell role, and this page's principal user — was
  // thrown out to /employee-portals the moment they clicked "Validate & Forward" mid-decision.
  // The workspace twin (admin-shell-employee-pages.tsx) already passed the admin path; this page
  // was simply missed.
  const adminInboxPageSource = source("app/(admin)/admin/marketing-requests/inbox/page.tsx");
  assert.match(
    adminInboxPageSource,
    /decisionBasePath="\/workspace\/marketing-requests\/decision"/,
    "the admin marketing inbox must send decisions to the admin shell, never the employee portal",
  );

  /* ---------------------------------------------------------------------- */
  /* SFE Validation must decide on EVIDENCE, not on the ask alone.           */
  /* ---------------------------------------------------------------------- */

  const evidenceSource = source("src/lib/marketing-requests/sales-evidence.ts");
  const evidencePanelSource = source("src/components/marketing-requests/marketing-sales-evidence-panel.tsx");
  const decisionConfirmationSource = source("src/components/employee-portal/marketing-request-decision-confirmation.tsx");

  // Only rows that are BOTH valid AND inside a validated batch may count — the same gate marketing
  // ROI attribution uses. Anything looser shows the approver numbers the ROI engine will not
  // honour, which is worse than showing nothing.
  assert.match(evidenceSource, /"validation_state", "valid"/, "sales evidence must count only rows marked valid");
  assert.match(
    evidenceSource,
    /source_of_sales_import_batches[\s\S]{0,220}"status", "validated"/,
    "sales evidence must count only rows inside a validated batch",
  );

  // Run-rate is per ACTIVE month, not per calendar month in the range: a pharmacy that bought in 3
  // of 6 months has a 3-month run-rate, and averaging over the gaps would understate it.
  assert.match(
    evidenceSource,
    /activeMonths > 0 \? round2\(totalValue \/ activeMonths\) : 0/,
    "the monthly run-rate must divide by ACTIVE months, never by the calendar range",
  );
  assert.match(
    evidenceSource,
    /projectedShortfall: round2\(Math\.max\(0, ask\.requiredRoiValue - projectedOverWindow\)\)/,
    "the shortfall must be measured against the request's own required return",
  );

  // A customer with no history must SAY so. An empty table reads as "the system is broken" rather
  // than "this customer is unproven" — the same misleading-zero trap as the products label above.
  assert.match(
    evidencePanelSource,
    /No historical sales/,
    "a customer with no sales history must be labelled, not rendered as an empty table",
  );
  assert.match(
    evidencePanelSource,
    /unproven customer, not missing data/,
    "the no-sales state must distinguish an unproven customer from absent data",
  );
  assert.match(
    evidencePanelSource,
    /no validated distributor pharmacy code/,
    "a customer with no matchable pharmacy code must explain why nothing could be matched",
  );

  // Evidence sits above the ask, and inline — the approver must never navigate away mid-decision.
  assert.match(
    decisionConfirmationSource,
    /<MarketingSalesEvidencePanel requestId=\{summary\.requestId\} \/>/,
    "the decision surface must show sales evidence inline",
  );
  assert.match(
    decisionConfirmationSource,
    /MarketingSalesEvidencePanel[\s\S]{0,700}What&apos;s being requested/,
    "sales evidence must appear BEFORE the ask, so the customer is judged before the spend is read",
  );

  // Reject and return already require a reason; pin it so the requirement cannot be dropped.
  assert.match(
    decisionConfirmationSource,
    /\(decision === "reject" \|\| decision === "return"\) && !decisionComment/,
    "reject and return must require a written reason",
  );

  const draftWorkspaceSource = source("src/components/employee-portal/marketing-request-drafts.tsx");
  assert.match(
    draftWorkspaceSource,
    /workspace\.requesterLineName === null \?[\s\S]{0,240}No product line assigned/,
    "the Products label must warn when the requester has no product line assigned",
  );

  /* ---------------------------------------------------------------------- */
  /* Notification deep-links must resolve to the viewer's OWN shell.          */
  /* ---------------------------------------------------------------------- */

  // The approver chain spans both shells — admin (Super Admin / SFE / Marketing Manager) and
  // portal (National Sales Manager / District Manager) — but a notification stores ONE actionUrl
  // shared by every recipient. Both old branches hardcoded a shell and so were wrong for half the
  // chain: the view link went to /admin/approvals-hub (which excludes marketing by design) and the
  // decision links went to the portal (which bounces admin-shell approvers to /overview).
  const REQ_ID = "09d4d45b-49fd-49b1-a2e8-99ec85e976a3";

  assert.equal(
    marketingRequestNotificationUrl(REQ_ID),
    `/marketing-requests/${REQ_ID}`,
    "the stored notification link must be shell-neutral",
  );
  assert.equal(
    marketingRequestNotificationUrl(REQ_ID, "approve"),
    `/marketing-requests/${REQ_ID}?decision=approve`,
    "a decision link must carry the decision through the shell-neutral link",
  );

  // No decision -> the inbox for that viewer's shell. Owner rule: the inbox is the marketing hub.
  assert.equal(
    resolveMarketingRequestDestination({ navigationMode: "admin", requestId: REQ_ID }),
    `/admin/marketing-requests/inbox?request=${REQ_ID}`,
    "an admin-shell viewer lands in the admin marketing inbox",
  );
  assert.equal(
    resolveMarketingRequestDestination({ navigationMode: "employee-portal", requestId: REQ_ID }),
    `/employee-portals/marketing-requests/inbox?request=${REQ_ID}`,
    "a portal viewer (NSM / District Manager) lands in the portal marketing inbox",
  );

  // With a decision -> that request's decision page, in the viewer's shell.
  assert.equal(
    resolveMarketingRequestDestination({ decision: "approve", navigationMode: "admin", requestId: REQ_ID }),
    `/workspace/marketing-requests/decision/${REQ_ID}?decision=approve`,
    "an admin-shell approver decides in the admin workspace, never the portal",
  );
  assert.equal(
    resolveMarketingRequestDestination({ decision: "return", navigationMode: "employee-portal", requestId: REQ_ID }),
    `/employee-portals/marketing-requests/decision/${REQ_ID}?decision=return`,
    "a portal approver decides in the portal",
  );

  // An unknown decision must never be reflected back into the URL.
  assert.equal(
    resolveMarketingRequestDestination({ decision: "drop-tables", navigationMode: "admin", requestId: REQ_ID }),
    `/admin/marketing-requests/inbox?request=${REQ_ID}`,
    "an unrecognised decision falls back to the inbox rather than being echoed into the URL",
  );

  // The regression that cost a 12-hour stall: marketing notifications pointing at the approvals hub.
  assert.doesNotMatch(
    serviceSource,
    /approvals-hub\?module=marketing/,
    "marketing notifications must never deep-link to the approvals hub, which excludes marketing by design",
  );

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
