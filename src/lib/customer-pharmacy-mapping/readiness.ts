// Customer Pharmacy Mapping — standalone master-data readiness module.
//
// This module is deliberately independent from `src/lib/marketing-requests`. It reads the
// customer / pharmacy / distributor master tables directly and computes a READ-ONLY readiness
// view of every customer's pharmacy links. It performs no writes, no manual matching, no merge
// logic, and no bulk validation.
//
// Design rule: this view is CUSTOMER-FIRST (it starts from the customer list and left-joins
// links) so that customers with zero pharmacy links are included. It never relies on the
// 200-row-capped Customer Validation workspace loader.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ── Public value types ────────────────────────────────────────────────────────

export type CustomerPharmacyValidationStatus =
  | "pending"
  | "system_validated"
  | "sfe_validated"
  | "rejected";

export type CustomerPharmacyCustomerType =
  | "doctor"
  | "hospital"
  | "clinic"
  | "account"
  | "other";

export type CustomerPharmacyReadinessBucket = "ready" | "pending_only" | "no_links";

export type CustomerPharmacyLinkSummary = {
  linkId: string;
  pharmacyId: string;
  pharmacyCode: string | null;
  pharmacyName: string;
  distributorCodeId: string;
  distributorId: number | null;
  distributorName: string;
  distributorPharmacyCode: string | null;
  validationStatus: CustomerPharmacyValidationStatus;
  validationNotes: string | null;
  inferredFromHistory: boolean;
};

export type CustomerPharmacyReadinessRow = {
  customerId: string;
  customerCode: string | null;
  customerName: string;
  customerType: CustomerPharmacyCustomerType | null;
  areaName: string | null;
  governorateName: string | null;
  bucket: CustomerPharmacyReadinessBucket;
  totalLinkCount: number;
  validatedLinkCount: number;
  pendingLinkCount: number;
  rejectedLinkCount: number;
  inferredLinkCount: number;
  links: CustomerPharmacyLinkSummary[];
};

export type CustomerPharmacyReadinessSummary = {
  ready: number;
  pendingOnly: number;
  noLinks: number;
  total: number;
  inferredCustomers: number;
};

export type CustomerPharmacyReadiness = {
  rows: CustomerPharmacyReadinessRow[];
  summary: CustomerPharmacyReadinessSummary;
};

// ── Pure-builder input types (the unit-tested seam — no IO) ─────────────────────

export type ReadinessCustomerInput = {
  id: string;
  customerCode: string | null;
  customerName: string;
  customerType: CustomerPharmacyCustomerType | null;
  areaName: string | null;
  governorateName: string | null;
};

export type ReadinessLinkInput = {
  linkId: string;
  customerId: string;
  pharmacyId: string;
  distributorCodeId: string;
  validationStatus: CustomerPharmacyValidationStatus;
  validationNotes: string | null;
};

export type ReadinessPharmacyInput = {
  id: string;
  pharmacyCode: string | null;
  pharmacyName: string;
};

export type ReadinessDistributorCodeInput = {
  id: string;
  distributorId: number | null;
  distributorPharmacyCode: string | null;
};

export type ReadinessDistributorInput = {
  id: number;
  name: string;
};

export type BuildCustomerPharmacyReadinessInput = {
  customers: ReadinessCustomerInput[];
  links: ReadinessLinkInput[];
  pharmacies: ReadinessPharmacyInput[];
  distributorCodes: ReadinessDistributorCodeInput[];
  distributors: ReadinessDistributorInput[];
};

// ── Shared constants / helpers ──────────────────────────────────────────────────

/**
 * The backfill that seeded historical customer↔pharmacy links wrote this stable marker into
 * `validation_notes` (there is no dedicated `source`/`link_source` column). Both backfill note
 * variants contain this substring, so it is a reliable read-only signal that a link was inferred
 * from historical marketing requests rather than GPS field-validated. Replacing this heuristic
 * with a real column is postponed (would require a migration).
 */
export const INFERRED_HISTORY_MARKER = "not GPS field-validated";

