// ─────────────────────────────────────────────────────────────────────────────
// Per-request loaders shared by the approval screen and the Case File.
//
// These three readers were private to service.ts, which is 6,000 lines and already the module's
// bottleneck for review. The Case File needs exactly the same reads, so they moved HERE rather than
// being exported out of that file (which would have widened it further) or copied (which is how two
// surfaces start disagreeing about the same request).
//
// service.ts re-imports them, so every existing caller is unaffected. Nothing here enforces access:
// authorization belongs to the caller, and each of these is invoked only after its caller has
// settled who is asking.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadMarketingEvidencePhotosByEntityIds,
  loadMarketingPharmacyLicensesByPharmacyIds,
  type MarketingPharmacyLicenseFile,
} from "@/lib/marketing-requests/evidence-photo-storage";
import {
  describeOverlap,
  findRequestOverlaps,
  windowMonths,
  type OverlapCandidate,
} from "@/lib/marketing-requests/request-overlap";
import {
  findMarketingRequestTwins,
  MARKETING_REQUEST_TWIN_STATUSES,
  type TwinCandidate,
  type TwinSubject,
} from "@/lib/marketing-requests/twin-request";
import type { MarketingRequest, MarketingValidationStatus } from "@/lib/marketing-requests/types";

/** One target pharmacy exactly as the requester submitted it — never collapsed to a count. */
export type MarketingDecisionPharmacy = {
  distributorName: string;
  distributorPharmacyCode: string;
  /**
   * Signed URL for this pharmacy's own retained shop-front photo, or null when none was kept.
   *
   * The pharmacy photo is captured and stored on exactly the same rule as the customer's — two of
   * the three rows that historically claimed unretained proof were pharmacies, not customers — so
   * not surfacing it would mean storing evidence nobody can ever look at.
   */
  evidencePhotoUrl: string | null;
  /**
   * The pharmacy trade licence (رخصة الصيدلية), when one was attached at validation.
   *
   * A DIFFERENT KIND OF PROOF from `evidencePhotoUrl`, and that is the whole point of showing both:
   * the shop-front photo says WHERE the venue is, the licence says WHO it is. An approver comparing
   * the trade name on the licence against the name on the sign in the photo is doing the identity
   * check that a distributor code would otherwise have done for free. `contentType` travels with it
   * because a licence is routinely a PDF, which must be offered as a link rather than an `<img>`.
   */
  licenseContentType: string | null;
  /**
   * The approver's recorded answer to the comparison the licence exists for, or `null` when nobody
   * has been asked yet. NEVER render a null as a pass — "not checked" and "checked and fine" are
   * different facts, and a blank row reads as the second one.
   */
  licenseNameMatchesSign: boolean | null;
  licenseUrl: string | null;
  notes: string | null;
  /** The link row's own id, so a caller can join back to per-pharmacy detail. */
  pharmacyId: string | null;
  pharmacyCode: string;
  pharmacyName: string;
  /** "matched" | "unverified" | ... — an unverified code is the approver's business. */
  referenceStatus: string;
  /**
   * Whether `referenceStatus` was actually READ, or defaulted because the distributor-code row
   * could not be resolved.
   *
   * This exists because `referenceStatus` coalesces a failed lookup to the benign-looking
   * "pending". Production holds 273 matched / 16 not_found / ZERO genuine pending codes, so every
   * "pending" on screen today is in fact a lookup that missed wearing a harmless label. Callers
   * that care about the difference (the Case File does) read this; the approval screen keeps its
   * existing single-string behaviour.
   */
  referenceLookup: "resolved" | "lookup_failed";
  /**
   * The pharmacy's OWN validation state, raw ('pending' | 'system_validated' | 'sfe_validated' |
   * 'admin_approved' | 'rejected').
   *
   * DISTINCT from `referenceStatus`, which is only about the distributor CODE match: a target
   * pharmacy can carry a matched code and still never have been validated as a venue. That is
   * exactly the gap the approver could not see — a pending pharmacy with no photo rendered as a bare
   * name, indistinguishable from a validated one whose photo simply was not kept (owner, 2026-09-22).
   */
  validationStatus: MarketingValidationStatus;
  /** validated_by_hr_id — the human validator, when a person (desk/link) adjudicated it; else null. */
  validatedByHrId: string | null;
  /** validated_at — the human decision moment. */
  validatedAt: string | null;
  /** evidence_photo_captured_at — the only honest "when" for the system-validated case. */
  evidenceCapturedAt: string | null;
};

