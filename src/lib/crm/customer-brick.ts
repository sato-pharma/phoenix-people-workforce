/**
 * CRM customer/contact -> Phoenix brick resolution — the "Customer Mapping" admin tab's punch-list
 * + resolver. One level finer than region mapping (crm/region-brick.ts): a CRM REGION groups many
 * customers into one rough locality (e.g. "Dokki"); a CRM CUSTOMER (the visited contact — a doctor,
 * pharmacy or hospital, keyed on iReports360's own contactID) is the single most precise thing
 * Phoenix can resolve to a brick. Mirrors the Region Mapping pattern exactly (itself mirroring the
 * Unmapped Agents pattern in identity.ts/admin.ts), keyed on contact_crm_id instead of
 * crm_region_id, and validated through the SAME current-bricks index region mapping uses
 * (getCurrentBrickIndex) so a superseded pre-rebuild brick can never be accepted here either.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE, CRM_VISITS_TABLE } from "@/lib/crm/tables";
import { getCurrentBrickIndex } from "@/lib/crm/region-brick";

const visitsTable = CRM_VISITS_TABLE;
const resolutionsTable = CRM_CUSTOMER_BRICK_RESOLUTIONS_TABLE;

/** Admin resolution for a CRM customer that never auto-maps: mapped (a real brick_id was
 * assigned), ignored (an admin decided this contact isn't worth mapping — e.g. a CRM-side
 * duplicate/artifact — hide it without ever assigning a brick), or pending (default, keeps showing
 * on the punch-list). */
export type CrmCustomerResolutionAction = "ignored" | "mapped" | "pending";

/** One row on the Customer Mapping punch-list: a CRM contact with no "mapped" resolution yet. */
export type UnmappedCrmCustomerRow = {
  crmContactId: number;
  crmContactName: string;
  firstSeen: string;
  lastSeen: string;
  visitCount: number;
};

export type CrmCustomerBrickResolutionResult = {
  areaId: string | null;
  brickId: string | null;
  regionId: string | null;
};

type MutableUnmappedCustomer = UnmappedCrmCustomerRow;
type StoredResolution = { brickId: string | null; status: string };

/** Every stored resolution decision, keyed by contact_crm_id. Returns an empty map (never throws)
 * before the migration ships, matching the identity/region-resolutions read pattern. */
async function loadResolutionsByContactId(): Promise<Map<number, StoredResolution>> {
  const supabase = getSupabaseAdmin();
  const map = new Map<number, StoredResolution>();
  // PAGINATED, and ordered so the paging is exact. This table holds one row per resolved CRM
  // contact and production has ~12.7k distinct contacts, so an unpaginated read would silently
  // stop at PostgREST's 1,000-row cap once the admin passes ~1,000 decisions: already-mapped
  // customers would reappear on the unmapped punch-list and re-export as status "pending", so an
  // admin editing and re-uploading that template would see their own work counted as "skipped"
  // and conclude it had been lost. Which 1,000 survived would be non-deterministic.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(resolutionsTable)
      .select("crm_contact_id, brick_id, status")
      .order("crm_contact_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isCrmSchemaMissingError(error)) return new Map();
      throw new Error(error.message);
    }
    const rows = (data ?? []) as Array<{ brick_id: string | null; crm_contact_id: number; status: string }>;
    for (const row of rows) {
      map.set(row.crm_contact_id, { brickId: row.brick_id, status: row.status });
    }
    if (rows.length < PAGE) break;
  }
  return map;
}

/** Full keyset scan (id > cursor) of every distinct contact_crm_id in ireports360_visits, with its
 * display name, visit count, and first/last-seen dates. contact_crm_id = 0 is the vendor's
 * "unspecified contact" sentinel (same convention as computeTriplesInRange in crm/master.ts) and is
 * excluded — it names no real customer, so there is nothing to map. The single scan both
 * getUnmappedCrmCustomers and getAllCrmCustomersForTemplate build on, so the two can never disagree
 * about what customers exist. */