const VALIDATED_STATUSES: ReadonlySet<CustomerPharmacyValidationStatus> = new Set([
  "system_validated",
  "sfe_validated",
]);

export function isInferredFromHistory(validationNotes: string | null | undefined): boolean {
  return (validationNotes ?? "").includes(INFERRED_HISTORY_MARKER);
}

/**
 * A DESK validation writes this into `validation_notes`: an admin validated on someone's behalf and
 * picked the location from a map search instead of a rep capturing it on site. Same absence of field
 * evidence as the backfill marker above, different origin — and NOT caught by it, because the
 * wording differs ("no field GPS or live photo" vs "not GPS field-validated").
 *
 * Production 2026-08-23: 11 links across 6 customers carry it, which is EVERY `sfe_validated` link
 * there is. Five of those customers hold a coordinate and no photo, so they read as field-proven
 * while the coordinate came off a map at a desk, not off a phone in the street.
 */
export const DESK_VALIDATION_MARKER = "no field GPS or live photo";

export function isDeskValidated(validationNotes: string | null | undefined): boolean {
  return (validationNotes ?? "").includes(DESK_VALIDATION_MARKER);
}

/**
 * The union the badges care about: this link carries NO field evidence, whatever put it there.
 *
 * Kept separate from `isInferredFromHistory`, which still means the 2026-07-02 backfill and nothing
 * else — the Customer Pharmacy Mapping page's "Inferred" filter and badge are about ORIGIN, and
 * widening them would silently relabel 11 desk links as backfill rows.
 */
export function isNotFieldValidated(validationNotes: string | null | undefined): boolean {
  return isInferredFromHistory(validationNotes) || isDeskValidated(validationNotes);
}

function isValidatedStatus(status: CustomerPharmacyValidationStatus): boolean {
  return VALIDATED_STATUSES.has(status);
}

// ── Pure builder ────────────────────────────────────────────────────────────────

/**
 * Pure, IO-free computation of the readiness view. Groups links per customer, resolves display
 * names via the lookup collections, computes per-customer counts + readiness bucket, and returns
 * customers sorted by name. This is the seam covered by the unit tests.
 *
 * Readiness buckets (over a customer's provided links):
 *   - "ready"        → at least one link with validationStatus in (system_validated, sfe_validated)
 *   - "pending_only" → has ≥1 link but none validated (includes rejected-only)
 *   - "no_links"     → zero links
 */
