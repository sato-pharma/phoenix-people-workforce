import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { LINK_STATUS_PRECEDENCE } from "@/lib/marketing-requests/code-link-reach";
import { MARKETING_EVIDENCE_BUCKET } from "@/lib/marketing-requests/evidence-photo-storage";
import { applyPhotoPinTerritory } from "@/lib/marketing-requests/photo-pin-territory";
import {
  readPinTerritory,
  resolveDirectOrderGeography,
  resolveTransferredVenueOwnerHrId,
  suggestBrickForCapture,
} from "@/lib/marketing-requests/validated-customer-transfer";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeVenueType, venueRequiresDistributorCode, type VenueType } from "@/lib/venues/venue-type";
import { isCertainWholesalerVenue } from "@/lib/venues/wholesaler-venue-guard";

// ─────────────────────────────────────────────────────────────────────────────
// A customer validated for marketing is validated in Direct Orders too (owner, 2026-10-21:
// "every one validates a customer for marketing requests is automatic validated in his direct
// orders and is appearing in his venues validated").
//
// Until this, the two modules shared no key. A rep who stood in front of a pharmacy with GPS and a
// live photo for a marketing request had to stand there again for a direct order, unless a Super
// Admin opened the Validated Customers register and pressed Transfer — which had happened for 4 of
// 93 validated customers, and only ever for each customer's FIRST pharmacy.
//
// THE UNIT IS THE PHARMACY, NOT THE CUSTOMER. A Direct Order venue is a shop; a marketing customer is
// usually a doctor linked to one or more shops. Each validated link carries its pharmacy across, and
// `marketing_pharmacy_direct_order_venues` records which Direct Order venue that pharmacy IS — one
// row per marketing pharmacy, so a shop two reps validated doctors at is still ONE venue.
//
// WHAT COUNTS AS VALIDATED, and why nothing weaker does:
//   • the customer is `system_validated` or `sfe_validated` — the evidence gate or the desk cleared
//     it (a 2026-07-02 backfilled ROI customer is still `pending`, so its seeded links never cross);
//   • the link is in `LINK_STATUS_PRECEDENCE` — the SAME set the marketing request picker uses;
//   • the PHARMACY has its own GPS and its own live photo — the venue rule (GPS + a live picture,
//     always). A doctor's photo is not a photo of the shop, so it is never borrowed;
//   • it is not a certain wholesaler / makhzan (owner, 2026-09-22: never a venue, either module).
//
// WHAT IT WRITES — exactly what the desk's own decision would have written, minus the wait:
//   • a code the master database knows and a Direct Order venue already holds → that venue is
//     REUSED (all ten such venues in production were verified and trusted when this shipped). A
//     venue still pending or rejected is LEFT ALONE: pending is the desk's open question and
//     rejected is a person's ruling that the shop is false — a machine settles neither;
//   • otherwise a NEW venue, `verified`, filed at the photo's own pin (owner, 2026-10-18: the photo
//     is the primary source of trust, over a distributor code too), owned by the rep who captured
//     the customer so it lands in HIS "My venues". Trusted outright when its code is in the master
//     (the desk's "match"), provisional on 90-day probation otherwise (the desk's "approve new");
//   • a decided `approved_new` field claim carrying the marketing photo BY REFERENCE, so every
//     approver of every order on the venue opens the very image the rep took.
//
// NEVER THROWS INTO THE CALLER. It runs after a marketing validation has already been saved; a
// failure here must never cost the rep that save. Each venue that could not cross is returned with
// the reason, and the next validation, "My venues" load or backfill run tries it again — every step
// is idempotent on the link table.
// ─────────────────────────────────────────────────────────────────────────────

export const MARKETING_VALIDATED_CUSTOMER_STATUSES = ["system_validated", "sfe_validated"] as const;

/** Why a marketing pharmacy did not (yet) cross into Direct Orders, in words for the log and the report. */
export type MarketingVenueSkipReason =
  | "pharmacy_inactive"
  | "pharmacy_merged"
  | "no_venue_photo"
  | "no_venue_gps"
  | "wholesaler"
  | "no_distributor_code"
  | "direct_order_venue_retired"
  | "direct_order_venue_pending_review"
  | "direct_order_venue_rejected"
  | "brick_map_unavailable"
  | "read_failed"
  | "write_failed";