export type MarketingDecisionOverlap = {
  requestCode: string;
  status: string;
  /** One human sentence naming the consequence — never raw ids. */
  description: string;
};

function cleanText(value: unknown) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed". Same guard
// service.ts uses, kept local so this module has no runtime dependency on it.
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchRowsByIds<T extends { id: string | number }>(
  supabase: SupabaseClient,
  table: string,
  ids: Array<string | number>,
) {
  if (ids.length === 0) return [];
  const rows: T[] = [];
  for (const batch of chunk(ids)) {
    const { data, error } = await supabase.from(table).select("*").in("id", batch);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

/**
 * Resolve request→pharmacy links into display rows.
 *
 * Best-effort by design: a decision screen must never fail to open because a reference lookup
 * missed. A link that cannot be resolved still returns a row carrying whatever is known, so the
 * approver sees "N pharmacies, one unresolved" rather than silently seeing N-1.
 */
export async function loadMarketingDecisionPharmacies(
  supabase: SupabaseClient,
  rows: Array<{ distributor_code_id: string | null; notes: string | null; pharmacy_id: string | null }>,
): Promise<MarketingDecisionPharmacy[]> {
  if (rows.length === 0) return [];

  const pharmacyIds = [...new Set(rows.map((row) => row.pharmacy_id).filter((id): id is string => Boolean(id)))];
  const codeIds = [...new Set(rows.map((row) => row.distributor_code_id).filter((id): id is string => Boolean(id)))];

  const [pharmacyRows, codeRows] = await Promise.all([
    fetchRowsByIds<{
      display_name: string | null;
      id: string;
      license_name_matches_sign: boolean | null;
      pharmacy_code: string | null;
      validation_status: string | null;
      validated_by_hr_id: string | null;
      validated_at: string | null;
    }>(
      supabase,
      "marketing_pharmacies",
      pharmacyIds,
    ).catch(() => []),
    fetchRowsByIds<{
      distributor_id: number | string | null;
      distributor_pharmacy_code: string | null;
      id: string;
      reference_status: string | null;
    }>(supabase, "marketing_pharmacy_distributor_codes", codeIds).catch(() => []),
  ]);

  const distributorIds = [...new Set(codeRows.map((row) => row.distributor_id).filter((id) => id !== null && id !== undefined))];
  const distributorRows = distributorIds.length > 0
    ? await fetchRowsByIds<{ display_name: string | null; id: number | string }>(
      supabase,
      "marketing_distributors",
      distributorIds as Array<string | number>,
    ).catch(() => [])
    : [];

  const pharmacyById = new Map(pharmacyRows.map((row) => [String(row.id), row]));
  const codeById = new Map(codeRows.map((row) => [String(row.id), row]));
  const distributorById = new Map(distributorRows.map((row) => [String(row.id), row]));

  // One index read + one batch signing call for every target pharmacy, rather than a pair per row.
  // Same never-break-the-screen rule as everything else here: a failure yields an empty map, and
  // each pharmacy then renders as having no retained image.
  const [evidenceByPharmacyId, licenseByPharmacyId] = await Promise.all([
    loadMarketingEvidencePhotosByEntityIds({
      entityIds: pharmacyIds,
      entityType: "pharmacy",
      supabase,
    }).catch(() => new Map<string, { capturedAt: string | null; signedUrl: string }>()),
    // Same posture again: a licence that will not resolve renders as "none attached" rather than
    // taking the screen down. Both reads are independent, so they go out together.
    loadMarketingPharmacyLicensesByPharmacyIds({
      pharmacyIds,
      supabase,
    }).catch(() => new Map<string, MarketingPharmacyLicenseFile>()),
  ]);

  return rows.map((row) => {
    const pharmacy = row.pharmacy_id ? pharmacyById.get(String(row.pharmacy_id)) : undefined;
    const code = row.distributor_code_id ? codeById.get(String(row.distributor_code_id)) : undefined;
    const distributor = code?.distributor_id !== null && code?.distributor_id !== undefined
      ? distributorById.get(String(code.distributor_id))
      : undefined;

    return {
      distributorName: cleanText(distributor?.display_name) ?? "Unknown distributor",
      distributorPharmacyCode: cleanText(code?.distributor_pharmacy_code) ?? "-",
      evidencePhotoUrl: row.pharmacy_id
        ? evidenceByPharmacyId.get(String(row.pharmacy_id))?.signedUrl ?? null
        : null,
      licenseContentType: row.pharmacy_id
        ? licenseByPharmacyId.get(String(row.pharmacy_id))?.contentType ?? null
        : null,
      // Off the pharmacy row, not off the licence file: the file proves a licence EXISTS, the
      // pharmacy row is where the human answer about it lives (and survives a resubmission, which
      // deletes and re-inserts every request/pharmacy link row).
      licenseNameMatchesSign: pharmacy?.license_name_matches_sign == null
        ? null
        : Boolean(pharmacy.license_name_matches_sign),
      licenseUrl: row.pharmacy_id
        ? licenseByPharmacyId.get(String(row.pharmacy_id))?.signedUrl ?? null
        : null,
      notes: cleanText(row.notes),
      pharmacyCode: cleanText(pharmacy?.pharmacy_code) ?? "-",
      pharmacyId: row.pharmacy_id ?? null,
      pharmacyName: cleanText(pharmacy?.display_name) ?? "Unresolved pharmacy",
      // A link with no distributor_code_id at all, or one whose code row could not be read, has NO
      // reference state — saying "pending" about it would be an invention.
      referenceLookup: code ? "resolved" : "lookup_failed",
      referenceStatus: cleanText(code?.reference_status) ?? "pending",
      // The pharmacy's own validation state. A row that could not be read defaults to "pending",
      // the honest floor: an unknown venue is treated as not-yet-validated, never as validated.
      validationStatus: (cleanText(pharmacy?.validation_status) as MarketingValidationStatus | null) ?? "pending",
      validatedByHrId: cleanText(pharmacy?.validated_by_hr_id),
      // Timestamps are read raw (no whitespace-collapsing) so the badge formatter parses them exactly.
      validatedAt: pharmacy?.validated_at ?? null,
      evidenceCapturedAt: row.pharmacy_id
        ? evidenceByPharmacyId.get(String(row.pharmacy_id))?.capturedAt ?? null
        : null,
    };
  });
}

/**
 * Load the pharmacy/product/window footprint of every other live request and return those that
 * would be credited the same invoice lines as `request`.
 *
 * Bounded deliberately: only requests whose window can possibly touch this one's are considered,
 * and inert statuses are dropped by findRequestOverlaps. Attribution matches on exact distributor
 * + pharmacy code + product + period with nothing exclusive about it, so without this check two
 * campaigns can each report the same sale as their own return.
 */
export async function loadMarketingRequestOverlaps(
  supabase: SupabaseClient,
  request: MarketingRequest,
): Promise<MarketingDecisionOverlap[]> {
  const subjectMonths = windowMonths(request.payDate, request.roiDurationMonths);
  if (subjectMonths.length === 0) return [];

  const [ownPharmacies, ownProducts] = await Promise.all([
    supabase.from("marketing_request_pharmacies").select("pharmacy_id").eq("request_id", request.id),
    supabase.from("marketing_request_products").select("product_id").eq("request_id", request.id),
  ]);
  if (ownPharmacies.error) throw ownPharmacies.error;
  if (ownProducts.error) throw ownProducts.error;

  const pharmacyIds = Array.from(
    new Set(((ownPharmacies.data ?? []) as Array<{ pharmacy_id: string }>).map((row) => String(row.pharmacy_id ?? "").trim()).filter(Boolean)),
  );
  const productIds = Array.from(
    new Set(((ownProducts.data ?? []) as Array<{ product_id: number | string }>).map((row) => Number(row.product_id))),
  ).filter((id) => Number.isFinite(id));
  if (pharmacyIds.length === 0 || productIds.length === 0) return [];

  // Only requests sharing at least one pharmacy can contest — that narrows the candidate set to a
  // handful before any window maths.
  const sharedPharmacyLinks = await supabase
    .from("marketing_request_pharmacies")
    .select("request_id, pharmacy_id")
    .in("pharmacy_id", pharmacyIds);
  if (sharedPharmacyLinks.error) throw sharedPharmacyLinks.error;

  const pharmaciesByRequest = new Map<string, string[]>();
  for (const row of (sharedPharmacyLinks.data ?? []) as Array<{ request_id: string; pharmacy_id: string }>) {
    if (row.request_id === request.id) continue;
    const list = pharmaciesByRequest.get(row.request_id) ?? [];
    list.push(row.pharmacy_id);
    pharmaciesByRequest.set(row.request_id, list);
  }
  const candidateIds = Array.from(pharmaciesByRequest.keys());
  if (candidateIds.length === 0) return [];

  const [candidateRows, candidateProducts] = await Promise.all([
    supabase.from("marketing_requests").select("id, request_code, status, pay_date, roi_duration_months").in("id", candidateIds),
    supabase.from("marketing_request_products").select("request_id, product_id").in("request_id", candidateIds),
  ]);
  if (candidateRows.error) throw candidateRows.error;
  if (candidateProducts.error) throw candidateProducts.error;

  const productsByRequest = new Map<string, number[]>();
  for (const row of (candidateProducts.data ?? []) as Array<{ request_id: string; product_id: number | string }>) {
    const list = productsByRequest.get(row.request_id) ?? [];
    list.push(Number(row.product_id));
    productsByRequest.set(row.request_id, list);
  }

  const others: OverlapCandidate[] = ((candidateRows.data ?? []) as Array<{
    id: string; request_code: string; status: string; pay_date: string | null; roi_duration_months: number | string;
  }>).map((row) => ({
    payDate: row.pay_date,
    pharmacyIds: pharmaciesByRequest.get(row.id) ?? [],
    productIds: productsByRequest.get(row.id) ?? [],
    requestCode: row.request_code,
    requestId: row.id,
    roiDurationMonths: Number(row.roi_duration_months) || 1,
    status: row.status,
  }));

  return findRequestOverlaps(
    {
      payDate: request.payDate,
      pharmacyIds,
      productIds,
      requestCode: request.requestCode,
      requestId: request.id,
      roiDurationMonths: request.roiDurationMonths,
      status: request.status,
    },
    others,
  ).map((overlap) => ({
    description: describeOverlap(overlap),
    requestCode: overlap.requestCode,
    status: overlap.status,
  }));
}

/**
 * Every live twin of `subject` — the same requester, customer, request type and cost, still in the
 * chain or approved (`twin-request.ts`). The customer + type filter narrows the read to a handful of
 * rows; the requester and cost are compared in `findMarketingRequestTwins`, so HR-id casing and a
 * numeric round-trip can never hide a twin.
 */
export async function loadMarketingRequestTwins(
  supabase: SupabaseClient,
  subject: TwinSubject,
): Promise<TwinCandidate[]> {
  const rows = await supabase
    .from("marketing_requests")
    .select("id, request_code, requester_hr_id, customer_id, request_type_id, estimated_cost, status, submitted_at, created_at")
    .eq("customer_id", subject.customerId)
    .eq("request_type_id", subject.requestTypeId)
    .in("status", [...MARKETING_REQUEST_TWIN_STATUSES]);
  if (rows.error) throw rows.error;

  const candidates: TwinCandidate[] = ((rows.data ?? []) as Array<{
    id: string; request_code: string | null; requester_hr_id: string | null; customer_id: string;
    request_type_id: number | string; estimated_cost: number | string | null; status: string;
    submitted_at: string | null; created_at: string | null;
  }>).map((row) => ({
    currentStepCode: null,
    customerId: row.customer_id,
    estimatedCost: Number(row.estimated_cost ?? 0),
    requestCode: row.request_code ?? row.id,
    requestId: row.id,
    requestTypeId: Number(row.request_type_id),
    requesterHrId: String(row.requester_hr_id ?? ""),
    status: row.status,
    submittedAt: row.submitted_at ?? row.created_at,
  }));
  const twins = findMarketingRequestTwins(subject, candidates);
  if (twins.length === 0) return twins;

  // The rung holding each twin, so one waiting at Finance reads "approved · with finance" rather than
  // "pending approval" (request-status-label.ts). A failed read keeps the bare status, never the twin.
  const steps = await supabase
    .from("marketing_request_approval_steps")
    .select("request_id, step_code")
    .in("request_id", twins.map((twin) => twin.requestId))
    .eq("status", "current");
  if (steps.error) return twins;
  const stepByRequest = new Map(
    ((steps.data ?? []) as Array<{ request_id: string; step_code: string | null }>).map((row) => [row.request_id, row.step_code] as const),
  );
  return twins.map((twin) => ({ ...twin, currentStepCode: stepByRequest.get(twin.requestId) ?? null }));
}

/** One earlier request against the same customer. */
export type MarketingCustomerSpendRow = {
  actualRoiStatus: string | null;
  actualSalesValue: number | null;
  estimatedCost: number;
  payDate: string | null;
  requestCode: string;
  requestId: string;
  status: string;
};

function toNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every EARLIER request against the same customer, with what each actually returned.
 *
 * `excludeStatuses` is required rather than optional on purpose. The equivalent read on the
 * approver screen applies NO status filter, so a customer's "spent before" figure there counts
 * abandoned drafts and refused requests as money out of the door — the exclusion set belongs to
 * the caller's question, and every caller has to state it.
 *
 * Throws on a read failure. The caller decides how to say "we could not read this"; silently
 * returning an empty list here would make an unreadable history indistinguishable from a customer
 * nobody has ever spent on.
 */
export async function loadMarketingCustomerSpendHistory(
  supabase: SupabaseClient,
  params: {
    customerId: string | null;
    excludeRequestId: string;
    excludeStatuses: ReadonlySet<string>;
  },
): Promise<MarketingCustomerSpendRow[]> {
  if (!params.customerId) return [];

  const requestsResult = await supabase
    .from("marketing_requests")
    .select("id, request_code, status, estimated_cost, pay_date")
    .eq("customer_id", params.customerId)
    .neq("id", params.excludeRequestId)
    .order("pay_date", { ascending: false });
  if (requestsResult.error) throw requestsResult.error;

  const rows = ((requestsResult.data ?? []) as Array<{
    estimated_cost?: number | string | null;
    id: string;
    pay_date?: string | null;
    request_code?: string | null;
    status?: string | null;
  }>).filter((row) => !params.excludeStatuses.has(String(row.status ?? "").trim().toLowerCase()));
  if (rows.length === 0) return [];

  // Realised sales per earlier request, where ROI has actually been calculated. A failure here is
  // not fatal to the spend total, so it degrades to "never measured" per request rather than
  // failing the whole read — that distinction is carried by `actualSalesValue: null`.
  const factByRequestId = new Map<string, { salesValue: number | null; status: string | null }>();
  for (const batch of chunk(rows.map((row) => row.id))) {
    const factsResult = await supabase
      .from("marketing_roi_request_facts")
      .select("request_id, actual_sales_value, actual_roi_status")
      .in("request_id", batch);
    if (factsResult.error) continue;
    for (const fact of (factsResult.data ?? []) as Array<{
      actual_roi_status?: string | null;
      actual_sales_value?: number | string | null;
      request_id: string;
    }>) {
      factByRequestId.set(fact.request_id, {
        salesValue: toNullableNumber(fact.actual_sales_value),
        status: fact.actual_roi_status ?? null,
      });
    }
  }

  return rows.map((row) => {
    const fact = factByRequestId.get(row.id);
    return {
      actualRoiStatus: fact?.status ?? null,
      actualSalesValue: fact?.salesValue ?? null,
      estimatedCost: toNullableNumber(row.estimated_cost) ?? 0,
      payDate: row.pay_date ?? null,
      requestCode: row.request_code ?? row.id,
      requestId: row.id,
      status: row.status ?? "unknown",
    };
  });
}