export function buildCustomerPharmacyReadiness(
  input: BuildCustomerPharmacyReadinessInput,
): CustomerPharmacyReadiness {
  const pharmacyById = new Map(input.pharmacies.map((row) => [row.id, row]));
  const distributorCodeById = new Map(input.distributorCodes.map((row) => [row.id, row]));
  const distributorNameById = new Map(input.distributors.map((row) => [row.id, row.name]));

  const linksByCustomer = new Map<string, ReadinessLinkInput[]>();
  for (const link of input.links) {
    const existing = linksByCustomer.get(link.customerId);
    if (existing) {
      existing.push(link);
    } else {
      linksByCustomer.set(link.customerId, [link]);
    }
  }

  const rows: CustomerPharmacyReadinessRow[] = input.customers.map((customer) => {
    const customerLinks = linksByCustomer.get(customer.id) ?? [];

    const links: CustomerPharmacyLinkSummary[] = customerLinks.map((link) => {
      const pharmacy = pharmacyById.get(link.pharmacyId);
      const distributorCode = distributorCodeById.get(link.distributorCodeId);
      const distributorId = distributorCode?.distributorId ?? null;
      const distributorName =
        distributorId != null ? distributorNameById.get(distributorId) ?? "Unknown distributor" : "Unknown distributor";

      return {
        linkId: link.linkId,
        pharmacyId: link.pharmacyId,
        pharmacyCode: pharmacy?.pharmacyCode ?? null,
        pharmacyName: pharmacy?.pharmacyName ?? "Unknown pharmacy",
        distributorCodeId: link.distributorCodeId,
        distributorId,
        distributorName,
        distributorPharmacyCode: distributorCode?.distributorPharmacyCode ?? null,
        validationStatus: link.validationStatus,
        validationNotes: link.validationNotes,
        inferredFromHistory: isInferredFromHistory(link.validationNotes),
      };
    });

    let validatedLinkCount = 0;
    let pendingLinkCount = 0;
    let rejectedLinkCount = 0;
    let inferredLinkCount = 0;
    for (const link of links) {
      if (isValidatedStatus(link.validationStatus)) {
        validatedLinkCount += 1;
      } else if (link.validationStatus === "rejected") {
        rejectedLinkCount += 1;
      } else {
        pendingLinkCount += 1;
      }
      if (link.inferredFromHistory) inferredLinkCount += 1;
    }

    const totalLinkCount = links.length;
    const bucket: CustomerPharmacyReadinessBucket =
      totalLinkCount === 0 ? "no_links" : validatedLinkCount > 0 ? "ready" : "pending_only";

    return {
      customerId: customer.id,
      customerCode: customer.customerCode,
      customerName: customer.customerName,
      customerType: customer.customerType,
      areaName: customer.areaName,
      governorateName: customer.governorateName,
      bucket,
      totalLinkCount,
      validatedLinkCount,
      pendingLinkCount,
      rejectedLinkCount,
      inferredLinkCount,
      links,
    };
  });

  rows.sort((a, b) => a.customerName.localeCompare(b.customerName));

  const summary: CustomerPharmacyReadinessSummary = {
    ready: rows.filter((row) => row.bucket === "ready").length,
    pendingOnly: rows.filter((row) => row.bucket === "pending_only").length,
    noLinks: rows.filter((row) => row.bucket === "no_links").length,
    total: rows.length,
    inferredCustomers: rows.filter((row) => row.inferredLinkCount > 0).length,
  };

  return { rows, summary };
}

// ── Access control (standalone, Phase 1: company-wide admin roles only) ─────────

/**
 * Phase 1 is restricted to roles that are unambiguously company/system-wide, so the customer-first
 * read can return every customer without per-row hierarchy scoping. Line/hierarchy-scoped roles
 * (SFE Manager, PM, GPM, NSM, Regional/District Managers) are intentionally deferred to a later
 * phase that ports proper row-level scoping.
 */
const CUSTOMER_PHARMACY_MAPPING_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
]);

export function canAccessCustomerPharmacyMapping(access: AccessContext): boolean {
  return (
    access.source === "system" ||
    access.scope === "system" ||
    CUSTOMER_PHARMACY_MAPPING_ROLES.has(access.role)
  );
}

export function assertCustomerPharmacyMappingAccess(access: AccessContext): void {
  if (!canAccessCustomerPharmacyMapping(access)) {
    throw new Error(`Forbidden: ${access.role} cannot access Customer Pharmacy Mapping.`);
  }
}

// ── Raw DB row shapes (only the columns this module reads) ───────────────────────

type MarketingCustomerRow = {
  id: string;
  customer_code: string | null;
  customer_type: CustomerPharmacyCustomerType | null;
  display_name: string | null;
  extracted_area_name: string | null;
  extracted_governorate_name: string | null;
};

type MarketingCustomerPharmacyRow = {
  id: string;
  customer_id: string;
  pharmacy_id: string;
  distributor_code_id: string;
  validation_status: CustomerPharmacyValidationStatus | null;
  validation_notes: string | null;
};

type MarketingPharmacyRow = {
  id: string;
  pharmacy_code: string | null;
  display_name: string | null;
};

type MarketingPharmacyDistributorCodeRow = {
  id: string;
  distributor_id: number | string | null;
  distributor_pharmacy_code: string | null;
};

type MarketingDistributorRow = {
  id: number | string;
  display_name: string | null;
};

const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 500;

/**
 * Range-paginated full read of an active-filtered table. PostgREST caps a single response at
 * ~1000 rows, so we page with `.range()` until a short page is returned. Ordered by `id` for a
 * stable pagination cursor.
 */
