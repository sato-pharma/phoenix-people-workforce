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
  classifyMarketingWaitingSla,
  isPhoenixOriginatedRequest,
  marketingWaitingSince,
  normalizeMarketingRequestDraftInput,
  prepareMarketingRequestDraft,
  resolveLineCcRecipients,
  resolveMarketingRequestUuid,
} from "@/lib/marketing-requests/service";
import {
  planRestartedApprovalSteps,
  resubmitBasisChanges,
  resubmitRestartsApprovals,
  type ResubmitBasis,
} from "@/lib/marketing-requests/resubmit-rule";
import type { MarketingRequest, MarketingRequestCreateDraft } from "@/lib/marketing-requests/types";
import { LICENSE_ONLY_PHARMACY_NOTE } from "@/lib/venues/pharmacy-license";
import { customerFieldEvidenceGap } from "@/lib/marketing-requests/validation-report";

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
  birthPlace: null,
  qualification: null,
  universityName: null,
  collegeMajor: null,
  seniorYear: null,
  contractDuration: null,
  probationEndDate: null,
  medicalInsuranceCardReceivedDate: null,
  socialInsuranceStartDate: null,
  kaabElamaalNumber: null,
  kaabElamaalIssuer: null,
  kaabElamaalIssueDate: null,
  kaabElamaalRefund: null,
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
  hasCv: false,
  hasPhoto: false,
  healthCardStatus: null,
  healthCardNumber: null,
  healthCardReceivedDate: null,
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

/** Minimal stub of the Supabase client surface resolveLineCcRecipients uses. */
function fakeCcSupabase(rows: Array<{ hr_id: string; role?: string }>) {
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
  return { from: () => builder } as unknown as Parameters<typeof resolveLineCcRecipients>[0]["supabase"];
}

const ccRequest = { areaId: 30, id: "REQ-CC", lineId: 7 } as unknown as MarketingRequest;

