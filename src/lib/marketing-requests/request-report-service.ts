import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { EMPLOYEE_AREA_SELECT, resolveEmployeeAreaName } from "@/lib/employees/employee-org-labels";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { effectiveMarketingInvoiceStatus } from "@/lib/marketing-requests/invoice-obligation";
import type {
  FullReportApprovalStep,
  FullReportPharmacy,
  FullReportProduct,
  FullReportRequest,
} from "@/lib/marketing-requests/request-report-columns";

// ─────────────────────────────────────────────────────────────────────────────
// Loader for the full Marketing Request report.
//
// Reads every table that says anything about a request and hands the workbook a fully resolved
// object — HR ids already turned into people's names, lookup ids already turned into labels. The
// owner's standing rule is that a report shows human-readable names, never raw codes, so the
// resolution belongs here rather than in the sheet writer.
//
// PHOENIX-ORIGIN ONLY. `origin = 'phoenix'` is applied in SQL, not filtered afterwards, so the
// 217 legacy `xlsx_import` rows never enter the working set. They predate the capture flow and
// would render as an almost entirely empty grid.
//
// One query per table, joined in memory by id. Deliberately NOT a single nested PostgREST select:
// the chain request → customer → contact → pharmacy → distributor-code → distributor is six deep,
// and one embedded-alias typo there fails at run time with a message that names none of them.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const text = (row: Row | undefined, key: string): string | null => {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
};

const num = (row: Row | undefined, key: string): number | null => {
  const value = row?.[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const bool = (row: Row | undefined, key: string): boolean | null => {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  return Boolean(value);
};

function indexBy<T extends Row>(rows: T[], key: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const id = row[key];
    if (id !== null && id !== undefined) map.set(String(id), row);
  }
  return map;
}

function groupBy<T extends Row>(rows: T[], key: string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = row[key];
    if (id === null || id === undefined) continue;
    const bucket = map.get(String(id));
    if (bucket) bucket.push(row);
    else map.set(String(id), [row]);
  }
  return map;
}

/** HR id → full name, so every actor column reads as a person rather than "B-184". */
function nameOf(directory: Map<string, string>, hrId: unknown): string | null {
  if (hrId === null || hrId === undefined) return null;
  const key = String(hrId).trim().toUpperCase();
  if (key === "") return null;
  return directory.get(key) ?? String(hrId).trim();
}

export type FullReportResult = {
  generatedAtIso: string;
  requests: FullReportRequest[];
};