async function scanAllCrmCustomers(): Promise<Map<number, MutableUnmappedCustomer>> {
  const supabase = getSupabaseAdmin();
  const customers = new Map<number, MutableUnmappedCustomer>();
  const pageSize = 1000;
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from(visitsTable)
      .select("id, contact_crm_id, contact_name, visit_date")
      .not("contact_crm_id", "is", null)
      .neq("contact_crm_id", 0)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) {
      if (isCrmSchemaMissingError(error)) return customers;
      throw new Error(error.message);
    }
    const page = (data ?? []) as Array<{ contact_crm_id: number; contact_name: string | null; id: string; visit_date: string }>;
    for (const row of page) {
      const existing = customers.get(row.contact_crm_id);
      if (!existing) {
        customers.set(row.contact_crm_id, {
          crmContactId: row.contact_crm_id,
          crmContactName: row.contact_name ?? "(no name on visit)",
          firstSeen: row.visit_date,
          lastSeen: row.visit_date,
          visitCount: 1,
        });
      } else {
        existing.visitCount += 1;
        if (row.visit_date < existing.firstSeen) existing.firstSeen = row.visit_date;
        if (row.visit_date > existing.lastSeen) existing.lastSeen = row.visit_date;
      }
    }
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return customers;
}

/**
 * Every distinct contact_crm_id that does not yet have a "mapped" resolution — a punch-list for an
 * admin to assign a real Phoenix brick to, ranked by visit volume (highest first) so the busiest
 * customers get attention first. Not date-scoped on purpose, same reasoning as
 * getUnmappedCrmRegions/getUnmappedCrmIdentities: the goal is every customer that still needs a
 * decision, not just ones active in a chosen window.
 */
export async function getUnmappedCrmCustomers(): Promise<UnmappedCrmCustomerRow[]> {
  const [customers, resolutions] = await Promise.all([scanAllCrmCustomers(), loadResolutionsByContactId()]);
  return Array.from(customers.values())
    .filter((customer) => {
      const status = resolutions.get(customer.crmContactId)?.status;
      return status !== "mapped" && status !== "ignored";
    })
    .sort((a, b) => b.visitCount - a.visitCount);
}

/** One row of the full download template: every CRM customer ever seen, with its current
 * resolution (if any) — used by the Customer Mapping tab's "Download Template" export so an admin
 * can bulk-edit/correct every customer (not just unmapped ones) in one spreadsheet. */
export type CrmCustomerTemplateRow = {
  brickId: string | null;
  crmContactId: number;
  crmContactName: string;
  status: string;
  visitCount: number;
};

/** Every distinct CRM customer ever seen, each annotated with its current resolution status/brick_id
 * (or "pending"/null when never resolved) — the full punch-list for the downloadable template,
 * unlike getUnmappedCrmCustomers which only lists the ones still needing a decision. Sorted by
 * visit volume (highest first), same ranking rationale. */
export async function getAllCrmCustomersForTemplate(): Promise<CrmCustomerTemplateRow[]> {
  const [customers, resolutions] = await Promise.all([scanAllCrmCustomers(), loadResolutionsByContactId()]);
  return Array.from(customers.values())
    .map((customer) => {
      const resolution = resolutions.get(customer.crmContactId);
      return {
        brickId: resolution?.brickId ?? null,
        crmContactId: customer.crmContactId,
        crmContactName: customer.crmContactName,
        status: resolution?.status ?? "pending",
        visitCount: customer.visitCount,
      };
    })
    .sort((a, b) => b.visitCount - a.visitCount);
}

/**
 * Records an admin's decision for one CRM customer:
 * - "ignored": stores the decision only — the customer drops out of getUnmappedCrmCustomers, on
 *   purpose no visit rows are touched.
 * - "mapped": validates brickId against the CURRENT brick index (getCurrentBrickIndex — active AND
 *   not superseded by the geography rebuild), upserts the resolution, and returns the brick's
 *   resolved area_code/region_code so the caller can show immediate feedback.
 * - "pending": explicitly resets to the default, no-decision state.
 */
export async function setCrmCustomerBrickResolution(input: {
  action: CrmCustomerResolutionAction;
  brickId?: string | null;
  crmContactId: number;
  crmContactName?: string | null;
  resolvedByHrId: string | null;
}): Promise<CrmCustomerBrickResolutionResult> {
  const supabase = getSupabaseAdmin();

  let resolvedBrickId: string | null = null;
  let resolvedAreaId: string | null = null;
  let resolvedRegionId: string | null = null;
  if (input.action === "mapped") {
    const typed = input.brickId?.trim();
    if (!typed) throw new Error("A brick ID is required to map this customer.");
    const { allKnown, current } = await getCurrentBrickIndex();
    const brick = current.get(typed);
    if (!brick) {
      const reason = allKnown.has(typed)
        ? "it exists but is inactive, or has been superseded by the geography rebuild"
        : "no brick exists with that ID";
      throw new Error(`Brick "${typed}" cannot be used — ${reason}.`);
    }
    resolvedBrickId = typed;
    resolvedAreaId = brick.areaCode;
    resolvedRegionId = brick.regionCode;
  }

  const { error: upsertError } = await supabase.from(resolutionsTable).upsert(
    {
      brick_id: resolvedBrickId,
      crm_contact_id: input.crmContactId,
      crm_contact_name: input.crmContactName ?? null,
      resolved_at: new Date().toISOString(),
      resolved_by_hr_id: input.resolvedByHrId,
      status: input.action,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "crm_contact_id" },
  );
  if (upsertError) throw new Error(upsertError.message);

  return { areaId: resolvedAreaId, brickId: resolvedBrickId, regionId: resolvedRegionId };
}