export const MARKETING_VENUE_SKIP_TEXT: Readonly<Record<MarketingVenueSkipReason, string>> = {
  pharmacy_inactive: "The marketing pharmacy is no longer active.",
  pharmacy_merged: "The marketing pharmacy was merged into another record.",
  no_venue_photo: "The pharmacy has no live photo of its own on file.",
  no_venue_gps: "The pharmacy has no GPS location of its own on file.",
  wholesaler: "The venue is a wholesaler / makhzan, which is never a direct-order venue.",
  no_distributor_code:
    "The venue has no distributor code, so it is not a Marketing venue to carry across — a nursery or any codeless venue is validated in Direct Orders directly.",
  direct_order_venue_retired: "Its Direct Order venue was retired, so it is not brought back automatically.",
  direct_order_venue_pending_review: "The Direct Order venue holding its code is still waiting for the validation desk.",
  direct_order_venue_rejected: "The Direct Order venue holding its code was rejected as false by a person.",
  brick_map_unavailable: "The brick map did not load, so the photo's territory could not be read — it is retried next time.",
  read_failed: "Direct Orders could not be asked whether it already holds this pharmacy's code — it is retried next time.",
  write_failed: "The Direct Order venue could not be written — it is retried next time.",
};

/** A skip that is a failure to be retried, not a ruling — the backfill exits non-zero on one. */
export function isRetryableMarketingVenueSkip(reason: MarketingVenueSkipReason): boolean {
  return reason === "write_failed" || reason === "read_failed" || reason === "brick_map_unavailable";
}

type DirectOrderVenueState = {
  id: string;
  active: boolean;
  verificationStatus: string;
  mergedIntoPharmacyId: string | null;
};

export type MarketingVenueSyncPlan =
  | { kind: "skip"; reason: MarketingVenueSkipReason }
  | { kind: "linked"; directOrderPharmacyId: string }
  | { kind: "reuse"; directOrderPharmacyId: string }
  | { kind: "create" };

/**
 * The decision for ONE marketing pharmacy, pure so every branch can be pinned and break-tested.
 *
 * `linkedVenue` is the Direct Order venue the link table already names; `codeVenue` the venue that
 * holds the pharmacy's master-known distributor code, when one does.
 */
export function planMarketingVenueForDirectOrders(input: {
  pharmacy: {
    active: boolean;
    mergedIntoPharmacyId: string | null;
    displayName: string | null;
    hasPhoto: boolean;
    hasGps: boolean;
    customerCode?: string | null;
    distributorCode?: string | null;
    /** True when at least one of this pharmacy's validated links names a distributor code. */
    hasDistributorCode: boolean;
    venueType: VenueType;
  };
  linkedVenue: DirectOrderVenueState | null;
  codeVenue: DirectOrderVenueState | null;
}): MarketingVenueSyncPlan {
  const { pharmacy, linkedVenue, codeVenue } = input;

  // Already across. A link to a retired venue is a person's revert or merge — honoured, never undone.
  if (linkedVenue) {
    if (!linkedVenue.active || linkedVenue.mergedIntoPharmacyId) return { kind: "skip", reason: "direct_order_venue_retired" };
    return { kind: "linked", directOrderPharmacyId: linkedVenue.id };
  }

  if (!pharmacy.active) return { kind: "skip", reason: "pharmacy_inactive" };
  if (pharmacy.mergedIntoPharmacyId) return { kind: "skip", reason: "pharmacy_merged" };
  if (isCertainWholesalerVenue(pharmacy.displayName, pharmacy.customerCode ?? null, pharmacy.distributorCode ?? null)) {
    return { kind: "skip", reason: "wholesaler" };
  }
  // Belt and braces (owner, 2026-10-21: "any thing with no distributor code never reach the marketing
  // requests"). Marketing no longer validates a codeless venue, so one sitting there is a leftover
  // from before the rule — never carried across from Marketing. A nursery is validated in Direct
  // Orders directly, where a codeless venue is allowed.
  if (!pharmacy.hasDistributorCode || !venueRequiresDistributorCode(pharmacy.venueType)) {
    return { kind: "skip", reason: "no_distributor_code" };
  }

  // A venue that already holds the code is the same shop. Reuse it — but only when it is settled.
  if (codeVenue && codeVenue.active && !codeVenue.mergedIntoPharmacyId) {
    if (codeVenue.verificationStatus === "verified") return { kind: "reuse", directOrderPharmacyId: codeVenue.id };
    if (codeVenue.verificationStatus === "rejected") return { kind: "skip", reason: "direct_order_venue_rejected" };
    return { kind: "skip", reason: "direct_order_venue_pending_review" };
  }

  // Minting a venue needs the venue's own evidence: GPS + a live picture, always.
  if (!pharmacy.hasGps) return { kind: "skip", reason: "no_venue_gps" };
  if (!pharmacy.hasPhoto) return { kind: "skip", reason: "no_venue_photo" };
  return { kind: "create" };
}