async function fetchAllActiveRows<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("active", true)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function fetchRowsByIds<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  ids: Array<string | number>,
): Promise<T[]> {
  const unique = Array.from(new Set(ids));
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
    const slice = unique.slice(i, i + IN_CHUNK_SIZE);
    const { data, error } = await supabase.from(table).select(columns).in("id", slice);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

function toNumericId(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

// ── Exported IO entry point ──────────────────────────────────────────────────────

/**
 * Loads and computes the full read-only readiness view for the caller. Customer-first: reads all
 * active customers (paginated), then all active links (paginated), then resolves the referenced
 * pharmacies / distributor codes / distributors by id. Delegates the shaping to the pure builder.
 */
export async function getCustomerPharmacyReadiness(
  access: AccessContext,
): Promise<CustomerPharmacyReadiness> {
  assertCustomerPharmacyMappingAccess(access);

  const supabase = getSupabaseAdmin();

  const [customerRows, linkRows] = await Promise.all([
    fetchAllActiveRows<MarketingCustomerRow>(
      supabase,
      "marketing_customers",
      "id, customer_code, customer_type, display_name, extracted_area_name, extracted_governorate_name",
    ),
    fetchAllActiveRows<MarketingCustomerPharmacyRow>(
      supabase,
      "marketing_customer_pharmacies",
      "id, customer_id, pharmacy_id, distributor_code_id, validation_status, validation_notes",
    ),
  ]);

  // Only keep links that belong to a customer we can see (Phase 1 = all active customers).
  const customerIds = new Set(customerRows.map((row) => row.id));
  const visibleLinks = linkRows.filter((row) => customerIds.has(row.customer_id));

  const pharmacyIds = visibleLinks.map((row) => row.pharmacy_id);
  const distributorCodeIds = visibleLinks.map((row) => row.distributor_code_id);

  const [pharmacyRows, distributorCodeRows] = await Promise.all([
    fetchRowsByIds<MarketingPharmacyRow>(supabase, "marketing_pharmacies", "id, pharmacy_code, display_name", pharmacyIds),
    fetchRowsByIds<MarketingPharmacyDistributorCodeRow>(
      supabase,
      "marketing_pharmacy_distributor_codes",
      "id, distributor_id, distributor_pharmacy_code",
      distributorCodeIds,
    ),
  ]);

  const distributorIds = distributorCodeRows
    .map((row) => toNumericId(row.distributor_id))
    .filter((id): id is number => id != null);
  const distributorRows = await fetchRowsByIds<MarketingDistributorRow>(
    supabase,
    "marketing_distributors",
    "id, display_name",
    distributorIds,
  );

  return buildCustomerPharmacyReadiness({
    customers: customerRows.map((row) => ({
      id: row.id,
      customerCode: row.customer_code,
      customerName: row.display_name ?? "Unnamed customer",
      customerType: row.customer_type,
      areaName: row.extracted_area_name,
      governorateName: row.extracted_governorate_name,
    })),
    links: visibleLinks.map((row) => ({
      linkId: row.id,
      customerId: row.customer_id,
      pharmacyId: row.pharmacy_id,
      distributorCodeId: row.distributor_code_id,
      validationStatus: row.validation_status ?? "pending",
      validationNotes: row.validation_notes,
    })),
    pharmacies: pharmacyRows.map((row) => ({
      id: row.id,
      pharmacyCode: row.pharmacy_code,
      pharmacyName: row.display_name ?? "Unnamed pharmacy",
    })),
    distributorCodes: distributorCodeRows.map((row) => ({
      id: row.id,
      distributorId: toNumericId(row.distributor_id),
      distributorPharmacyCode: row.distributor_pharmacy_code,
    })),
    distributors: distributorRows
      .map((row) => ({ id: toNumericId(row.id), name: row.display_name ?? "Unknown distributor" }))
      .filter((row): row is ReadinessDistributorInput => row.id != null),
  });
}