/** One parsed row from an uploaded customer-mapping spreadsheet, before validation. Column-parsing
 * (locating headers, reading cell text) lives in the API route; this service only deals in plain
 * values so it stays testable without ExcelJS/File in scope. */
export type CrmCustomerBulkImportInputRow = {
  brickId: string;
  crmContactId: number;
  crmContactName: string;
  row: number;
  statusText: string;
};

export type CrmCustomerBulkImportBlockedRow = { crmContactId: number; reason: string; row: number };

export type CrmCustomerBulkImportResult = {
  blockedRows: CrmCustomerBulkImportBlockedRow[];
  ignored: number;
  mapped: number;
  skipped: number;
  totalRead: number;
};

const BULK_IMPORT_CHUNK = 500;

/** True for status text that means "mark this customer ignored" (case/whitespace-insensitive). */
function isIgnoredStatusText(statusText: string): boolean {
  const normalized = statusText.trim().toLowerCase();
  return normalized === "ignore" || normalized === "ignored";
}

/**
 * Bulk-applies a whole parsed spreadsheet of CRM-customer -> brick decisions in one call — the
 * "Upload Mapping" counterpart to the Customer Mapping tab's one-row-at-a-time resolver. Each row:
 *   - Brick ID present -> validated against the CURRENT brick index (one batch fetch, not one query
 *     per row); unknown/inactive/superseded brick ids are rejected into blockedRows rather than
 *     silently skipped, so a typo (or a stale sheet built from an old master) is visible in the
 *     summary instead of quietly doing nothing.
 *   - Brick ID blank + Status says ignore/ignored -> resolved as "ignored".
 *   - Brick ID blank + no ignore status -> skipped (no change) — a blank row never resets an
 *     existing decision back to pending; use the single-row "Keep Pending" action for that.
 */
export async function bulkImportCrmCustomerBrickMappings(input: {
  resolvedByHrId: string | null;
  rows: CrmCustomerBulkImportInputRow[];
}): Promise<CrmCustomerBulkImportResult> {
  const supabase = getSupabaseAdmin();
  const { allKnown, current } = await getCurrentBrickIndex();

  const blockedRows: CrmCustomerBulkImportBlockedRow[] = [];
  const upserts: Record<string, unknown>[] = [];
  let skipped = 0;
  let ignored = 0;
  const stamp = new Date().toISOString();

  for (const row of input.rows) {
    const brickId = row.brickId.trim();
    if (!brickId) {
      if (isIgnoredStatusText(row.statusText)) {
        ignored += 1;
        upserts.push({
          brick_id: null,
          crm_contact_id: row.crmContactId,
          crm_contact_name: row.crmContactName || null,
          resolved_at: stamp,
          resolved_by_hr_id: input.resolvedByHrId,
          status: "ignored",
          updated_at: stamp,
        });
      } else {
        skipped += 1;
      }
      continue;
    }
    if (!allKnown.has(brickId)) {
      blockedRows.push({ crmContactId: row.crmContactId, reason: `Brick ID "${brickId}" does not exist in the brick master.`, row: row.row });
      continue;
    }
    if (!current.has(brickId)) {
      blockedRows.push({ crmContactId: row.crmContactId, reason: `Brick ID "${brickId}" is inactive, or has been superseded by the geography rebuild.`, row: row.row });
      continue;
    }
    upserts.push({
      brick_id: brickId,
      crm_contact_id: row.crmContactId,
      crm_contact_name: row.crmContactName || null,
      resolved_at: stamp,
      resolved_by_hr_id: input.resolvedByHrId,
      status: "mapped",
      updated_at: stamp,
    });
  }

  let mapped = 0;
  for (let index = 0; index < upserts.length; index += BULK_IMPORT_CHUNK) {
    const chunk = upserts.slice(index, index + BULK_IMPORT_CHUNK);
    const { error } = await supabase.from(resolutionsTable).upsert(chunk, { onConflict: "crm_contact_id" });
    if (error) throw new Error(error.message);
    mapped += chunk.filter((c) => c.status === "mapped").length;
  }

  return { blockedRows, ignored, mapped, skipped, totalRead: input.rows.length };
}