/** `PHX-MP-` + the marketing pharmacy's own code (or id). Distinct from a Transfer's `PHX-MT-`. */
export function buildMarketingVenuePhoenixCode(pharmacyCode: string | null, pharmacyId: string, attempt = 0): string {
  const seed = (pharmacyCode ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-10) ||
    pharmacyId.replace(/-/g, "").slice(-10).toUpperCase();
  return attempt === 0 ? `PHX-MP-${seed}` : `PHX-MP-${seed}-${attempt + 1}`;
}

export type MarketingVenueSyncResult = {
  created: Array<{ marketingPharmacyId: string; directOrderPharmacyId: string; pharmacyName: string }>;
  reused: Array<{ marketingPharmacyId: string; directOrderPharmacyId: string; pharmacyName: string }>;
  alreadyLinked: number;
  skipped: Array<{ marketingPharmacyId: string; pharmacyName: string; reason: MarketingVenueSkipReason }>;
};

type Row = Record<string, unknown>;

function text(row: Row | null | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function num(row: Row | null | undefined, key: string): number | null {
  const value = row?.[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chunks<T>(values: T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function selectIn(
  table: string,
  column: string,
  ids: string[],
  columns = "*",
  /** Equality filters sent with every chunk — `marketing_evidence_files` is indexed on (entity_type, entity_id) and times out without its type. */
  equals: Record<string, string> = {},
): Promise<Row[]> {
  const supabase = getSupabaseAdmin();
  const rows: Row[] = [];
  for (const slice of chunks(Array.from(new Set(ids.filter(Boolean))))) {
    let query = supabase.from(table).select(columns).in(column, slice);
    for (const [key, value] of Object.entries(equals)) query = query.eq(key, value);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows;
}

function venueState(row: Row | undefined): DirectOrderVenueState | null {
  if (!row) return null;
  return {
    id: String(row.id),
    active: row.active !== false,
    verificationStatus: String(row.verification_status ?? ""),
    mergedIntoPharmacyId: text(row, "merged_into_pharmacy_id"),
  };
}

/**
 * Carry every validated pharmacy of these marketing customers into Direct Orders.
 *
 * Idempotent: a pharmacy the link table already names is counted as linked and nothing is written.
 * Never throws for one venue — the reason goes into `skipped` — and only a failed READ of the inputs
 * themselves rejects, which the callers below swallow and log.
 */
export async function syncMarketingCustomersToDirectOrders(input: {
  customerIds: string[];
  /** Who or what ran it, for the audit row: a validation save, a "My venues" load, the backfill. */
  trigger: "validation_save" | "my_venues" | "backfill";
  /** Plan only: report what WOULD be created or reused, write nothing. The backfill's first run. */
  dryRun?: boolean;
}): Promise<MarketingVenueSyncResult> {
  const result: MarketingVenueSyncResult = { created: [], reused: [], alreadyLinked: 0, skipped: [] };
  const customerIds = Array.from(new Set(input.customerIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (customerIds.length === 0) return result;

  const supabase = getSupabaseAdmin();

  const customers = (await selectIn("marketing_customers", "id", customerIds)).filter(
    (row) =>
      row.active !== false &&
      !text(row, "merged_into_customer_id") &&
      (MARKETING_VALIDATED_CUSTOMER_STATUSES as readonly string[]).includes(String(row.validation_status ?? "")),
  );
  if (customers.length === 0) return result;
  const customerById = new Map(customers.map((row) => [String(row.id), row]));

  const links = (await selectIn("marketing_customer_pharmacies", "customer_id", Array.from(customerById.keys()))).filter(
    (row) => row.active !== false && (LINK_STATUS_PRECEDENCE as readonly string[]).includes(String(row.validation_status ?? "")),
  );
  if (links.length === 0) return result;

  // First validated link per pharmacy names the customer (and capturer) that brings it across; a
  // later link with a master-known code supplies the code if the first had none.
  const linksByPharmacy = new Map<string, Row[]>();
  for (const link of links.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))) {
    const key = String(link.pharmacy_id ?? "");
    if (!key) continue;
    const list = linksByPharmacy.get(key) ?? [];
    list.push(link);
    linksByPharmacy.set(key, list);
  }
  const pharmacyIds = Array.from(linksByPharmacy.keys());

  const [pharmacies, codeRows, mappings, photos] = await Promise.all([
    selectIn("marketing_pharmacies", "id", pharmacyIds),
    selectIn(
      "marketing_pharmacy_distributor_codes",
      "id",
      links.map((link) => String(link.distributor_code_id ?? "")).filter(Boolean),
    ),
    selectIn("marketing_pharmacy_direct_order_venues", "marketing_pharmacy_id", pharmacyIds),
    selectIn(
      "marketing_evidence_files",
      "entity_id",
      pharmacyIds,
      "entity_id, entity_type, evidence_type, storage_bucket, storage_path, captured_at, captured_latitude, captured_longitude, captured_accuracy_meters, created_at",
      { entity_type: "pharmacy", evidence_type: "location_photo" },
    ),
  ]);
  const pharmacyById = new Map(pharmacies.map((row) => [String(row.id), row]));
  const codeById = new Map(codeRows.map((row) => [String(row.id), row]));
  const mappingByPharmacy = new Map(mappings.map((row) => [String(row.marketing_pharmacy_id), row]));
  const photoByPharmacy = new Map<string, Row>();
  for (const photo of photos
    .filter((row) => row.entity_type === "pharmacy" && row.evidence_type === "location_photo" && text(row, "storage_path"))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))) {
    const key = String(photo.entity_id);
    if (!photoByPharmacy.has(key)) photoByPharmacy.set(key, photo);
  }

  // Every master-known code pair on these pharmacies, and which Direct Order venue holds it.
  type CodePair = { distributorCode: string; customerCode: string; codeRow: Row };
  const pairByPharmacy = new Map<string, CodePair>();
  for (const [pharmacyId, pharmacyLinks] of linksByPharmacy) {
    for (const link of pharmacyLinks) {
      const codeRow = codeById.get(String(link.distributor_code_id ?? ""));
      const distributorCode = text(codeRow, "mapped_distributor_code");
      const customerCode = text(codeRow, "mapped_customer_code");
      if (codeRow && distributorCode && customerCode) {
        pairByPharmacy.set(pharmacyId, { distributorCode, customerCode, codeRow });
        break;
      }
    }
  }
  const venueIdsToRead = new Set<string>(mappings.map((row) => String(row.direct_order_pharmacy_id)));
  const codeVenueIdByPharmacy = new Map<string, string>();
  // A lookup that FAILED is not "no venue holds this code" — read that way it mints a second copy
  // of a shop Direct Orders already has. Those pharmacies are skipped and retried next time.
  const codeLookupFailed = new Set<string>();
  for (const [pharmacyId, pair] of pairByPharmacy) {
    const { data, error } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id")
      .eq("distributor_code", pair.distributorCode)
      .eq("customer_code", pair.customerCode)
      .limit(1)
      .maybeSingle();
    if (error) {
      codeLookupFailed.add(pharmacyId);
      continue;
    }
    const venueId = text(data as Row | null, "pharmacy_id");
    if (venueId) {
      codeVenueIdByPharmacy.set(pharmacyId, venueId);
      venueIdsToRead.add(venueId);
    }
  }
  const venues = await selectIn("direct_order_pharmacies", "id", Array.from(venueIdsToRead));
  const venueById = new Map(venues.map((row) => [String(row.id), row]));

  for (const pharmacyId of pharmacyIds) {
    const pharmacy = pharmacyById.get(pharmacyId);
    const firstLink = (linksByPharmacy.get(pharmacyId) ?? [])[0];
    const customer = customerById.get(String(firstLink?.customer_id ?? ""));
    if (!pharmacy || !firstLink || !customer) continue;
    const pharmacyName = text(pharmacy, "display_name") ?? "Marketing pharmacy";
    const pair = pairByPharmacy.get(pharmacyId) ?? null;
    const photo = photoByPharmacy.get(pharmacyId) ?? null;
    const mapping = mappingByPharmacy.get(pharmacyId);
    if (!mapping && codeLookupFailed.has(pharmacyId)) {
      result.skipped.push({ marketingPharmacyId: pharmacyId, pharmacyName, reason: "read_failed" });
      continue;
    }

    const plan = planMarketingVenueForDirectOrders({
      pharmacy: {
        active: pharmacy.active !== false,
        mergedIntoPharmacyId: text(pharmacy, "merged_into_pharmacy_id"),
        displayName: pharmacyName,
        hasPhoto: Boolean(photo),
        hasGps: num(pharmacy, "captured_latitude") !== null && num(pharmacy, "captured_longitude") !== null,
        customerCode: pair?.customerCode ?? null,
        distributorCode: pair?.distributorCode ?? null,
        hasDistributorCode: (linksByPharmacy.get(pharmacyId) ?? []).some((link) => Boolean(text(link, "distributor_code_id"))),
        venueType: normalizeVenueType(pharmacy.venue_type),
      },
      linkedVenue: mapping ? venueState(venueById.get(String(mapping.direct_order_pharmacy_id))) ?? {
        // A link whose venue row is gone (deleted) reads as retired — never re-minted silently.
        id: String(mapping.direct_order_pharmacy_id),
        active: false,
        verificationStatus: "",
        mergedIntoPharmacyId: null,
      } : null,
      codeVenue: venueState(venueById.get(codeVenueIdByPharmacy.get(pharmacyId) ?? "")),
    });

    if (plan.kind === "linked") {
      result.alreadyLinked += 1;
      continue;
    }
    if (plan.kind === "skip") {
      result.skipped.push({ marketingPharmacyId: pharmacyId, pharmacyName, reason: plan.reason });
      continue;
    }
    if (input.dryRun) {
      if (plan.kind === "reuse") {
        result.reused.push({ marketingPharmacyId: pharmacyId, directOrderPharmacyId: plan.directOrderPharmacyId, pharmacyName });
      } else {
        result.created.push({ marketingPharmacyId: pharmacyId, directOrderPharmacyId: "", pharmacyName });
      }
      continue;
    }

    try {
      if (plan.kind === "reuse") {
        const { error } = await supabase.from("marketing_pharmacy_direct_order_venues").insert({
          customer_id: String(customer.id),
          direct_order_pharmacy_id: plan.directOrderPharmacyId,
          link_kind: "reused",
          marketing_pharmacy_id: pharmacyId,
        });
        if (error && String((error as { code?: string }).code ?? "") !== "23505") throw error;
        result.reused.push({ marketingPharmacyId: pharmacyId, directOrderPharmacyId: plan.directOrderPharmacyId, pharmacyName });
        continue;
      }

      const created = await createDirectOrderVenueFromMarketing({
        customer,
        link: firstLink,
        pharmacy,
        pair,
        photo: photo as Row,
        trigger: input.trigger,
      });
      if (created === "brick_map_unavailable") {
        result.skipped.push({ marketingPharmacyId: pharmacyId, pharmacyName, reason: "brick_map_unavailable" });
        continue;
      }
      result.created.push({ marketingPharmacyId: pharmacyId, directOrderPharmacyId: created, pharmacyName });
    } catch (error) {
      logError("Marketing venue could not be carried into Direct Orders", {
        labels: { event: "marketing_venue_sync_failed", trigger: input.trigger },
        context: { marketingPharmacyId: pharmacyId },
        error,
      });
      result.skipped.push({ marketingPharmacyId: pharmacyId, pharmacyName, reason: "write_failed" });
    }
  }

  return result;
}

async function createDirectOrderVenueFromMarketing(input: {
  customer: Row;
  link: Row;
  pharmacy: Row;
  pair: { distributorCode: string; customerCode: string; codeRow: Row } | null;
  photo: Row;
  trigger: string;
}): Promise<string | "brick_map_unavailable"> {
  const supabase = getSupabaseAdmin();
  const { customer, link, pharmacy, pair, photo } = input;
  const pharmacyId = String(pharmacy.id);
  const venueType: VenueType = normalizeVenueType(pharmacy.venue_type);
  const pharmacyName = text(pharmacy, "display_name") ?? "Marketing pharmacy";
  const latitude = num(pharmacy, "captured_latitude");
  const longitude = num(pharmacy, "captured_longitude");

  // The pharmacy's own area first; the customer's when the shop row carries none.
  const areaId = num(pharmacy, "area_id") ?? num(customer, "area_id");
  let marketingAreaCode: string | null = null;
  if (areaId !== null) {
    const { data } = await supabase.from("areas").select("code").eq("id", areaId).maybeSingle();
    marketingAreaCode = text(data as Row | null, "code");
  }
  const codeRow = pair?.codeRow ?? null;
  const resolved = await resolveDirectOrderGeography({
    mappedAreaCode: text(codeRow, "mapped_area_code"),
    mappedBrickId: text(codeRow, "mapped_brick_id"),
    mappedRegionCode: text(codeRow, "mapped_region_code"),
    marketingAreaCode,
  });
  let pin;
  try {
    pin = await readPinTerritory(latitude, longitude, "brick map unavailable");
  } catch {
    // The photo is the primary source of trust; filing without it would file the label. Retry later.
    return "brick_map_unavailable";
  }
  const { geography, pinBrick } = applyPhotoPinTerritory(resolved, pin);
  const brick = pinBrick
    ? pinBrick
    : geography.brickId
      ? { brickId: geography.brickId, brickName: null, distanceKm: null }
      : await suggestBrickForCapture({ areaCode: geography.areaCode, latitude, longitude });

  // Is the code really in the master? Only then is it linked, and only then is the venue trusted.
  let masterPair: { distributorCode: string; customerCode: string; geo: Row } | null = null;
  if (pair && venueRequiresDistributorCode(venueType)) {
    const { data: mapRow } = await supabase
      .from("source_of_sales_customer_map")
      .select("brick_id, area_code, region_code")
      .eq("active", true)
      .eq("distributor_code", pair.distributorCode)
      .eq("customer_code", pair.customerCode)
      .maybeSingle();
    if (mapRow) masterPair = { distributorCode: pair.distributorCode, customerCode: pair.customerCode, geo: mapRow as Row };
  }

  const { data: contactData } = await supabase
    .from("marketing_customer_contacts")
    .select("contact_name")
    .eq("customer_id", String(customer.id))
    .neq("active", false)
    .not("contact_name", "is", null)
    .limit(1)
    .maybeSingle();
  const doctorName = text(contactData as Row | null, "contact_name") ?? text(customer, "display_name");

  // The rep who captured the customer owns the venue, so it lands in HIS "My venues".
  const ownerHrId = resolveTransferredVenueOwnerHrId(
    customer,
    text(link, "created_by_hr_id") ?? text(pharmacy, "created_by_hr_id") ?? "",
  );
  const now = new Date().toISOString();
  const trusted = masterPair !== null;

  let venueId: string | null = null;
  for (let attempt = 0; attempt < 4 && !venueId; attempt += 1) {
    const { data, error } = await supabase
      .from("direct_order_pharmacies")
      .insert({
        active: true,
        area_code: geography.areaCode,
        brick_id: brick.brickId,
        created_by_hr_id: ownerHrId || null,
        doctor_name: doctorName,
        entry_source: "marketing_transfer",
        pharmacy_address: text(pharmacy, "captured_address") ?? text(customer, "captured_address"),
        pharmacy_name: pharmacyName,
        phoenix_pharmacy_code: buildMarketingVenuePhoenixCode(text(pharmacy, "pharmacy_code"), pharmacyId, attempt),
        probation_started_at: trusted ? null : now,
        region_code: geography.regionCode,
        trust_state: trusted ? "trusted" : "provisional",
        trusted_at: trusted ? now : null,
        trusted_reason: trusted
          ? `Validated in Marketing with registered code ${masterPair?.distributorCode}/${masterPair?.customerCode}`
          : null,
        venue_type: venueType,
        verification_status: "verified",
        verified_at: now,
      })
      .select("id")
      .single();
    if (!error) {
      venueId = String((data as Row).id);
      break;
    }
    // 23505 on the Phoenix code only: try the next suffix. Anything else is a real failure.
    if (String((error as { code?: string }).code ?? "") !== "23505") throw error;
  }
  if (!venueId) throw new Error("Could not mint a unique Phoenix code for the marketing venue.");

  // Claim the link FIRST of the remaining writes: a concurrent run that lost the race retires its
  // own fresh row instead of leaving a second copy of the shop on the Direct Order side.
  const { error: mappingError } = await supabase.from("marketing_pharmacy_direct_order_venues").insert({
    customer_id: String(customer.id),
    direct_order_pharmacy_id: venueId,
    link_kind: "created",
    marketing_pharmacy_id: pharmacyId,
  });
  if (mappingError) {
    await supabase.from("direct_order_pharmacies").update({ active: false }).eq("id", venueId);
    if (String((mappingError as { code?: string }).code ?? "") === "23505") {
      const { data: winner } = await supabase
        .from("marketing_pharmacy_direct_order_venues")
        .select("direct_order_pharmacy_id")
        .eq("marketing_pharmacy_id", pharmacyId)
        .maybeSingle();
      const winnerId = text(winner as Row | null, "direct_order_pharmacy_id");
      if (winnerId) return winnerId;
    }
    throw mappingError;
  }

  if (masterPair) {
    const { error: linkError } = await supabase.from("direct_order_pharmacy_distributor_codes").insert({
      customer_code: masterPair.customerCode,
      distributor_code: masterPair.distributorCode,
      mapped_area_code: text(masterPair.geo, "area_code"),
      mapped_brick_id: text(masterPair.geo, "brick_id"),
      mapped_region_code: text(masterPair.geo, "region_code"),
      pharmacy_id: venueId,
    });
    // 23505: another venue took the code between the read and this write; the venue stands uncoded.
    if (linkError && String((linkError as { code?: string }).code ?? "") !== "23505") throw linkError;
  }

  const reason = [
    "Validated automatically from the Marketing customer validation (owner rule, 2026-10-21).",
    `Customer: ${text(customer, "display_name") ?? String(customer.id)} — ${String(customer.validation_status)}; link ${String(link.validation_status)}.`,
    geography.source === "photo_pin" && brick.brickId
      ? `Brick ${brick.brickId} and area ${geography.areaCode} come from the pharmacy photo's own GPS pin.`
      : geography.areaCode
        ? `Area ${geography.areaCode} comes from ${geography.source === "master_code" ? "the Phoenix master database" : "the marketing area"}.`
        : "No area could be resolved for this venue.",
  ].join(" ");

  const { error: claimError } = await supabase.from("direct_order_pharmacy_validations").insert({
    captured_accuracy_meters: num(pharmacy, "captured_accuracy_meters"),
    captured_address: text(pharmacy, "captured_address"),
    captured_at: text(pharmacy, "captured_at"),
    captured_latitude: latitude,
    captured_longitude: longitude,
    claimed_address: text(pharmacy, "captured_address"),
    claimed_doctor_name: doctorName,
    claimed_pharmacy_name: pharmacyName,
    claimed_reason: reason,
    decided_at: now,
    decision_notes: reason,
    matched_customer_code: masterPair?.customerCode ?? null,
    matched_distributor_code: masterPair?.distributorCode ?? null,
    photo_accuracy_meters: num(photo, "captured_accuracy_meters"),
    photo_captured_at: text(photo, "captured_at"),
    photo_latitude: num(photo, "captured_latitude"),
    photo_longitude: num(photo, "captured_longitude"),
    pharmacy_id: venueId,
    request_id: null,
    requested_at: now,
    requested_by_hr_id: hrIdForStorage(ownerHrId) ?? null,
    requester_area_code: geography.areaCode,
    status: trusted ? "matched_existing" : "approved_new",
    storage_bucket: text(photo, "storage_bucket") ?? MARKETING_EVIDENCE_BUCKET,
    storage_path: text(photo, "storage_path"),
    validation_route: "field",
  });
  if (claimError) {
    // The venue stands; only its decorating claim is missing. Logged, not thrown — the venue is real.
    logError("Marketing venue carried across without its evidence claim", {
      labels: { event: "marketing_venue_claim_failed" },
      context: { directOrderPharmacyId: venueId, marketingPharmacyId: pharmacyId },
      error: claimError,
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: ownerHrId || "system",
    entityId: `pharmacy:${venueId}`,
    entityType: "direct_order_request",
    newValues: {
      areaCode: geography.areaCode,
      brickId: brick.brickId,
      marketingCustomerId: String(customer.id),
      marketingPharmacyId: pharmacyId,
      trustState: trusted ? "trusted" : "provisional",
      trigger: input.trigger,
    },
    oldValues: null,
    summary: `Direct-order venue "${pharmacyName}" validated automatically from the Marketing customer validation.`,
  });

  return venueId;
}

/**
 * The marketing customers a rep validated — the ones that make a venue "his". Captured by him, or
 * owned by him; the same two columns the manual Transfer reads for the owner.
 */
async function loadMarketingCustomerIdsForRep(hrId: string | null | undefined): Promise<string[]> {
  const keys = hrIdLookupKeys(hrId);
  if (keys.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const [{ data: created, error: createdError }, { data: owned, error: ownedError }] = await Promise.all([
    supabase.from("marketing_customers").select("id").in("created_by_hr_id", keys).in("validation_status", [...MARKETING_VALIDATED_CUSTOMER_STATUSES]),
    supabase.from("marketing_customers").select("id").in("owner_hr_id", keys).in("validation_status", [...MARKETING_VALIDATED_CUSTOMER_STATUSES]),
  ]);
  if (createdError) throw createdError;
  if (ownedError) throw ownedError;
  return Array.from(
    new Set([...((created ?? []) as Row[]), ...((owned ?? []) as Row[])].map((row) => String(row.id))),
  );
}

/**
 * The Direct Order venues that came from a rep's own marketing validations — read by "My venues".
 *
 * Answered from EVERY validated link, at read time, so two reps who validated doctors at the same
 * shop both see it, though the shop is one venue. Before reading, the rep's own validated customers
 * are synced once, so a validation made on any path (a desk entry, a later completion, an admin's
 * release) reaches his list the next time he opens it. A failed sync never fails the list.
 */
export async function listDirectOrderVenueIdsFromMyMarketingValidations(hrId: string | null | undefined): Promise<string[]> {
  const customerIds = await loadMarketingCustomerIdsForRep(hrId);
  if (customerIds.length === 0) return [];
  try {
    await syncMarketingCustomersToDirectOrders({ customerIds, trigger: "my_venues" });
  } catch (error) {
    logError("My venues could not sync the rep's marketing validations", {
      labels: { event: "marketing_venue_sync_failed", trigger: "my_venues" },
      error,
    });
  }
  const links = (await selectIn("marketing_customer_pharmacies", "customer_id", customerIds, "pharmacy_id, active, validation_status")).filter(
    (row) => row.active !== false && (LINK_STATUS_PRECEDENCE as readonly string[]).includes(String(row.validation_status ?? "")),
  );
  const mappings = await selectIn(
    "marketing_pharmacy_direct_order_venues",
    "marketing_pharmacy_id",
    links.map((row) => String(row.pharmacy_id ?? "")),
    "direct_order_pharmacy_id",
  );
  return Array.from(new Set(mappings.map((row) => String(row.direct_order_pharmacy_id)).filter(Boolean)));
}

/** The hook a marketing validation save calls. Never throws; the save has already happened. */
export async function syncMarketingValidationToDirectOrdersQuietly(customerIds: string[]): Promise<void> {
  try {
    const result = await syncMarketingCustomersToDirectOrders({ customerIds, trigger: "validation_save" });
    const failed = result.skipped.filter((row) => isRetryableMarketingVenueSkip(row.reason));
    if (failed.length > 0) {
      logError("Some marketing venues did not reach Direct Orders on save", {
        labels: { event: "marketing_venue_sync_partial" },
        context: { failed },
      });
    }
  } catch (error) {
    logError("Marketing validation could not be carried into Direct Orders", {
      labels: { event: "marketing_venue_sync_failed", trigger: "validation_save" },
      context: { customerIds },
      error,
    });
  }
}