export async function loadMarketingRequestFullReport(access: AccessContext): Promise<FullReportResult> {
  await assertPermission(access, "expenses", "read");
  const supabase = getSupabaseAdmin();

  const { data: requestRows, error: requestError } = await supabase
    .from("marketing_requests")
    .select("*")
    .eq("origin", "phoenix")
    .order("request_date", { ascending: true })
    .order("request_code", { ascending: true });
  if (requestError) throw requestError;

  const requests = (requestRows ?? []) as Row[];
  if (requests.length === 0) return { generatedAtIso: new Date().toISOString(), requests: [] };

  const requestIds = requests.map((row) => String(row.id));
  const customerIds = [...new Set(requests.map((row) => row.customer_id).filter(Boolean).map(String))];
  const contactIds = [...new Set(requests.map((row) => row.customer_contact_id).filter(Boolean).map(String))];
  const typeIds = [...new Set(requests.map((row) => row.request_type_id).filter((id) => id !== null && id !== undefined))];
  const lineIds = [...new Set(requests.map((row) => row.line_id).filter((id) => id !== null && id !== undefined))];
  const areaIds = [...new Set(requests.map((row) => row.area_id).filter((id) => id !== null && id !== undefined))];

  const [
    customersResult,
    contactsResult,
    typesResult,
    productsResult,
    pharmacyLinksResult,
    stepsResult,
    financeResult,
    roiFactsResult,
    employeesResult,
    linesResult,
    areasResult,
  ] = await Promise.all([
    customerIds.length > 0
      ? supabase.from("marketing_customers").select("*").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    contactIds.length > 0
      ? supabase.from("marketing_customer_contacts").select("*").in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    typeIds.length > 0
      ? supabase.from("marketing_request_types").select("*").in("id", typeIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("marketing_request_products").select("*").in("request_id", requestIds),
    supabase.from("marketing_request_pharmacies").select("*").in("request_id", requestIds),
    supabase.from("marketing_request_approval_steps").select("*").in("request_id", requestIds),
    supabase.from("marketing_request_finance_requirements").select("*").in("request_id", requestIds),
    supabase.from("marketing_roi_request_facts").select("*").in("request_id", requestIds),
    // The area from the `area_id` LINK — `employees.area_name` is a snapshot frozen at write time
    // (29 rows have a link and no label, 4 disagree with it). See employee-org-labels.ts.
    supabase.from("employees").select(`hr_id, full_name, nickname, region_name, line_id, ${EMPLOYEE_AREA_SELECT}`),
    lineIds.length > 0 ? supabase.from("lines").select("id, name").in("id", lineIds) : Promise.resolve({ data: [], error: null }),
    areaIds.length > 0 ? supabase.from("areas").select("id, name").in("id", areaIds) : Promise.resolve({ data: [], error: null }),
  ]);

  for (const result of [customersResult, contactsResult, typesResult, productsResult, pharmacyLinksResult,
    stepsResult, financeResult, roiFactsResult, employeesResult, linesResult, areasResult]) {
    if (result.error) throw result.error;
  }

  const productRows = (productsResult.data ?? []) as Row[];
  const pharmacyLinkRows = (pharmacyLinksResult.data ?? []) as Row[];

  // Second wave — the lookups whose ids only become known once the child rows are in hand.
  const catalogIds = [...new Set(productRows.map((row) => row.product_id).filter((id) => id !== null && id !== undefined))];
  const pharmacyIds = [...new Set(pharmacyLinkRows.map((row) => row.pharmacy_id).filter(Boolean).map(String))];
  const codeIds = [...new Set(pharmacyLinkRows.map((row) => row.distributor_code_id).filter(Boolean).map(String))];

  const [catalogResult, pharmaciesResult, codesResult] = await Promise.all([
    catalogIds.length > 0
      ? supabase.from("marketing_products").select("id, product_code, product_name, family, source_company, line")
        .in("id", catalogIds)
      : Promise.resolve({ data: [], error: null }),
    pharmacyIds.length > 0
      ? supabase.from("marketing_pharmacies").select("*").in("id", pharmacyIds)
      : Promise.resolve({ data: [], error: null }),
    codeIds.length > 0
      ? supabase.from("marketing_pharmacy_distributor_codes").select("*").in("id", codeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [catalogResult, pharmaciesResult, codesResult]) {
    if (result.error) throw result.error;
  }

  const codeRows = (codesResult.data ?? []) as Row[];
  const distributorIds = [...new Set(codeRows.map((row) => row.distributor_id).filter((id) => id !== null && id !== undefined))];
  const distributorsResult = distributorIds.length > 0
    ? await supabase.from("marketing_distributors").select("id, distributor_code, display_name").in("id", distributorIds)
    : { data: [], error: null };
  if (distributorsResult.error) throw distributorsResult.error;

  // ── indexes ──
  const directory = new Map<string, string>();
  const employeeRows = (employeesResult.data ?? []) as Row[];
  for (const row of employeeRows) {
    const hrId = text(row, "hr_id");
    const fullName = text(row, "full_name");
    if (hrId && fullName) directory.set(hrId.toUpperCase(), resolveEmployeeDisplayName(fullName, text(row, "nickname"), hrId));
  }
  const employeeByHrId = new Map<string, Row>();
  for (const row of employeeRows) {
    const hrId = text(row, "hr_id");
    if (hrId) employeeByHrId.set(hrId.toUpperCase(), row);
  }

  const customers = indexBy((customersResult.data ?? []) as Row[], "id");
  const contacts = indexBy((contactsResult.data ?? []) as Row[], "id");
  const types = indexBy((typesResult.data ?? []) as Row[], "id");
  const lines = indexBy((linesResult.data ?? []) as Row[], "id");
  const areas = indexBy((areasResult.data ?? []) as Row[], "id");
  const catalog = indexBy((catalogResult.data ?? []) as Row[], "id");
  const pharmacies = indexBy((pharmaciesResult.data ?? []) as Row[], "id");
  const codes = indexBy(codeRows, "id");
  const distributors = indexBy((distributorsResult.data ?? []) as Row[], "id");
  const finance = indexBy((financeResult.data ?? []) as Row[], "request_id");
  const roiFacts = indexBy((roiFactsResult.data ?? []) as Row[], "request_id");
  const productsByRequest = groupBy(productRows, "request_id");
  const pharmaciesByRequest = groupBy(pharmacyLinkRows, "request_id");
  const stepsByRequest = groupBy((stepsResult.data ?? []) as Row[], "request_id");

  const built: FullReportRequest[] = requests.map((row) => {
    const id = String(row.id);
    const customer = row.customer_id ? customers.get(String(row.customer_id)) : undefined;
    const contact = row.customer_contact_id ? contacts.get(String(row.customer_contact_id)) : undefined;
    const type = row.request_type_id != null ? types.get(String(row.request_type_id)) : undefined;
    const financeRow = finance.get(id);
    const roi = roiFacts.get(id);
    const requester = employeeByHrId.get(String(row.requester_hr_id ?? "").trim().toUpperCase());

    // Line falls back to the requester's own line: `marketing_requests.line_id` is optional on the
    // submit form, so a request can arrive without one while the rep always has one.
    const requestLineId = row.line_id ?? requester?.line_id ?? null;
    const lineName = requestLineId != null ? text(lines.get(String(requestLineId)), "name") : null;

    const steps: FullReportApprovalStep[] = (stepsByRequest.get(id) ?? [])
      .slice()
      .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
      .map((step) => ({
        allowReject: bool(step, "allow_reject"),
        allowReturn: bool(step, "allow_return"),
        assignedHrId: text(step, "assigned_hr_id"),
        assignedName: nameOf(directory, step.assigned_hr_id),
        assignedRole: text(step, "assigned_role"),
        decidedAt: text(step, "decision_at"),
        decidedByHrId: text(step, "decision_by_hr_id"),
        decidedByName: nameOf(directory, step.decision_by_hr_id),
        decisionNote: text(step, "decision_note"),
        executedAt: text(step, "executed_at"),
        isCc: bool(step, "is_cc"),
        sequence: num(step, "sequence"),
        status: text(step, "status"),
        stepCode: text(step, "step_code"),
        stepKind: text(step, "step_kind"),
        stepName: text(step, "step_name"),
        terminalStatus: text(step, "terminal_status"),
      }));

    const products: FullReportProduct[] = (productsByRequest.get(id) ?? []).map((product) => {
      const entry = product.product_id != null ? catalog.get(String(product.product_id)) : undefined;
      return {
        expectedValue: num(product, "expected_value"),
        factoryPriceSnapshot: num(product, "factory_price_snapshot"),
        forecastQuantity: num(product, "forecast_quantity"),
        // The snapshot is authoritative: it is what the request was costed on, even if the
        // catalog has been re-priced or renamed since.
        lineSnapshot: text(product, "line_snapshot") ?? text(entry, "line"),
        productCode: text(entry, "product_code"),
        productFamily: text(entry, "family"),
        productName: text(product, "product_name_snapshot") ?? text(entry, "product_name"),
        sourceCompany: text(entry, "source_company"),
        valueShare: num(product, "value_share"),
      };
    });

    const requestPharmacies: FullReportPharmacy[] = (pharmaciesByRequest.get(id) ?? []).map((link) => {
      const pharmacy = link.pharmacy_id ? pharmacies.get(String(link.pharmacy_id)) : undefined;
      const code = link.distributor_code_id ? codes.get(String(link.distributor_code_id)) : undefined;
      const distributor = code?.distributor_id != null ? distributors.get(String(code.distributor_id)) : undefined;
      return {
        capturedAccuracyMeters: num(pharmacy, "captured_accuracy_meters"),
        capturedAddress: text(pharmacy, "captured_address"),
        capturedAt: text(pharmacy, "captured_at"),
        capturedLatitude: num(pharmacy, "captured_latitude"),
        capturedLongitude: num(pharmacy, "captured_longitude"),
        distributorCode: text(distributor, "distributor_code"),
        distributorName: text(distributor, "display_name"),
        distributorPharmacyCode: text(code, "distributor_pharmacy_code"),
        evidenceStatus: text(pharmacy, "evidence_status"),
        extractedAreaName: text(pharmacy, "extracted_area_name"),
        extractedGovernorateName: text(pharmacy, "extracted_governorate_name"),
        notes: text(link, "notes"),
        pharmacyCode: text(pharmacy, "pharmacy_code"),
        pharmacyName: text(pharmacy, "display_name"),
        referenceMatchCount: num(code, "reference_match_count"),
        referenceStatus: text(code, "reference_status"),
        regionName: text(pharmacy, "region_name"),
        trackingStatus: text(link, "tracking_status"),
        validatedAt: text(pharmacy, "validated_at"),
        validatedByName: nameOf(directory, pharmacy?.validated_by_hr_id),
        validationNotes: text(pharmacy, "validation_notes"),
        validationStatus: text(pharmacy, "validation_status"),
      };
    });

    // "Current step" is the first step still waiting. An approved or rejected request has none,
    // and saying so beats leaving the reader to infer it from a blank cell.
    const pending = steps.find((step) => step.status !== "approved" && step.status !== "skipped" && !step.isCc);

    return {
      approvalSteps: steps,
      approvedAt: text(row, "approved_at"),
      areaName: row.area_id != null ? text(areas.get(String(row.area_id)), "name") : null,
      closedAt: text(row, "closed_at"),
      contactCode: text(contact, "contact_code"),
      contactCrmCode: text(contact, "crm_code"),
      contactMobileNumber: text(contact, "mobile_number"),
      contactName: text(contact, "contact_name"),
      contactNotes: text(contact, "notes"),
      contactSpecialty: text(contact, "specialty"),
      createdAt: text(row, "created_at"),
      createdByName: nameOf(directory, row.created_by_hr_id),
      currentStepName: pending?.stepName ?? null,
      customerCapturedAccuracyMeters: num(customer, "captured_accuracy_meters"),
      customerCapturedAddress: text(customer, "captured_address"),
      customerCapturedAt: text(customer, "captured_at"),
      customerCapturedLatitude: num(customer, "captured_latitude"),
      customerCapturedLongitude: num(customer, "captured_longitude"),
      customerCode: text(customer, "customer_code"),
      customerCreatedAt: text(customer, "created_at"),
      customerCreatedByName: nameOf(directory, customer?.created_by_hr_id),
      customerEvidenceHasTimestamp: bool(customer, "evidence_has_timestamp"),
      customerEvidencePhotoCapturedAt: text(customer, "evidence_photo_captured_at"),
      customerEvidencePhotoName: text(customer, "evidence_photo_name"),
      customerEvidenceStatus: text(customer, "evidence_status"),
      customerExtractedAreaName: text(customer, "extracted_area_name"),
      customerExtractedGovernorateName: text(customer, "extracted_governorate_name"),
      customerManagerName: nameOf(directory, customer?.manager_hr_id),
      customerName: text(customer, "display_name"),
      customerOtherTypeDescription: text(customer, "other_type_description"),
      customerOwnerName: nameOf(directory, customer?.owner_hr_id),
      customerRegionName: text(customer, "region_name"),
      customerType: text(customer, "customer_type"),
      customerValidatedAt: text(customer, "validated_at"),
      customerValidatedByName: nameOf(directory, customer?.validated_by_hr_id),
      customerValidationNotes: text(customer, "validation_notes"),
      customerValidationStatus: text(customer, "validation_status"),
      estimatedCost: num(row, "estimated_cost"),
      executedAt: text(row, "executed_at"),
      expectedRoiValue: num(row, "expected_roi_value"),
      financeInvoiceDeadlineDate: text(financeRow, "invoice_deadline_date"),
      financeInvoiceFileName: text(financeRow, "invoice_original_file_name"),
      financeInvoiceRequired: bool(financeRow, "invoice_required"),
      // The DERIVED status, not the stored column. An invoice eighteen days past its deadline is
      // still stored 'pending' by design (see invoice-obligation.ts), and an export that reported
      // that would disagree with the screen — which is the one thing an export may never do.
      financeInvoiceStatus: effectiveMarketingInvoiceStatus({
        invoiceDeadlineDate: text(financeRow, "invoice_deadline_date"),
        invoiceStatus: text(financeRow, "invoice_status"),
      }),
      financeInvoiceUploadedAt: text(financeRow, "invoice_uploaded_at"),
      financeInvoiceUploadedByName: nameOf(directory, financeRow?.invoice_uploaded_by_hr_id),
      financeNotes: text(financeRow, "notes"),
      financeReviewedAt: text(financeRow, "reviewed_at"),
      financeReviewerName: nameOf(directory, financeRow?.finance_reviewer_hr_id),
      financeTransferProofFileName: text(financeRow, "money_transfer_proof_original_file_name"),
      financeTransferProofUploadedAt: text(financeRow, "money_transfer_proof_uploaded_at"),
      financeTransferProofUploadedByName: nameOf(directory, financeRow?.money_transfer_proof_uploaded_by_hr_id),
      lineName,
      managerHrId: text(row, "manager_hr_id"),
      managerName: nameOf(directory, row.manager_hr_id),
      notes: text(row, "notes"),
      origin: text(row, "origin"),
      otherRequestType: text(row, "other_request_type"),
      payDate: text(row, "pay_date"),
      pharmacies: requestPharmacies,
      products,
      rejectedAt: text(row, "rejected_at"),
      requestCode: text(row, "request_code") ?? id,
      requestDate: text(row, "request_date"),
      requestTypeCode: text(type, "code"),
      requestTypeDescription: text(type, "description"),
      requestTypeName: text(type, "name"),
      requestTypeRequiresDescription: bool(type, "requires_description"),
      requesterAreaName: resolveEmployeeAreaName(requester),
      requesterHrId: text(row, "requester_hr_id"),
      requesterName: nameOf(directory, row.requester_hr_id),
      requesterRegionName: text(requester, "region_name"),
      requiredRoiValue: num(row, "required_roi_value"),
      returnedAt: text(row, "returned_at"),
      returnedStepSequence: num(row, "returned_step_sequence"),
      roiActualCoverageRatio: num(roi, "actual_coverage_ratio"),
      roiActualSalesUnits: num(roi, "actual_sales_units"),
      roiActualSalesValue: num(roi, "actual_sales_value"),
      roiActualStatus: text(roi, "actual_roi_status"),
      roiAttributionQuality: text(roi, "attribution_quality"),
      roiCalculatedAt: text(roi, "calculated_at"),
      roiCoverageGap: num(roi, "coverage_gap"),
      roiCoverageRatio: num(row, "roi_coverage_ratio"),
      roiDurationMonths: num(row, "roi_duration_months"),
      roiExactSalesRows: num(roi, "exact_sales_rows"),
      roiExpectedGap: num(roi, "expected_gap"),
      roiFallbackSalesRows: num(roi, "fallback_sales_rows"),
      roiPayMonth: text(roi, "pay_month"),
      roiRecommendedAction: text(roi, "recommended_action"),
      roiSalesRows: num(roi, "sales_rows"),
      roiStatus: text(row, "roi_status"),
      status: text(row, "status"),
      submittedAt: text(row, "submitted_at"),
      trackDirectSales: bool(row, "track_direct_sales"),
      updatedAt: text(row, "updated_at"),
      updatedByName: nameOf(directory, row.updated_by_hr_id),
    };
  });

  return { generatedAtIso: new Date().toISOString(), requests: built };
}