export async function runMarketingRequestServiceTests() {
  // ── The validation report's "inferred, not GPS field-validated" badge ────────────────────────
  //
  // Production, 2026-08-23: 154 active links carry `system_validated` from the 2026-07-02 backfill
  // across 82 `ROI-C-…` customers whose own rows are still `pending` / `evidence_status = missing`
  // with no photo. The report labels a row by its LINK, so those read as field-proven. These pin
  // the rule that decides the badge — in BOTH directions, because the "some" reading would call a
  // rep who really made the visit a liar.
  const noEvidence = { customerEvidenceStatus: "missing", pharmacyEvidenceStatus: "missing" } as const;
  const inferredLink = { deskValidated: false, inferredFromHistory: true, secondCodeBackfill: false, ...noEvidence };
  const deskLink = { deskValidated: true, inferredFromHistory: false, secondCodeBackfill: false, ...noEvidence };
  const capturedLink = { deskValidated: false, inferredFromHistory: false, secondCodeBackfill: false, ...noEvidence };

  assert.equal(
    customerFieldEvidenceGap([inferredLink, inferredLink, inferredLink]),
    "inferred",
    "a customer whose every link came from the backfill must be badged — nobody has ever stood in front of it, and without the badge it reads exactly like this morning's capture",
  );
  assert.equal(
    customerFieldEvidenceGap([deskLink, deskLink]),
    "desk",
    "a customer validated only at a desk must be badged too — that is EVERY sfe_validated link in production, five of whose customers hold a map-search coordinate and no photo, and so read as field-proven while nobody ever went",
  );
  assert.equal(
    customerFieldEvidenceGap([inferredLink, deskLink]),
    "mixed",
    "ROI-C-7986552D8DC1 is exactly this shape after the 2026-08-21 owner merge — one backfill link plus two desk links — and naming it either origin alone would be half wrong",
  );
  assert.equal(
    customerFieldEvidenceGap([inferredLink, capturedLink]),
    null,
    "ONE genuine field capture must clear the badge — reading this as \"some\" would tell a rep who actually made the trip that nobody ever visited the customer, which is a worse lie than the one the badge exists to fix",
  );
  assert.equal(
    customerFieldEvidenceGap([deskLink, capturedLink]),
    null,
    "a desk link beside a real capture clears it for the same reason — the customer does have field evidence, whatever the other link says",
  );
  assert.equal(
    customerFieldEvidenceGap([capturedLink]),
    null,
    "a purely field-captured customer must never be badged",
  );
  assert.equal(
    customerFieldEvidenceGap([]),
    null,
    "no links means no validation claim on screen, so there is nothing for the badge to qualify",
  );

  // ── ...and the same rule applied to evidence that arrived AFTER the note was written ─────────
  //
  // A link's `validation_notes` are written once and never rewritten, so reading only them is
  // reading a claim about the past as a claim about the present. Production the day this was
  // fixed, 2026-08-23: 15 links across 8 customers already held a complete capture on one half or
  // the other and were badged regardless. Each shape below is one of those groups.
  const deskLinkVenueCaptured = { ...deskLink, pharmacyEvidenceStatus: "complete" } as const;
  const inferredLinkVenueCaptured = { ...inferredLink, pharmacyEvidenceStatus: "complete" } as const;
  const inferredLinkCustomerCaptured = { ...inferredLink, customerEvidenceStatus: "complete" } as const;
  const deskLinkCoordinateOnly = { ...deskLink, customerEvidenceStatus: "pending" } as const;

  assert.equal(
    customerFieldEvidenceGap([deskLinkVenueCaptured, deskLinkVenueCaptured]),
    null,
    "a desk validation whose SHOP was later photographed in the field must clear — this is وليد كمال (B-116), 4 links whose two venues were completed on 2026-08-18, two days AFTER the desk entry, and the note still said nobody had been",
  );
  assert.equal(
    customerFieldEvidenceGap([inferredLinkVenueCaptured]),
    null,
    "a backfilled link whose SHOP carries a complete capture must clear too — 6 links across 6 customers in production, where the venue is the only half that can still be captured because the customer is not at the shop when a rep calls",
  );
  assert.equal(
    customerFieldEvidenceGap([inferredLinkCustomerCaptured]),
    null,
    "a backfilled link whose CUSTOMER was photographed on site must clear — 5 links in production, and badging them is the exact lie this function documents as the worse one: telling a rep who made the trip that nobody ever went",
  );
  assert.equal(
    customerFieldEvidenceGap([inferredLink, inferredLinkVenueCaptured]),
    null,
    "one capture among several links clears the whole customer, exactly as a note-clean link always has — the every/some rule is about the customer, not about which column the evidence sits in",
  );
  assert.equal(
    customerFieldEvidenceGap([deskLinkCoordinateOnly, deskLinkCoordinateOnly]),
    "desk",
    "a PENDING half must never clear the badge: pending is a coordinate with no live photo, which is precisely the shape a map-search desk validation leaves behind and the reason the row is badged at all — 5 links across 4 customers in production",
  );
  // Both screens must render the SHARED badge. Two screens each carrying their own copy is exactly
  // how one of them ends up silently claiming field evidence the other one denies.
  for (const [label, rel] of [
    ["Customer Database", "src/components/employee-portal/marketing-customer-database.tsx"],
    ["Validation Workspace", "src/components/employee-portal/marketing-validation-workspace.tsx"],
  ] as const) {
    assert.match(
      source(rel),
      /marketing-requests\/not-field-validated-badge/,
      `the ${label} must import the shared not-field-validated badge`,
    );
  }

  // The workspace groups REPORT rows, which carry the customer and the pharmacy whole, so the two
  // evidence statuses have to be narrowed off them. Hand-assembling the input is what would put the
  // notes-only reading back without touching this file — typecheck catches passing the raw rows,
  // but not a literal with the evidence stubbed out.
  assert.match(
    source("src/components/employee-portal/marketing-validation-workspace.tsx"),
    /customerFieldEvidenceGap\(group\.rows\.map\(fieldEvidenceGapInput\)\)/,
    "the validation workspace must narrow its report rows through fieldEvidenceGapInput, so the badge sees the live evidence and not just the link's notes",
  );

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
  assert.match(serviceSource, /!isSamePerson\(step\.assignedHrId, actorHrId\)/, "wrong approver must be blocked, including under a shared-identity alias");
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

  // ── A link may carry the request CODE, not the UUID ──────────────────────────────────────────
  // The report sheet's "Request Preview" column prints `MKT-REQ-…`, which is the only identifier a
  // person ever sees; every read below keys on `marketing_requests.id`, a UUID. Both read surfaces
  // a link can land on must therefore resolve the code first, or the row cannot be found at all.
  // A decision link with NO `?decision=` is a READ, not a tampered decision. Both shells must send
  // it to the Case File — that is the shape of every "Request Preview" link the live sheet handed
  // out before this fix, and each one dead-ended on "Invalid Decision Link".
  const workspaceDecisionSource = source("src/components/workspace/admin-shell-employee-pages.tsx");
  for (const [label, pageSource] of [
    ["portal", decisionPageSource],
    ["admin shell", workspaceDecisionSource],
  ] as const) {
    assert.match(
      pageSource,
      /rawDecision === undefined\)[\s\S]{0,12}redirect\(`\/marketing-requests\/\$\{encodeURIComponent\(requestId\)\}`\)/,
      `a ${label} decision link with no decision must open the Case File, not the invalid-link dead end`,
    );
    assert.match(pageSource, /Invalid Decision Link/, `a ${label} decision link with a TAMPERED decision must still be refused`);
  }

  const caseFileSource = source("src/lib/marketing-requests/case-file-service.ts");
  assert.match(caseFileSource, /resolveMarketingRequestUuid/, "the Case File must accept a request code, not only a UUID");
  assert.match(
    serviceSource,
    /getMarketingRequestDecisionSummary[\s\S]*?resolveMarketingRequestUuid/,
    "the decision summary must accept a request code, not only a UUID",
  );

  const REAL_UUID = "3f8c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
  // A UUID passes straight through — no round trip on the path every notification link takes.
  let queriedCode: string | null = null;
  const uuidStub = {
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => {
          queriedCode = value;
          return { maybeSingle: async () => ({ data: { id: REAL_UUID }, error: null }) };
        },
      }),
    }),
  } as unknown as Parameters<typeof resolveMarketingRequestUuid>[0];

  assert.equal(await resolveMarketingRequestUuid(uuidStub, REAL_UUID), REAL_UUID);
  assert.equal(queriedCode, null, "a value already shaped like a UUID must not cost a database read");

  // A request code resolves to its UUID, upper-cased — codes are stored upper-case.
  assert.equal(await resolveMarketingRequestUuid(uuidStub, " mkt-req-20260818-d9e88e15 "), REAL_UUID);
  assert.equal(queriedCode, "MKT-REQ-20260818-D9E88E15");

  // An unknown code is not-found, never a silent null that reads as "no access".
  const emptyStub = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  } as unknown as Parameters<typeof resolveMarketingRequestUuid>[0];
  await assert.rejects(() => resolveMarketingRequestUuid(emptyStub, "MKT-REQ-NOPE"), /not found/i);

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
  // SLA reminders exist and classify both tiers (invocation from the daily cron is restored
  // behind a real admin toggle — see marketing_sla_reminder in role-recipients.ts).
  assert.match(serviceSource, /export async function runMarketingSlaDaily/, "marketing SLA daily job must exist");
  for (const slaEvent of ["due_date_reminder", "overdue_reminder"] as const) {
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
  for (const key of ["requestOwnerHrId", "assignedApproverHrId", "workflowParticipantHrIds"] as const) {
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

  // The customer's own validated link to the code the draft targets. Every target must come from
  // here since 2026-10-14 (`target_not_linked_to_customer`), so the fixtures name it explicitly.
  const targetLinks = [
    {
      distributorCodeId: "22222222-2222-2222-2222-222222222222",
      notes: null,
      pharmacyId: "33333333-3333-3333-3333-333333333333",
      status: "system_validated",
    },
  ];

  const prepared = prepareMarketingRequestDraft({
    customer,
    customerLinks: targetLinks,
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
        customerLinks: targetLinks,
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

  // -- Every target must be one of THIS customer's validated venues (owner audit, 2026-10-14) ---
  // `fetchPharmacyCodes` looks a code up by id alone, so before the guard a requester could name
  // any code in the database. The server now asks the customer's own links.
  const draftProducts = [
    { active: true, factory_price: 6, id: 1, line: "Anti infective", product_name: "Saginko" },
    { active: true, factory_price: 14, id: 2, line: "Anti infective", product_name: "Royafloxacin" },
  ];
  const targetCode = { active: true, id: "22222222-2222-2222-2222-222222222222", pharmacy_id: "33333333-3333-3333-3333-333333333333" };
  assert.throws(
    () =>
      prepareMarketingRequestDraft({
        customer,
        customerLinks: [],
        input: baseInput,
        pharmacyCodes: [targetCode],
        products: draftProducts,
        requestType,
        requester,
      }),
    /not one of this customer's validated venues/i,
    "a code the customer has no link to must be refused, not accepted because some other link is validated",
  );
  assert.throws(
    () =>
      prepareMarketingRequestDraft({
        customer,
        customerLinks: [{ ...targetLinks[0], status: "pending" }],
        input: baseInput,
        pharmacyCodes: [targetCode],
        products: draftProducts,
        requestType,
        requester,
      }),
    /not one of this customer's validated venues/i,
    "a link that is not validated is not a target",
  );

  // A target with no distributor code is NEVER accepted (owner, 2026-10-21: "any thing with no
  // distributor code never reach the marketing requests") — not a pharmacy waiting on its licence,
  // not one a person released, not a nursery. All three are refused in the one sentence.
  const codelessInput = {
    ...baseInput,
    pharmacies: [{ notes: null, targetId: "venue:44444444-4444-4444-4444-444444444444" }],
  } as unknown as MarketingRequestCreateDraft;
  const licenceVenue = { active: true, display_name: "Al Noor Pharmacy", id: "44444444-4444-4444-4444-444444444444", venue_type: "pharmacy" };
  const nurseryVenue = { ...licenceVenue, display_name: "حضانة النيل", venue_type: "nursery" };
  const codelessLink = (status: string, notes: string | null) => ({
    distributorCodeId: null,
    notes,
    pharmacyId: licenceVenue.id,
    status,
  });
  for (const [label, link, venue] of [
    ["a licence-only pharmacy still waiting", codelessLink("pending", LICENSE_ONLY_PHARMACY_NOTE), licenceVenue],
    ["a licence-only pharmacy a person released", codelessLink("admin_approved", LICENSE_ONLY_PHARMACY_NOTE), licenceVenue],
    ["an ordinary codeless pharmacy", codelessLink("admin_approved", null), licenceVenue],
    ["a validated nursery", codelessLink("system_validated", null), nurseryVenue],
  ] as const) {
    assert.throws(
      () =>
        prepareMarketingRequestDraft({
          customer,
          customerLinks: [link],
          input: codelessInput,
          products: draftProducts,
          requestType,
          requester,
          venuePharmacies: [venue],
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "venue_without_distributor_code"
        && /has no distributor code, so it cannot be in a marketing request/.test(String((error as Error).message))
        && String((error as Error).message).includes(venue.display_name),
      `${label} must be refused as a codeless target, naming the venue`,
    );
  }

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
      birthPlace: null,
      qualification: null,
      universityName: null,
      collegeMajor: null,
      seniorYear: null,
      contractDuration: null,
      probationEndDate: null,
      medicalInsuranceCardReceivedDate: null,
      socialInsuranceStartDate: null,
      kaabElamaalNumber: null,
      kaabElamaalIssuer: null,
      kaabElamaalIssueDate: null,
      kaabElamaalRefund: null,
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
      hasCv: false,
      hasPhoto: false,
      healthCardStatus: null,
      healthCardNumber: null,
      healthCardReceivedDate: null,
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

  /* ---------------------------------------------------------------------- */
  /* Marketing ladder: the chain must not duplicate a later dedicated step    */
  /* ---------------------------------------------------------------------- */

  // The live workflow gates SFE Manager (2), the line's review role (3), CEO (4) and Finance
  // Manager (5) with their own dedicated steps, and targets the managerial chain at National
  // Sales Manager -- a role that exists only on the SALES ladder.
  const liveGatedRoles = ["SFE Manager", "Marketing Manager", "CEO", "Finance Manager"];

  // Production org: A-10 Product Manager -> A-9 Marketing Manager -> AA CEO.
  const marketingLadderRows = [
    makeEmployee({ fullName: "Product Mgr", hrId: "PM010", jobTitle: "Product Manager", managerHrId: "MM009" }),
    makeEmployee({ fullName: "Group Product Mgr", hrId: "GPM008", jobTitle: "Group Product Manager", managerHrId: "MM009" }),
    makeEmployee({ fullName: "Marketing Mgr", hrId: "MM009", jobTitle: "Marketing Manager", managerHrId: "CEO001" }),
    makeEmployee({ fullName: "Chief", hrId: "CEO001", jobTitle: "CEO", managerHrId: null }),
  ];

  // Without the gate list the walk runs to the top of the company -- this is the shape that put
  // "Marketing Manager Approval" at sequence 1 and "CEO Approval" at sequence 2 in production,
  // ahead of SFE Validation and duplicating Marketing Review + CEO Approval further down.
  const pmRawChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: marketingLadderRows,
    requester: marketingLadderRows[0],
  });
  assert.deepEqual(
    pmRawChain.map((step) => step.assignedHrId),
    ["mm009", "ceo001"],
    "raw walk must still reach the top of the marketing ladder (this is what the gate list trims)",
  );

  // A Product Manager's managers ARE the later steps, so the gated chain is correctly empty.
  const pmChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: marketingLadderRows,
    requester: marketingLadderRows[0],
    rolesGatedLater: liveGatedRoles,
  });
  assert.deepEqual(
    pmChain.map((step) => step.assignedHrId),
    [],
    "Product Manager chain must be empty: Marketing Review and CEO Approval already gate both managers",
  );

  // Marketing Manager submits: his only manager is the CEO, who gates at ceo_approval.
  const mmChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: marketingLadderRows,
    requester: marketingLadderRows[2],
  });
  assert.deepEqual(mmChain.map((step) => step.assignedHrId), ["ceo001"], "raw Marketing Manager walk reaches the CEO");
  assert.deepEqual(
    buildMarketingManagerChain({
      chainTargetRole: "National Sales Manager",
      employeeRows: marketingLadderRows,
      requester: marketingLadderRows[2],
      rolesGatedLater: liveGatedRoles,
    }),
    [],
    "Marketing Manager chain must be empty: CEO Approval already gates his only manager",
  );

  // Deeper marketing ladder (B-155: PM -> GPM -> Marketing Manager -> CEO). The GPM is NOT a
  // gating role on this line, so it survives; the walk stops before the Marketing Manager.
  const deepPmRows = [
    makeEmployee({ fullName: "Cross-line PM", hrId: "PM155", jobTitle: "Product Manager", managerHrId: "GPM008" }),
    ...marketingLadderRows,
  ];
  const deepPmChain = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: deepPmRows,
    requester: deepPmRows[0],
    rolesGatedLater: liveGatedRoles,
  });
  assert.deepEqual(
    deepPmChain.map((step) => step.assignedHrId),
    ["gpm008"],
    "chain must keep the Group Product Manager rung and stop before the Marketing Manager",
  );

  // Line 2 routes Marketing Review to the Group Product Manager instead. The same requester's
  // chain must then collapse to nothing -- the gate list is per-line, not a fixed constant.
  const deepPmChainLine2 = buildMarketingManagerChain({
    chainTargetRole: "National Sales Manager",
    employeeRows: deepPmRows,
    requester: deepPmRows[0],
    rolesGatedLater: ["SFE Manager", "Group Product Manager", "CEO", "Finance Manager"],
  });
  assert.deepEqual(
    deepPmChainLine2.map((step) => step.assignedHrId),
    [],
    "a line reviewed by the Group Product Manager must not also gate that seat in the manager chain",
  );

  // The sales ladder must be untouched: none of its rungs are gated by a later step.
  assert.deepEqual(
    buildMarketingManagerChain({
      chainTargetRole: "National Sales Manager",
      employeeRows: repChainRows,
      requester: repChainRows[0],
      rolesGatedLater: liveGatedRoles,
    }).map((step) => step.assignedHrId),
    ["dm001", "nsm001"],
    "Medical Rep chain must be unchanged by the gate list",
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
    await resolveLineCcRecipients({ ccRoles: [], employeeRows: ccEmployees, request: ccRequest, supabase: fakeCcSupabase([]) }),
    [],
    "empty cc roles must resolve to no recipients",
  );

  // Many candidates: only same-line PM/GPM are CC'd; other-line GPM excluded.
  const manyCc = await resolveLineCcRecipients({
    ccRoles: ["Product Manager", "Group Product Manager"],
    employeeRows: ccEmployees,
    request: ccRequest,
    supabase: fakeCcSupabase([
      { hr_id: "PM001", role: "Product Manager" },
      { hr_id: "GPM001", role: "Group Product Manager" },
      { hr_id: "GPM002", role: "Group Product Manager" },
    ]),
  });
  assert.deepEqual(
    manyCc.map((entry) => entry.hrId).sort(),
    ["gpm002", "pm001"],
    "only same-line PM/GPM are CC recipients",
  );

  /**
   * Each CC recipient carries their OWN role, never the reviewer's. Line 1 reviews at Marketing
   * Manager and CCs the line's Product Manager, and stamping the reviewer's role onto that rung
   * printed "Marketing Review (CC) · Marketing Manager · <a Product Manager>" on both of A-10's
   * open production requests — two rungs reading "Marketing Manager", hiding which one decides.
   */
  assert.deepEqual(
    [...manyCc].sort((left, right) => left.hrId.localeCompare(right.hrId)).map((entry) => entry.role),
    ["Group Product Manager", "Product Manager"],
    "each CC recipient must carry their own role, not the reviewing role",
  );

  // Single candidate match.
  const oneCc = await resolveLineCcRecipients({
    ccRoles: ["Product Manager"],
    employeeRows: ccEmployees,
    request: ccRequest,
    supabase: fakeCcSupabase([{ hr_id: "PM001", role: "Product Manager" }]),
  });
  assert.deepEqual(
    oneCc,
    [{ hrId: "pm001", role: "Product Manager" }],
    "single same-line PM resolves to one CC recipient tagged Product Manager",
  );

  // An unrecognised `app_auth_users.role` must never DROP the recipient — a CC row is a
  // notification. It falls back to the employee master's own job-function role.
  const oddRoleCc = await resolveLineCcRecipients({
    ccRoles: ["Product Manager"],
    employeeRows: ccEmployees,
    request: ccRequest,
    supabase: fakeCcSupabase([{ hr_id: "PM001", role: "Something Unrecognised" }]),
  });
  assert.deepEqual(
    oddRoleCc,
    [{ hrId: "pm001", role: "Product Manager" }],
    "an unrecognised stored role falls back to the employee's job-function role, never a dropped CC",
  );

  // Unknown CC role string is ignored (no throw).
  assert.deepEqual(
    await resolveLineCcRecipients({ ccRoles: ["Not A Role"], employeeRows: ccEmployees, request: ccRequest, supabase: fakeCcSupabase([]) }),
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

  // A resubmit that changes the cost, the customer or the targets restarts the chain at the first
  // approver (owner, 2026-10-14); one that changes none of them resumes where it was returned.
  const approvedBasis: ResubmitBasis = {
    customerId: "cust-1",
    estimatedCost: 5000,
    targets: [
      { distributorCodeId: "code-a", pharmacyId: "ph-1" },
      { distributorCodeId: null, pharmacyId: "ph-2" },
    ],
  };
  assert.deepEqual(resubmitBasisChanges(approvedBasis, { ...approvedBasis }), [], "nothing moved: no restart");
  assert.equal(resubmitRestartsApprovals(approvedBasis, { ...approvedBasis }), false);
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, { ...approvedBasis, estimatedCost: 50000 }),
    ["cost"],
    "ten times the money was never what the District Manager approved",
  );
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, { ...approvedBasis, estimatedCost: 5000.004 }),
    [],
    "float noise below half a piastre is not a change",
  );
  assert.deepEqual(resubmitBasisChanges(approvedBasis, { ...approvedBasis, customerId: "CUST-2" }), ["customer"]);
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, { ...approvedBasis, customerId: " CUST-1 " }),
    [],
    "casing and padding of the same customer id is not a different customer",
  );
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, { ...approvedBasis, targets: [...approvedBasis.targets].reverse() }),
    [],
    "the same targets in a different order are not a change",
  );
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, {
      ...approvedBasis,
      targets: [...approvedBasis.targets, { distributorCodeId: "code-b", pharmacyId: "ph-3" }],
    }),
    ["targets"],
    "an added target is a change",
  );
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, {
      ...approvedBasis,
      targets: [{ distributorCodeId: "code-a", pharmacyId: "ph-1" }],
    }),
    ["targets"],
    "a removed target is a change",
  );
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, {
      ...approvedBasis,
      targets: [
        { distributorCodeId: "code-z", pharmacyId: "ph-1" },
        { distributorCodeId: null, pharmacyId: "ph-2" },
      ],
    }),
    ["targets"],
    "the same pharmacy through a different distributor code is a different target",
  );
  assert.deepEqual(
    resubmitBasisChanges(approvedBasis, {
      customerId: "cust-9",
      estimatedCost: 1,
      targets: [],
    }),
    ["customer", "cost", "targets"],
    "all three at once names all three",
  );

  const gate = (id: string, sequence: number, status: string, extra: Record<string, unknown> = {}) => ({
    decisionAt: null,
    decisionByHrId: null,
    decisionNote: null,
    id,
    isCc: false,
    sequence,
    status,
    ...extra,
  });
  const decided = { decisionAt: "2026-10-01T08:00:00Z", decisionByHrId: "B-1", decisionNote: "ok" };
  const chain = [
    gate("dm", 1, "approved", decided),
    gate("rm", 2, "returned", { ...decided, decisionNote: "cost looks high" }),
    gate("ceo", 3, "pending"),
    gate("cc-pm", 4, "skipped", { isCc: true }),
    gate("self", 5, "skipped", { decisionNote: "Skipped automatically: the assigned approver raised this request." }),
  ] as Parameters<typeof planRestartedApprovalSteps>[0];
  assert.deepEqual(
    planRestartedApprovalSteps(chain),
    [
      { status: "current", stepId: "dm" },
      { status: "pending", stepId: "rm" },
    ],
    "the first gate reopens, the rung that returned it waits again with its decision cleared, and a gate that was already pending with no decision needs no write",
  );
  assert.ok(
    !planRestartedApprovalSteps(chain).some((entry) => entry.stepId === "self" || entry.stepId === "cc-pm"),
    "a CC row and a skipped self-approval rung are not gates: reopening the self-approval rung would park the request on a rung its own assignee may not decide",
  );
  assert.deepEqual(
    planRestartedApprovalSteps([gate("only", 1, "returned", decided), gate("next", 2, "pending")] as Parameters<typeof planRestartedApprovalSteps>[0]),
    [{ status: "current", stepId: "only" }],
    "when the returning rung IS the first gate, only it changes",
  );
  assert.deepEqual(planRestartedApprovalSteps([]), []);

  // Every control write is on the record: who changed the routing of marketing money, and what it
  // held before. Setting, request type and approval step each write a required audit row.
  for (const fn of [
    "updateMarketingControlSetting",
    "updateMarketingControlRequestType",
    "updateMarketingControlWorkflowStep",
  ]) {
    const start = serviceSource.indexOf(`export async function ${fn}(`);
    assert.ok(start > 0, `${fn} must exist`);
    const nextExport = serviceSource.indexOf("\nexport ", start + 10);
    const body = serviceSource.slice(start, nextExport);
    assert.match(body, /await writeRequiredAuditLog\(/, `${fn} must write a REQUIRED audit row - a control change with no record is how nobody can say who re-pointed an approval`);
    assert.match(body, /entityType: "marketing_control"/, `${fn} must use the marketing_control entity type`);
    assert.match(body, /oldValues:/, `${fn} must record what the value was BEFORE`);
  }

  // The resubmit is ONE database transaction. A client-side claim-and-rollback was tried and rejected
  // in review (the rollback could not re-insert the GENERATED expected_value, a second resubmit could
  // claim on top of the first, and a write that committed but errored to the client was rolled back
  // around), so the service decides WHAT to write and the function makes it all-or-nothing.
  const resubmitBody = serviceSource.slice(
    serviceSource.indexOf("export async function resubmitReturnedMarketingRequest("),
    serviceSource.indexOf("export async function reopenRejectedMarketingRequest("),
  );
  assert.match(resubmitBody, /resubmitBasisChanges\(/, "the restart decision comes from the shared pure rule");
  assert.match(resubmitBody, /planRestartedApprovalSteps\(steps\)/, "the restart plan comes from the shared pure rule");
  assert.match(
    resubmitBody,
    /supabase\.rpc\("phx_resubmit_marketing_request"/,
    "the resubmit writes through the one-transaction function",
  );
  assert.doesNotMatch(
    resubmitBody,
    /\.from\("marketing_request(?:s|_products|_pharmacies|_approval_steps)"\)\s*\.(?:delete|insert|update)\(/,
    "the resubmit must not write these tables a call at a time any more - that is the half-applied state the function exists to prevent",
  );
  for (const code of [
    "marketing_request_not_found",
    "marketing_request_not_returned",
    "marketing_resubmit_not_requester",
    "marketing_resubmit_no_products",
    "marketing_resubmit_no_targets",
    "marketing_resubmit_invalid_steps",
    "marketing_resubmit_no_single_current_step",
  ]) {
    assert.ok(
      resubmitBody.includes(`message.includes("${code}")`),
      `the resubmit must map the function's ${code} refusal to a clean error, not a raw Postgres message`,
    );
  }
  assert.match(resubmitBody, /marketing_resubmit_conflict/, "a lost race says so with a stable code");
  // The notice follows the rung's recorded reopening - the key the decision path and the daily
  // backfill compute - or the approver is told once now and again at the next sweep.
  assert.match(
    resubmitBody,
    /await resolveMarketingStepReopenEpoch\(supabase, requestId, openedStep\.sequence\)\) \?\? now/,
    "the resubmit notice must key on the rung's reopen epoch, falling back to the call's own instant only when the rung opened once",
  );
  assert.match(resubmitBody, /idempotencyEpoch: reopenEpoch/, "the resubmit notice must carry that epoch");

  // The function itself, pinned by its text: the stored procedure is the only thing that can hold
  // these invariants, and a source test is the only thing that can hold the procedure.
  const resubmitSql = source("supabase/migrations/20261014140000_marketing_resubmit_atomic.sql");
  assert.ok(
    resubmitSql.indexOf("for update") > -1
      && resubmitSql.indexOf("for update") < resubmitSql.indexOf("raise exception 'marketing_request_not_returned"),
    "the request row is locked BEFORE its status is read, or two resubmits both see `returned`",
  );
  assert.match(resubmitSql, /security definer/, "it runs with the owner's rights, not the caller's");
  assert.match(
    resubmitSql,
    /revoke execute on function public\.phx_resubmit_marketing_request\([^)]*\)\s+from public, anon, authenticated;/,
    "browser roles must not be able to call it",
  );
  assert.match(
    resubmitSql,
    /grant execute on function public\.phx_resubmit_marketing_request\([^)]*\)\s+to service_role;/,
    "only the service role may call it",
  );
  const productInsert = /insert into marketing_request_products\s*\(([^)]*)\)/.exec(resubmitSql);
  assert.ok(productInsert, "the products are re-inserted");
  assert.ok(
    !productInsert![1].includes("expected_value"),
    "expected_value is GENERATED ALWAYS - naming it in the insert is refused and loses the products",
  );
  const pharmacyInsert = /insert into marketing_request_pharmacies\s*\(([^)]*)\)/.exec(resubmitSql);
  assert.ok(pharmacyInsert, "the targets are re-inserted");
  assert.ok(
    !pharmacyInsert![1].includes("tracking_status"),
    "a re-inserted target takes the column default for tracking_status, so an old validation never carries over to a new row",
  );
  assert.match(
    resubmitSql,
    /s\.request_id\s*=\s*p_request_id\s+and s\.is_cc\s*=\s*false/,
    "only gating rungs of THIS request may be rewritten",
  );
  assert.match(
    resubmitSql,
    /v_current <> 1 then\s+raise exception 'marketing_resubmit_no_single_current_step/,
    "it must refuse to commit unless exactly one gating rung is current - zero strands the request, two lets two people decide one step",
  );
  assert.match(
    resubmitSql,
    /v_written <> v_planned then\s+raise exception 'marketing_resubmit_invalid_steps/,
    "a rung that does not belong to this request must refuse the whole plan",
  );
  // The live definition is the LAST migration that replaces the function, not the first one above.
  const resubmitAuditSql = source(
    "supabase/migrations/20261015164459_marketing_resubmit_audit_id_uses_stored_requester.sql",
  );
  assert.match(
    resubmitAuditSql,
    /updated_by_hr_id\s+=\s+v_request\.requester_hr_id/,
    "the audit column takes the STORED requester id: the requester match ignores letter case but the employee foreign key does not",
  );
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
  // The report half moved to its own file in the premium pass (9 Nov 2026); the engine mounts it.
  const roiPanelsSource = source("src/components/marketing-requests/roi-report-panels.tsx");
  const roiSummarySource = source("src/lib/marketing-requests/roi-tracking-summary.ts");
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
  assert.match(roiPanelsSource, /attributionGapReason|resultStatus/, "ROI tracking UI must surface attribution status");
  assert.match(roiWorkspaceSource, /<RoiReportView /, "the Filter Engine mounts the report panels");
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
  assert.match(roiSummarySource, /export const ROI_ROWS_PER_PAGE = 10;/, "ROI tracking must paginate the browser row render");
  assert.match(roiPanelsSource, /const visible = sorted\.slice\(page\.start, page\.end\);/, "ROI tracking slices one page of rows");
  assert.match(roiPanelsSource, /visible\.map/, "ROI tracking must render visible rows instead of every report row at once");
  assert.match(roiPanelsSource, /React\.memo\(function ReportRow/, "ROI desktop report rows must be memoized");
  assert.match(roiPanelsSource, /React\.memo\(function ReportCard/, "ROI mobile report cards must be memoized");

  // New API routes exist.
  assert.match(source("app/api/marketing-requests/[id]/resubmit/route.ts"), /resubmitReturnedMarketingRequest/, "resubmit route must call the service");
  assert.match(source("app/api/marketing-requests/inbox/route.ts"), /getApproverPendingRequests/, "inbox route must call the service");
  assert.match(source("app/api/marketing-requests/[id]/route.ts"), /getMarketingRequestDetail/, "request detail route must call the service");

  // `createMarketingApprovalSteps` needs a live Supabase client, so its wiring is pinned at source
  // level: the gate list must actually be built from the later steps and handed to the chain
  // builder, and the requester must be excluded from the CC rows of their own request. Without
  // these, the builder's `rolesGatedLater` support above would be dead code.
  assert.match(
    serviceSource,
    /const rolesGatedLater = requiredSteps[\s\S]{0,400}?stepKind !== "managerial_chain"[\s\S]{0,200}?effectiveStepRole\(step\)/,
    "createMarketingApprovalSteps must derive the gated-role list from the later dedicated steps",
  );
  assert.match(
    serviceSource,
    /buildMarketingManagerChain\(\{[\s\S]{0,300}?rolesGatedLater,/,
    "createMarketingApprovalSteps must pass rolesGatedLater into the managerial chain walk",
  );
  assert.match(
    serviceSource,
    /for \(const \{ hrId: ccHrId, role: ccRole \} of ccRecipients\)[\s\S]{0,900}?isSamePerson\(ccHrId, params\.request\.requesterHrId\)\) continue;/,
    "the requester must never be CC'd on their own marketing request",
  );
  // A CC rung names a person, so it must print THAT person's role. Reusing `effectiveRole` here
  // labelled the line's Product Manager "Marketing Manager" on the case file.
  assert.match(
    serviceSource,
    /assignedHrId: ccHrId, assignedRole: ccRole, isCc: true/,
    "a CC rung must be stamped with the CC recipient's own role, never the reviewing role",
  );
  /* ---------------------------------------------------------------------- */
  /* Assignment notice: a decision recorded outside the app must still notify */
  /* ---------------------------------------------------------------------- */

  /**
   * A CEO approval written straight into the database never runs the notify path, so the request
   * lands on Finance Execution and its approver is never told. `MKT-REQ-20260818-8C628BF4` sat
   * there with zero deliveries on any channel while its sibling, decided through the UI 22 minutes
   * earlier, reached Ahmed El Maraghy on email, in-app and push.
   */
  assert.match(
    serviceSource,
    /export async function dispatchMarketingAssignmentEmail\(requestId: string\)/,
    "the service must expose a by-request-id assignment dispatcher, like direct orders' dispatchDirectOrderApprovedEmail",
  );
  /**
   * Sliced to the function BODY rather than matched inside a fixed byte window. The window form
   * (`[\s\S]{0,2600}?`) false-failed the moment this function gained a comment — measured at 2,939
   * characters on 2026-08-30 — which says nothing at all about whether the notice is still sent.
   * See AGENTS.md §2.1, "source-pinning tests slice a fixed BYTE window and false-FAIL".
   */
  const dispatcherStart = serviceSource.indexOf("export async function dispatchMarketingAssignmentEmail(");
  const dispatcherEnd = serviceSource.indexOf("export async function backfillMissingMarketingAssignmentEmails(");
  assert.ok(dispatcherStart > -1, "dispatchMarketingAssignmentEmail must be declared in the service");
  assert.ok(dispatcherEnd > dispatcherStart, "backfillMissingMarketingAssignmentEmails must follow the dispatcher");
  const dispatcherBody = serviceSource.slice(dispatcherStart, dispatcherEnd);
  assert.match(
    dispatcherBody,
    /eventType: "request_assigned"/,
    "the dispatcher must send the same request_assigned notice the decision path sends",
  );
  /**
   * A rung that was RETURNED and then reopened has already claimed its step-id key, so without an
   * epoch the UNIQUE index silently swallows the notice and the approver is never told the request
   * came back. `marketingReopenEpoch` is unit-tested on its own; this pins that the dispatcher
   * actually WIRES it, which passing unit tests cannot show.
   */
  assert.match(
    dispatcherBody,
    /marketingReopenEpoch\(await loadMarketingStepOpenings\(/,
    "the dispatcher must resolve the reopen epoch from the rung's recorded openings",
  );
  assert.match(
    dispatcherBody,
    /idempotencyEpoch: reopenEpoch/,
    "the dispatcher must pass the reopen epoch through, or a reopened rung re-uses its spent key",
  );
  /**
   * The SAME epoch must ride the notice the decision path sends when an approval advances the chain.
   * A resubmit that restarts the chain reopens rungs that already told their approver once, and the
   * delivery key is unique per rung - so a decision that advances onto one of them without the epoch
   * notifies nobody, and the request sits unseen until the daily backfill (which does pass it).
   */
  const decideStart = serviceSource.indexOf("export async function decideMarketingRequestWorkflow(");
  const decideEnd = serviceSource.indexOf("function mapCustomer(", decideStart);
  assert.ok(decideStart > -1 && decideEnd > decideStart, "decideMarketingRequestWorkflow must be declared before mapCustomer");
  const decideBody = serviceSource.slice(decideStart, decideEnd);
  assert.match(
    decideBody,
    /await resolveMarketingStepReopenEpoch\(supabase, request\.id, currentNextStep\.sequence\)/,
    "advancing an approval must resolve the next rung's reopen epoch, or a restarted chain's later approvers are never told",
  );
  assert.match(
    decideBody,
    /idempotencyEpoch: nextStepEpoch/,
    "advancing an approval must pass the reopen epoch to the notice, or the rung's spent key swallows it",
  );
  // It must refuse to invent a recipient when nobody is holding the request.
  for (const guard of ["request_not_pending", "no_current_step", "already_notified"]) {
    assert.match(
      serviceSource,
      new RegExp(`reason: "${guard}"`),
      `the dispatcher must bail with ${guard} rather than notifying the wrong person`,
    );
  }
  assert.match(
    serviceSource,
    /export async function backfillMissingMarketingAssignmentEmails\(\)/,
    "a backstop must re-drive assignment notices so a silent miss self-heals",
  );

  assert.match(
    dailyRouteSource,
    /backfillMissingMarketingAssignmentEmails\(\)\.catch\(/,
    "the daily job must run the assignment backfill",
  );

  /**
   * An on-demand route for the same sweep, so a miss can be repaired the moment it is found rather
   * than waiting for tomorrow's daily run — and so the mail leaves PRODUCTION, whose PHOENIX_APP_URL
   * is the live domain, instead of a developer machine still carrying the decommissioned Vercel URL.
   * It must be cron-secret guarded like every other cron route, never open.
   */
  const backfillRouteSource = source("app/api/cron/marketing-assignment-backfill/route.ts");
  // Repointed 2026-08-29 (A2): both facts this asserted — the cron-secret comparison and the
  // logged 401 — moved into src/lib/security/cron-auth.ts, where they are stated once and pinned
  // by tests/cron-auth-single-guard.test.ts. Asserting the guard is CALLED, with this route's own
  // job slug, keeps what this file actually cares about: that the backfill route is guarded at all.
  assert.match(
    backfillRouteSource,
    /assertCronAuthorized\(request, "cron\/marketing-assignment-backfill"\)/,
    "the on-demand backfill route must be cron-secret guarded, and log its own slug when it refuses",
  );
  assert.match(
    backfillRouteSource,
    /backfillMissingMarketingAssignmentEmails\(\)/,
    "the route must drive the assignment backfill",
  );
  /**
   * The backfill must NOT sit behind `marketing_sla_reminder`. That toggle governs CHASING an
   * approver who already knows; it has been enabled=false since 2026-07-23, and gating the primary
   * "there is work on your desk" notice behind it is what let the miss go unseen.
   */
  assert.doesNotMatch(
    serviceSource,
    /backfillMissingMarketingAssignmentEmails\(\)[\s\S]{0,600}?resolveNotificationRoleEnabled\("marketing_sla_reminder"\)/,
    "the assignment backfill must not be gated on the SLA reminder toggle",
  );

  assert.doesNotMatch(
    serviceSource,
    /assignedHrId: ccHrId, assignedRole: effectiveRole/,
    "no CC rung may reuse the reviewing role",
  );

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
  // The no-sales state must still explain ITSELF rather than render a bare zero — but it may no
  // longer rule on what the emptiness proves. The old wording ("this is an unproven customer, not
  // missing data") was a verdict the panel could not earn: it was shown for customers whose code
  // was simply registered without its leading zeros, one of whom had EGP 8,981 of real trade.
  assert.match(
    evidencePanelSource,
    /treat it as unproven rather than disproven/,
    "the no-sales state must name both readings instead of asserting the customer never bought",
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

  /* ---------------------------------------------------------------------- */
  /* The approval window must carry EVERY submitted detail (owner 08-04).    */
  /* ---------------------------------------------------------------------- */

  // The screen used to show a customer NAME and a pharmacy COUNT, and asked the approver to commit
  // real money on that. Each field below was captured at submission and never carried through.
  for (const field of [
    "customerCode",
    "customerType",
    "customerSpeciality",
    "customerContactName",
    "customerContactMobile",
    "customerArea",
    "customerGovernorate",
    "customerAddress",
    "evidencePhotoName",
    "targetPharmacies",
    "requestDate",
    "roiCoverageRatio",
    "notes",
  ]) {
    assert.match(
      serviceSource,
      new RegExp(`${field}:`),
      `the decision summary must carry ${field} through to the approval window`,
    );
    assert.match(
      decisionConfirmationSource,
      new RegExp(`summary\\.${field}`),
      `the approval window must render ${field}`,
    );
  }

  // A pharmacy COUNT cannot tell an intended campaign from a mis-picked one. The approver needs the
  // names, the distributor and whether each vendor code was ever matched.
  assert.match(
    decisionConfirmationSource,
    /summary\.targetPharmacies\.map/,
    "target pharmacies must be listed individually, never collapsed to a count",
  );
  assert.match(
    decisionConfirmationSource,
    /pharmacy\.referenceStatus/,
    "each target pharmacy must show whether its vendor code was matched",
  );
  // Absent data must never render blank — a blank cell reads as "this is nothing", which is a
  // different claim from "this was never recorded". Same rule as the products label in this module.
  assert.match(
    decisionConfirmationSource,
    /value \|\| "Not captured"/,
    "a field with no value must say so rather than rendering an empty cell",
  );
  assert.match(
    decisionConfirmationSource,
    /No target pharmacies were attached to this request/,
    "a request with no target pharmacies must say so — nothing can be attributed to it",
  );

  // `marketing_customers` has NO `speciality` column. Naming it in the decision-summary select threw
  // "column does not exist" and took the entire approval window down to its safe state in
  // production. The real free-text qualifier is `other_type_description`.
  //
  // Narrow by construction, and worth saying plainly: a source assertion cannot verify that a
  // column exists — only a query against a real schema can. This pins the one name that broke,
  // it does not make the whole select safe.
  assert.doesNotMatch(
    serviceSource,
    /customer_type, speciality/,
    "the decision summary must not select a speciality column — marketing_customers has none",
  );
  assert.match(
    serviceSource,
    /customer_type, other_type_description/,
    "the decision summary must read the customer's free-text qualifier from other_type_description",
  );

  /* ---------------------------------------------------------------------- */
  /* The inbox must track from SUBMISSION, not from your turn (owner 08-04). */
  /* ---------------------------------------------------------------------- */

  // The inbox queried status='current' only, so an approver above rung 1 saw nothing until the
  // request was already theirs. The CEO sits at step 4 of 4 and could be accountable for a request
  // stalled for days with an empty inbox. Upcoming rows close that blind spot.
  assert.match(
    serviceSource,
    /\.eq\("status", "pending"\)[\s\S]{0,80}\.eq\("is_cc", false\)[\s\S]{0,80}\.in\("assigned_hr_id", actorHrKeys\)/,
    "the inbox must also load steps assigned to the actor that have not opened yet",
  );
  assert.match(serviceSource, /upcomingRows/, "the inbox workspace must expose upcoming rows");
  // Each upcoming row must answer where it is stopped and for how long — a bare list of request
  // codes would not tell the approver anything they could act on.
  for (const field of ["awaitingStepName", "awaitingApproverName", "ageDays", "totalGatingSteps"]) {
    assert.match(serviceSource, new RegExp(field), `an upcoming row must carry ${field}`);
  }
  // Age is measured from SUBMISSION, not from when it reached the current holder: the question a
  // downstream approver asks is "how long has this been in the system?".
  assert.match(
    serviceSource,
    /request\.submittedAt \? Date\.parse\(request\.submittedAt\) : Number\.NaN/,
    "upcoming age must be measured from submission",
  );
  assert.match(
    serviceSource,
    /upcomingRows\.sort\(\(left, right\) => right\.ageDays - left\.ageDays\)/,
    "the oldest waiting request must surface first — that is the one worth chasing",
  );

  const inboxSource = source("src/components/employee-portal/marketing-request-inbox.tsx");
  assert.match(inboxSource, /Coming to you/, "the inbox must show requests heading toward the approver");
  assert.match(
    inboxSource,
    /Now with \$\{row\.awaitingApproverName/,
    "an upcoming row must name who is holding the request right now",
  );
  // No decision controls on an upcoming row — it is not the actor's turn, and offering a button
  // that the server would refuse is worse than offering none.
  assert.match(
    inboxSource,
    /Your step is \{row\.myStepSequence\} of \{row\.totalGatingSteps\}/,
    "an upcoming row must state where the actor's own rung sits in the chain",
  );
  assert.match(
    inboxSource,
    /No marketing requests involve you right now/,
    "the empty state must reflect that the inbox now covers more than the actor's own turn",
  );

  /* ---------------------------------------------------------------------- */
  /* Requested-product history must be judged separately (owner 2026-08-04). */
  /* ---------------------------------------------------------------------- */

  // The whole-customer total flatters a request. On MKT-REQ-20260802-DCF31EC4 the customer had
  // traded EGP 2,774 over six months while only ONE of five promoted products had ever sold there.
  // The customer buys Tebofortine 40mg (TE003); the request promotes Forte 80 (TE002) and 120
  // (TE005) — same family, different SKUs.
  assert.match(
    evidenceSource,
    /requestedByCode\.has\(String\(row\.product_code/,
    "requested-product sales must match on product CODE, never on name",
  );
  // A name match would quietly credit "Tebofortine 40 mg" to "Tebofortine Forte 80".
  assert.doesNotMatch(
    evidenceSource,
    /requestedByName/,
    "requested-product matching must not fall back to a name index",
  );
  assert.match(
    evidenceSource,
    /const neverSold = requestedProductNames\.filter/,
    "products with no history at this customer must be named, not merely omitted",
  );
  // Snapshot names keep a product removed from the master since submission in the never-sold list
  // rather than letting it vanish from the count.
  assert.match(
    evidenceSource,
    /product_name_snapshot/,
    "requested products must fall back to the submission snapshot name",
  );

  const requestedHistorySource = source("src/components/marketing-requests/marketing-requested-product-history.tsx");
  assert.match(
    requestedHistorySource,
    /ever\s*\n?\s*sold at this customer/,
    "a request whose promoted products have never sold here must say so outright",
  );
  // The strip must fail quiet: a broken lookup cannot cost the approver the inbox row itself.
  assert.match(
    requestedHistorySource,
    /Sales history for the requested products is unavailable right now/,
    "a failed lookup must degrade to a message, never blank or crash the row",
  );
  assert.match(
    inboxSource,
    /<MarketingRequestedProductHistory requestId=\{row\.id\} \/>/,
    "the inbox row itself must carry requested-product history, not hide it one click away",
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
    customerLinks: targetLinks,
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
        customerLinks: targetLinks,
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
  // The fixture mirrors his real assignment since 2026-09-28: Guamusin IS his, and Lacto Advanced
  // is the product on his own line that is NOT — so Lacto is the one the clamp must still reject.
  // Guamusin used to play that excluded role here, which now reads as contradicting production.
  const b155Products = [
    { active: true, factory_price: 270, id: 10, line: "Pedia", line_id: 7, product_code: "LA001", product_name: "Lacto Advanced 1" },
    { active: true, factory_price: 0, id: 11, line: "Pedia", line_id: 7, product_code: "TG001", product_name: "Tigogrow" },
    { active: true, factory_price: 0, id: 12, line: "Anti infective", line_id: 1, product_code: "OS001", product_name: "Osteosat" },
    { active: true, factory_price: 60.75, id: 13, line: "Pedia", line_id: 7, product_code: "GU001", product_name: "Guamusin" },
  ];
  const b155AllowedCodes = new Set(["TG001", "OS001", "GU001"]);

  const b155Scope = buildMarketingDraftProductScope({
    access: createAccessContext({ hrId: "B-155", role: "Product Manager" }),
    productRows: b155Products,
    requester: b155Requester,
    allowedProductCodes: b155AllowedCodes,
  });
  assert.deepEqual(
    b155Scope.products.map((product) => product.id).sort((a, b) => a - b),
    [11, 12, 13],
    "B-155 exception: product picker is EXACTLY his override codes, excluding his own native-line product (Lacto Advanced) which isn't one of them",
  );

  assert.throws(
    () =>
      prepareMarketingRequestDraft({
        customer,
        customerLinks: targetLinks,
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
    "B-155 exception: his own native-line product (Lacto Advanced) is rejected on submit because it's not in his override",
  );

  const b155Submit = prepareMarketingRequestDraft({
    customer,
    customerLinks: targetLinks,
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

  // ── The waiting clock must measure from step_opened, never from updated_at ──────────────────
  //
  // Real incident, 2026-08-19: a config backfill switched `allow_return` off across every live
  // Finance Execution rung (owner's rule — nothing may block a request once the CEO has approved)
  // and wrote `updated_at = now()` on four in-flight steps as a side effect. One had been sitting
  // with Finance since 15 Aug. Its "waiting 4 days" silently became "waiting 0 days", so the
  // stuck-request reminder — the whole point of this second clock — would have stayed quiet.
  // `updated_at` is a generic row-modification stamp; `step_opened` fires only when a rung is
  // actually opened, which is what "how long has this been on someone's desk" means.
  {
    const OPENED = "2026-08-15T18:55:00.000Z";
    const TOUCHED_BY_BACKFILL = "2026-08-19T14:09:45.000Z";
    const NOW = "2026-08-19T16:00:00.000Z";

    assert.equal(
      marketingWaitingSince({ createdAt: OPENED, openedAt: OPENED, updatedAt: TOUCHED_BY_BACKFILL }),
      OPENED,
      "waiting-since must prefer the step_opened event over a row touched by an unrelated write",
    );

    // The headline assertion: with the old clock this request read 0 days and fired nothing.
    assert.equal(
      classifyMarketingWaitingSla({
        now: NOW,
        waitingSince: marketingWaitingSince({ openedAt: OPENED, updatedAt: TOUCHED_BY_BACKFILL }),
      }),
      "due_date_reminder",
      "a request opened 4 days ago must still be chased after a config write touches its step row",
    );
    assert.equal(
      classifyMarketingWaitingSla({ now: NOW, waitingSince: TOUCHED_BY_BACKFILL }),
      null,
      "sanity: reading updated_at is exactly what silenced it, so that path must still read as silent",
    );

    // Fallbacks are load-bearing, not padding. `step_opened` capture began 2026-08-15, so older
    // requests have no event at all — returning null for them would drop the oldest, most stuck
    // requests out of the waiting rule entirely, which is strictly worse than the bug being fixed.
    assert.equal(
      marketingWaitingSince({ createdAt: "2026-08-01T00:00:00.000Z", updatedAt: OPENED }),
      OPENED,
      "a step with no recorded opening must fall back to updated_at, never to null",
    );
    assert.equal(
      marketingWaitingSince({ createdAt: OPENED }),
      OPENED,
      "with neither an opening nor an update, created_at is the last honest fallback",
    );
    assert.equal(marketingWaitingSince({}), null, "an empty step has no clock to report");
  }

  // Both consumers of the clock must go through the helper. The daily scan is the one that broke;
  // the sidebar badge reads the same signal and would lie in exactly the same way.
  assert.match(
    serviceSource,
    /const waitingSince = marketingWaitingSince\(\{/,
    "the daily SLA scan must resolve waiting-since through the shared helper",
  );
  assert.doesNotMatch(
    serviceSource,
    /const waitingSince = step\?\.updated_at \?\? step\?\.created_at/,
    "the daily SLA scan must not read updated_at as the waiting clock — that is the defect",
  );
  assert.doesNotMatch(
    serviceSource,
    /marketingDaysWaiting\(step\.updatedAt \?\? step\.createdAt, input\.now\)/,
    "the approver badge must not read updated_at as the waiting clock either",
  );
  assert.match(
    serviceSource,
    /kind", "step_opened"/,
    "waiting-since must be sourced from the step_opened event",
  );
  // One batched read, not one per request: this runs from Amsterdam against Frankfurt.
  assert.match(
    serviceSource,
    /const stepOpenedAt = await loadMarketingStepOpenedAt\([\s\S]{0,120}?\);\s*\n\s*for \(const row of rows\) \{/,
    "the SLA scan must load every rung's opening once, before the per-request loop",
  );
}
