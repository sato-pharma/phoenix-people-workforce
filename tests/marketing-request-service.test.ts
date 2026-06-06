import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "@/lib/auth/permissions";
import {
  buildMarketingApprovedRequestRows,
  normalizeMarketingRequestDraftInput,
  prepareMarketingRequestDraft,
} from "@/lib/marketing-requests/service";
import type { MarketingRequestCreateDraft } from "@/lib/marketing-requests/types";

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

export function runMarketingRequestServiceTests() {
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
      fuelAllowance: null,
      gender: null,
      grossSalary: null,
      hasBankAccount: null,
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
      expectedRoiValue: 10000,
      id: "REQ-1",
      lineId: 7,
      managerHrId: "DM001",
      notes: "RTD request",
      otherRequestType: null,
      payDate: "2026-06-01",
      rejectedAt: null,
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
}
