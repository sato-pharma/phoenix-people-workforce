import type { AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { loadMarketingEvidencePhoto } from "@/lib/marketing-requests/evidence-photo-storage";
import { getMarketingRequestDecisionSummary } from "@/lib/marketing-requests/service";
import { loadBrickCentroids, resolveBrickForPoint, type ResolvedBrickPoint } from "@/lib/crm/brick-geo";
import { applyPhotoPinTerritory, type PinnedGeography } from "@/lib/marketing-requests/photo-pin-territory";
import { haversineKm } from "@/lib/sales/normalizer/geo-validate";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isUuid } from "@/lib/http/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// Validated Customers register, and the one-way door into Direct Orders.
//
// THE PROBLEM THIS SOLVES (owner, 2026-08-22). Marketing and Direct Orders each keep their own
// customer store — `marketing_customers` / `marketing_pharmacies` on one side,
// `direct_order_pharmacies` on the other — and each has its own validation desk. A manager who
// validated a shop in Marketing was being asked to stand in front of the same shop again for
// Direct Orders. The owner's ruling: he validates ONCE, in whichever module he is in. An admin
// then reviews the record and, when satisfied, hands it to Direct Orders to be validated there —
// with nothing re-captured.
//
// WHAT "VALIDATED" ACTUALLY MEANS, and why this register has to exist at all.
// `system_validated` is granted AUTOMATICALLY, on evidence alone (see
// `resolveMarketingSystemValidationStatus` in service.ts): a GPS fix plus a timestamped live photo
// that reached the bucket, and no outright governorate contradiction. No human is involved —
// production shows `validated_by_hr_id` NULL on every `system_validated` row. It is proof that a
// rep stood in front of a building. It is NOT proof the record is complete, and it never claimed
// to be. Everything the desk needs beyond that — contact, mobile, a resolvable area, whether this
// shop is already on file twice — is deliberately flag-only by earlier owner rulings.
//
// So the admin needs a screen that tells him what the automatic gate did not check. That is
// `buildValidatedCustomerCompleteness` below, and its checklist is not invented: every item is a
// field Direct Orders will actually want, so "complete" here means "this will land cleanly over
// there" rather than "somebody filled in more boxes".
//
// NOTHING HERE BLOCKS. Owner's instruction, same day: "This transfer is made manually by the
// admin… ask him, are you sure… If I tell yes, that's okay. Then proceed. Don't block." The
// completeness panel therefore informs, the confirmation dialog gates, and the admin decides. The
// only refusals in this file are the two that protect the OTHER module's integrity — a customer
// already live on the Direct Order desk, and a revert of a transfer Direct Orders has already
// decided. Both are explained where they are thrown.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Who may OPEN the register and the customer detail — read only.
 *
 * **Super Admin and SFE Manager.** Owner decision, 2026-09-21, asked in chat as multiple choice:
 * the SFE Manager gets the register VIEW ONLY. This widens the 2026-08-22 ruling ("Super admin
 * only, SFE cannot do this thing") for reading and nothing else — what SFE still cannot do is the
 * transfer and the revert, gated by `canTransferValidatedCustomers` below. Do not merge the two
 * predicates back into one.
 *
 * The marketing workflow roles (Marketing Manager, Product Manager, Group Product Manager) were
 * never in scope — they raise and approve spend, they do not run the customer desk.
 */
export function canOpenValidatedCustomerRegister(
  access: Pick<AccessContext, "role" | "scope">,
): boolean {
  if (access.scope === "system") return true;
  return access.role === "Super Admin" || access.role === "SFE Manager";
}

/**
 * Who may press the buttons — transfer a customer into Direct Orders, or revert a transfer.
 *
 * **Super Admin only.** Owner ruling, 2026-08-22: "Super admin only, SFE cannot do this thing.
 * Only super admin." — kept on 2026-09-21 when SFE was given the view. Seeing the register is not
 * the same authority as writing a pharmacy into a second module, and the transfer does exactly that.
 */
export function canTransferValidatedCustomers(
  access: Pick<AccessContext, "role" | "scope">,
): boolean {
  if (access.scope === "system") return true;
  return access.role === "Super Admin";
}

export function assertValidatedCustomerTransferAccess(access: AccessContext) {
  if (!canTransferValidatedCustomers(access)) {
    throw forbiddenError(
      `Forbidden: ${access.role} can view validated customers but cannot transfer or revert them.`,
    );
  }
}

/**
 * The page guard and this service gate MUST resolve identically, so the predicate above is the one
 * both call. The marketing Customer Database is a live example of what happens otherwise: its
 * service admits Super Admin AND SFE Manager, while its page guard runs
 * `canAccessSystemAdministratorWorkspace`, which is Super Admin only — so the SFE Manager the
 * service was deliberately widened for cannot actually open the page. One predicate, two callers,
 * no drift.
 */
export function assertValidatedCustomerRegisterAccess(access: AccessContext) {
  if (!canOpenValidatedCustomerRegister(access)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot open the validated customer register.`);
  }
}

/** The two statuses that mean a human or the evidence gate has cleared the customer. */
const VALIDATED_STATUSES = ["system_validated", "sfe_validated"] as const;

export type ValidatedCustomerTransferStatus = "transferred" | "reverted";

export type ValidatedCustomerCompletenessSeverity = "ok" | "warning" | "blocker";

export type ValidatedCustomerCompletenessItem = {
  /** Stable key, so the UI and the tests refer to the same check. */
  key: string;
  label: string;
  severity: ValidatedCustomerCompletenessSeverity;
  /** What the admin is actually looking at, in his words, never a field name. */
  detail: string;
};

export type ValidatedCustomerCompleteness = {
  items: ValidatedCustomerCompletenessItem[];
  blockers: number;
  warnings: number;
  /** True only when nothing is outstanding at all. */
  isComplete: boolean;
};

export type ValidatedCustomerCompletenessInput = {
  displayName: string | null;
  customerType: string | null;
  capturedAddress: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  capturedAccuracyMeters: number | null;
  evidenceStatus: string | null;
  hasEvidencePhoto: boolean;
  contactName: string | null;
  contactMobile: string | null;
  /** How many pharmacies the customer is linked to. Direct Orders transfers a PHARMACY. */
  linkedPharmacyCount: number;
  /** The distributor + customer code pair, when the linked pharmacy carries one. */
  distributorCode: string | null;
  distributorCustomerCode: string | null;
  /** Resolved Direct Order area code, or null when the marketing area maps to nothing. */
  resolvedAreaCode: string | null;
  marketingAreaName: string | null;
  /** Other ACTIVE marketing customers sharing this normalized name. */
  duplicateCount: number;
};

/**
 * The completeness checklist, as pure logic so a test can pin every branch without a database.
 *
 * Severity is a judgement about CONSEQUENCE, not about how empty the field is:
 *
 *   blocker  — Direct Orders cannot do its job without it. A pharmacy with no name and no address
 *              cannot be matched against the master sheets, which is the desk's first move.
 *   warning  — the transfer will succeed and the desk can still decide, but somebody will have to
 *              chase this later. A missing mobile is the common case: 9 of the 22 live validated
 *              customers have none.
 *
 * A "blocker" here still does NOT stop the transfer — see the module header. It is the strongest
 * thing this screen says, and the admin is entitled to overrule it.
 */
export function buildValidatedCustomerCompleteness(
  input: ValidatedCustomerCompletenessInput,
): ValidatedCustomerCompleteness {
  const items: ValidatedCustomerCompletenessItem[] = [];

  const push = (
    key: string,
    label: string,
    severity: ValidatedCustomerCompletenessSeverity,
    detail: string,
  ) => {
    items.push({ detail, key, label, severity });
  };

  const name = (input.displayName ?? "").trim();
  push(
    "name",
    "Customer name",
    name ? "ok" : "blocker",
    name || "No name on the record. Direct Orders cannot match a nameless shop against the master database.",
  );

  const address = (input.capturedAddress ?? "").trim();
  push(
    "address",
    "Address",
    address ? "ok" : "blocker",
    address || "No address captured. The Direct Order desk matches on name and address first.",
  );

  const hasGps = input.capturedLatitude !== null && input.capturedLongitude !== null;
  push(
    "gps",
    "GPS location",
    hasGps ? "ok" : "blocker",
    hasGps
      ? `${input.capturedLatitude}, ${input.capturedLongitude}${
          input.capturedAccuracyMeters !== null
            ? ` — accurate to about ${Math.round(input.capturedAccuracyMeters)} m`
            : ""
        }`
      : "No GPS fix. Without it nobody can tell whether the shop is where the rep says it is.",
  );

  push(
    "photo",
    "Storefront photo",
    input.hasEvidencePhoto ? "ok" : "warning",
    input.hasEvidencePhoto
      ? "A live capture photo is on file and can be opened below."
      : "No retrievable photo. The record may still be genuine — desk-entered customers never have one — but there is no image to check.",
  );

  push(
    "evidence",
    "Evidence state",
    input.evidenceStatus === "complete" ? "ok" : "warning",
    input.evidenceStatus === "complete"
      ? "Complete — GPS and a timestamped photo both reached the system."
      : `Evidence is "${input.evidenceStatus ?? "missing"}", not complete. The customer was cleared by a person, not by the automatic evidence gate.`,
  );

  const contact = (input.contactName ?? "").trim();
  push(
    "contact",
    "Contact name",
    contact ? "ok" : "warning",
    contact || "No contact captured. Direct Orders records a doctor/contact name against the pharmacy.",
  );

  const mobile = (input.contactMobile ?? "").trim();
  push(
    "mobile",
    "Mobile number",
    mobile ? "ok" : "warning",
    mobile || "No mobile number. Nobody can reach this customer from the record alone.",
  );

  push(
    "pharmacy",
    "Linked pharmacy",
    input.linkedPharmacyCount > 0 ? "ok" : "blocker",
    input.linkedPharmacyCount > 0
      ? `${input.linkedPharmacyCount} pharmac${input.linkedPharmacyCount === 1 ? "y" : "ies"} linked.`
      : "No pharmacy linked. Direct Orders transfers a PHARMACY — there is nothing here to send.",
  );

  const hasCodePair = Boolean((input.distributorCode ?? "").trim() && (input.distributorCustomerCode ?? "").trim());
  push(
    "distributor_code",
    "Distributor code",
    hasCodePair ? "ok" : "warning",
    hasCodePair
      ? `${input.distributorCode} / ${input.distributorCustomerCode}`
      : "No distributor + customer code pair. Direct Orders can still validate the shop, but no sale will ever attribute to it until a code is attached.",
  );

  push(
    "area",
    "Direct Order area",
    input.resolvedAreaCode ? "ok" : "blocker",
    input.resolvedAreaCode
      ? `Resolves to ${input.resolvedAreaCode}.`
      : `The marketing area "${input.marketingAreaName ?? "unknown"}" does not exist in the Direct Order area list, so the transferred pharmacy will carry no area. Fix the customer's area first, or the Direct Order desk will not know whose territory this is.`,
  );

  push(
    "duplicate",
    "Duplicate check",
    input.duplicateCount > 0 ? "warning" : "ok",
    input.duplicateCount > 0
      ? `${input.duplicateCount} other active customer${input.duplicateCount === 1 ? "" : "s"} share this name. Transferring both would create the same shop twice in Direct Orders.`
      : "No other active customer shares this name.",
  );

  const blockers = items.filter((item) => item.severity === "blocker").length;
  const warnings = items.filter((item) => item.severity === "warning").length;

  return { blockers, isComplete: blockers === 0 && warnings === 0, items, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geography resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy marketing areas, mapped to the Direct Order vocabulary they actually mean.
 *
 * `public.areas` carries TWO vocabularies side by side. The current one is the Direct Order /
 * Source-of-Sales coding (`AB1`, `D12`, `GZ6`, `UE5` …), which matches `source_of_sales_areas`
 * exactly. Underneath it survive slug-style rows from an older, line-scoped scheme (`delta_1`,
 * `delta_2`, `menoufia_1`, `alex_delta` …). Measured on production 2026-08-22: of the 36 areas
 * marketing customers actually sit on, 35 resolve in `source_of_sales_areas` and exactly one does
 * not — `delta_1`.
 *
 * Every entry here is an OWNER RULING, quoted and dated. None is inferred from coordinates, from a
 * name resembling another name, or from a brick centroid. A wrong entry silently routes a real shop
 * to the wrong manager, so if an area is not listed here it stays unresolved and the completeness
 * panel says so — that is the safe failure, and it is deliberate.
 *
 * This is intentionally NOT stored in `source_of_sales_area_aliases`: that table maps the names
 * printed in distributor sales sheets (`IS`, `PS` labels, sourced from the Area_Master sheet) to
 * area codes for import matching. A Phoenix-internal area slug never appears in a distributor
 * sheet, so putting it there would pollute the import namespace with a key nothing imports.
 */
export const LEGACY_MARKETING_AREA_ALIASES: Readonly<Record<string, string>> = {
  // Owner, 2026-08-22, asked directly and answered in one line: "Delta (1) is Menoufia 1."
  // `Menoufia 1` is area_code D12, region D1. Four validated customers sit on `delta_1`, including
  // both copies of حضانه النيل, and all four were blocked from transfer until this ruling.
  delta_1: "D12",
};

/**
 * Normalize a marketing area code to the one `source_of_sales_areas` knows. Returns the input
 * unchanged when it is already current — which is the case for 35 of the 36 live areas — so this is
 * a spelling fix, never a reassignment.
 */
export function applyLegacyMarketingAreaAlias(code: string | null | undefined): string | null {
  const trimmed = (code ?? "").trim();
  if (!trimmed) return null;
  return LEGACY_MARKETING_AREA_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** Where each value came from, so the page can say so instead of implying certainty. */
export type ResolvedDirectOrderGeography = PinnedGeography;

/**
 * The territory a captured pin falls in — the SAME brick centres the evidence stamp itself uses.
 *
 * 🔴 IT REFUSES WHEN THE BRICK MAP DID NOT LOAD (code review, 19 Oct 2026). `loadBrickCentroids` answers
 * [] on a read failure, and about 700 bricks carry a centre, so an empty list is the map failing, never
 * "no brick near". Read as no territory, the photo — the primary evidence — silently lost to the master
 * code or the inherited marketing label, and a transfer filed the venue where its photo says it is not.
 */
async function readPinTerritory(
  latitude: number | null,
  longitude: number | null,
  refusal: string,
): Promise<ResolvedBrickPoint | null> {
  if (latitude === null || longitude === null) return null;
  const centroids = await loadBrickCentroids();
  if (centroids.length === 0) throw new Error(refusal);
  return resolveBrickForPoint(latitude, longitude, centroids);
}

/**
 * Work out the area, region and brick Direct Orders should store — preferring the answer Phoenix
 * has ALREADY resolved over anything this module could infer.
 *
 * The good case, and it is the common one. When a marketing pharmacy's distributor code matches the
 * Phoenix reference database, `marketing_pharmacy_distributor_codes` keeps the master's own answer
 * on the row: `mapped_area_code`, `mapped_region_code`, `mapped_brick_id`. Measured against
 * production: 290 of the 310 active code rows carry all three. That is the SAME master resolution
 * `ensureDirectOrderPharmacyFromDirectory` reads when it materializes a pharmacy from the
 * catalogue, so a transfer that uses it lands the shop in exactly the territory the distributor
 * directory would have. Nothing is being guessed at all.
 *
 * The fallback. When the code never matched (`reference_status = 'not_found'` — 10 rows today,
 * deliberately released and flagged rather than blocked, per the 2026-08-12 ruling), there are no
 * mapped values, and the only thing left is the customer's own marketing area. 35 of the 36 areas
 * in use already carry the Direct Order area code as their `areas.code` (`AB1`, `D12`, `GZ6`, `UE5`
 * …) and match `source_of_sales_areas` exactly, so that lookup succeeds for almost all of them.
 *
 * The legacy slugs. A handful of `public.areas` rows predate that coding and match nothing —
 * `delta_1` / "Delta (1)" is the only one any live customer sits on. Those go through
 * `LEGACY_MARKETING_AREA_ALIASES` above, which holds owner rulings only. An area that is neither
 * current nor listed there is left UNRESOLVED rather than guessed: picking a plausible neighbour
 * would be inventing a territory, and a wrong territory silently routes a shop to the wrong
 * manager. The completeness panel names it instead, and the admin fixes the source record.
 */
async function resolveDirectOrderGeography(input: {
  marketingAreaCode: string | null;
  mappedAreaCode?: string | null;
  mappedRegionCode?: string | null;
  mappedBrickId?: string | null;
}): Promise<ResolvedDirectOrderGeography> {
  const mappedArea = (input.mappedAreaCode ?? "").trim();
  if (mappedArea) {
    return {
      areaCode: mappedArea,
      brickId: (input.mappedBrickId ?? "").trim() || null,
      regionCode: (input.mappedRegionCode ?? "").trim() || null,
      source: "master_code",
    };
  }

  const code = applyLegacyMarketingAreaAlias(input.marketingAreaCode);
  if (!code) return { areaCode: null, brickId: null, regionCode: null, source: "none" };

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("source_of_sales_areas")
    .select("area_code, region_code")
    .eq("active", true)
    .eq("area_code", code)
    .maybeSingle();

  const row = data as { area_code?: string | null; region_code?: string | null } | null;
  if (!row?.area_code) return { areaCode: null, brickId: null, regionCode: null, source: "none" };
  return {
    areaCode: String(row.area_code),
    brickId: null,
    regionCode: row.region_code ? String(row.region_code) : null,
    source: "marketing_area",
  };
}

/**
 * LAST-RESORT brick for the captured pin, used only when the master database had none to give.
 *
 * Marketing stores no brick at any level: neither `marketing_customers` nor `marketing_pharmacies`
 * has the column, only an area and a geocoded governorate string. When the pharmacy's distributor
 * code matched the reference database, `mapped_brick_id` already holds the master's answer and
 * this function is never called. It exists for the ~10 codes that never matched, where the only
 * derivation available is "which brick centroid in this area is the pin nearest to".
 *
 * That answer is a SUGGESTION and is labelled as one everywhere it surfaces, because brick
 * centroids are themselves geocoded guesses (949 of 1,142 resolved) — the same caveat
 * `resolveAreaProximity` carries on the Direct Order validation desk, for the same reason. The
 * distance comes back too, so a 40 km "nearest" brick reads as the nonsense it is rather than as a
 * territory.
 */
async function suggestBrickForCapture(input: {
  areaCode: string | null;
  latitude: number | null;
  longitude: number | null;
}): Promise<{ brickId: string | null; brickName: string | null; distanceKm: number | null }> {
  const empty = { brickId: null, brickName: null, distanceKm: null };
  if (!input.areaCode || input.latitude == null || input.longitude == null) return empty;

  const supabase = getSupabaseAdmin();
  const { data: brickRows } = await supabase
    .from("source_of_sales_bricks")
    .select("brick_id, brick_name")
    .eq("active", true)
    .eq("area_code", input.areaCode)
    .limit(300);

  const bricks = ((brickRows ?? []) as Array<{ brick_id?: string | null; brick_name?: string | null }>)
    .filter((row) => row.brick_id)
    .map((row) => ({ id: String(row.brick_id), name: row.brick_name ? String(row.brick_name) : null }));
  if (bricks.length === 0) return empty;

  const { data: centroidRows } = await supabase
    .from("geo_locations")
    .select("source_key, latitude, longitude")
    .eq("source_type", "brick_centroid")
    .eq("geocode_status", "success")
    .in(
      "source_key",
      bricks.map((brick) => brick.id).slice(0, 200),
    );

  const byId = new Map(bricks.map((brick) => [brick.id, brick.name]));
  let best: { distanceKm: number; id: string; name: string | null } | null = null;

  for (const row of (centroidRows ?? []) as Array<{
    latitude?: number | null;
    longitude?: number | null;
    source_key?: string | null;
  }>) {
    if (row.latitude == null || row.longitude == null || !row.source_key) continue;
    const km = haversineKm(
      Number(input.latitude),
      Number(input.longitude),
      Number(row.latitude),
      Number(row.longitude),
    );
    if (!best || km < best.distanceKm) {
      best = { distanceKm: km, id: String(row.source_key), name: byId.get(String(row.source_key)) ?? null };
    }
  }

  if (!best) return empty;
  return { brickId: best.id, brickName: best.name, distanceKm: Math.round(best.distanceKm * 10) / 10 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared row loading
// ─────────────────────────────────────────────────────────────────────────────

type CustomerRow = Record<string, unknown>;

function text(row: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function num(row: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = row?.[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── Every HR_ID name lookup in this file is case-insensitive, deliberately ───
//
// `access.hrId` has already been through `normalizeHrIdForAccess`, which LOWER-CASES. So a transfer
// stores `transferred_by_hr_id = "b-10"` while `employees.hr_id` is `"B-10"`. A case-sensitive
// `.in("hr_id", ["b-10"])` matches no row, the name resolves to null, and the screen falls back to
// printing the raw id.
//
// That is exactly what the first live transfer did (حضانه النيل, 2026-08-22 18:45 Cairo): the
// register and the detail page both showed `b-10` where they should have shown the admin's name.
// It breaks the owner's standing rule — human-readable names, never raw codes or IDs — and it would
// have done it on EVERY transfer, because the lower-casing is in the access layer, not in that one
// row. The other ids on this screen (owner, manager, validated-by, created-by) come straight from
// the marketing tables and happen to match case today; routing them through the same canonical key
// costs nothing and stops the same drift reaching them later.
function hrNameKey(value: string | null | undefined): string | null {
  return canonicalHrIdKey(value);
}

function hrNameFrom(names: Map<string, string | null>, hrId: string | null | undefined): string | null {
  const key = hrNameKey(hrId);
  return key ? names.get(key) ?? null : null;
}

/** Widen an id set to every case variant, so the query finds the row whatever case it is stored in. */
function hrIdQueryKeys(hrIds: readonly string[]): string[] {
  return [...new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
}

/**
 * A marketing capture can carry a PLACEHOLDER where a distributor code should be.
 *
 * حضانه النيل (transferred 2026-08-22) came across with `distributor_pharmacy_code = "0000"`, which
 * is what a rep types when the shop has no code yet. Copying that into Direct Orders is worse than
 * copying nothing: the pharmacy then LOOKS coded, so nobody chases the real code, and it still
 * matches no distributor. Treat an all-zero or single-repeated-character run as absent.
 */
function realDistributorValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(.)\1*$/.test(trimmed)) return null;
  return trimmed;
}

export type ValidatedCustomerListRow = {
  id: string;
  customerCode: string | null;
  displayName: string | null;
  customerType: string | null;
  validationStatus: string;
  evidenceStatus: string | null;
  validatedAt: string | null;
  createdAt: string;
  ownerHrId: string | null;
  ownerName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  areaName: string | null;
  lineName: string | null;
  governorate: string | null;
  /** Live transfer, when one exists. Null means the Transfer button is available. */
  transfer: {
    id: string;
    status: ValidatedCustomerTransferStatus;
    transferredAt: string;
    transferredByHrId: string;
    transferredByName: string | null;
    directOrderValidationStatus: string | null;
  } | null;
  duplicateCount: number;
};

/**
 * Every validated customer in the company, newest first, with who captured it and who manages
 * them — the owner's "a list of validated customers and by whom and when".
 *
 * Company-wide on purpose. This is the one marketing surface that does NOT run rows through
 * `canSeeMarketingCustomer`: the whole point is that an admin sees the reps' work across every
 * territory, and the role gate above is what makes that safe. Same posture as
 * `getMarketingCustomerDatabaseWorkspace`.
 */
export async function listValidatedMarketingCustomers(
  access: AccessContext,
): Promise<{ rows: ValidatedCustomerListRow[]; summary: { total: number; transferred: number; owners: number } }> {
  assertValidatedCustomerRegisterAccess(access);

  const supabase = getSupabaseAdmin();
  const { data: customerData, error } = await supabase
    .from("marketing_customers")
    .select(
      "id, customer_code, display_name, normalized_name, customer_type, validation_status, evidence_status, validated_at, created_at, owner_hr_id, manager_hr_id, area_id, line_id, extracted_governorate_name",
    )
    .in("validation_status", VALIDATED_STATUSES as unknown as string[])
    .neq("active", false)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;

  const customers = (customerData ?? []) as CustomerRow[];
  if (customers.length === 0) {
    return { rows: [], summary: { owners: 0, total: 0, transferred: 0 } };
  }

  const hrIds = [
    ...new Set(
      customers
        .flatMap((row) => [text(row, "owner_hr_id"), text(row, "manager_hr_id")])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const areaIds = [...new Set(customers.map((row) => num(row, "area_id")).filter((v): v is number => v !== null))];
  const lineIds = [...new Set(customers.map((row) => num(row, "line_id")).filter((v): v is number => v !== null))];
  const customerIds = customers.map((row) => String(row.id));

  const [employeesResult, areasResult, linesResult, transfersResult] = await Promise.all([
    hrIds.length
      ? supabase.from("employees").select("hr_id, full_name").in("hr_id", hrIdQueryKeys(hrIds))
      : Promise.resolve({ data: [] as unknown[] }),
    areaIds.length
      ? supabase.from("areas").select("id, code, name").in("id", areaIds)
      : Promise.resolve({ data: [] as unknown[] }),
    lineIds.length
      ? supabase.from("lines").select("id, name").in("id", lineIds)
      : Promise.resolve({ data: [] as unknown[] }),
    supabase
      .from("marketing_customer_direct_order_transfers")
      .select("id, customer_id, status, transferred_at, transferred_by_hr_id, direct_order_validation_id")
      .eq("status", "transferred")
      .in("customer_id", customerIds),
  ]);

  const employeeName = new Map(
    ((employeesResult.data ?? []) as Array<Record<string, unknown>>).map((row) => [
      hrNameKey(String(row.hr_id)) ?? String(row.hr_id),
      text(row, "full_name"),
    ]),
  );
  const areaName = new Map(
    ((areasResult.data ?? []) as Array<Record<string, unknown>>).map((row) => [
      Number(row.id),
      text(row, "name") ?? text(row, "code"),
    ]),
  );
  const lineName = new Map(
    ((linesResult.data ?? []) as Array<Record<string, unknown>>).map((row) => [Number(row.id), text(row, "name")]),
  );

  // The transfer read is the one join in this batch whose failure would MISLEAD rather than merely
  // blank a column: every row would come back `transfer: null`, so the register would state that
  // customers already handed to Direct Orders are still waiting, and offer to transfer them again.
  // A missing name is a gap the reader can see; a wrong status is not.
  const transfersError = (transfersResult as { error?: { message?: string } }).error;
  if (transfersError) {
    throw new Error(
      `Could not read the Direct Order transfer history, so this register cannot say which customers were already handed over. (${transfersError.message ?? "unknown error"})`,
    );
  }
  const transfers = (transfersResult.data ?? []) as Array<Record<string, unknown>>;
  // The transferring admin's name needs one more lookup; the ids are usually a handful.
  const transferHrIds = [...new Set(transfers.map((row) => text(row, "transferred_by_hr_id")).filter(Boolean))] as string[];
  if (transferHrIds.length) {
    const { data } = await supabase
      .from("employees")
      .select("hr_id, full_name")
      .in("hr_id", hrIdQueryKeys(transferHrIds));
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      employeeName.set(hrNameKey(String(row.hr_id)) ?? String(row.hr_id), text(row, "full_name"));
    }
  }

  const validationIds = transfers
    .map((row) => text(row, "direct_order_validation_id"))
    .filter((value): value is string => Boolean(value));
  const validationStatus = new Map<string, string>();
  if (validationIds.length) {
    const { data } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("id, status")
      .in("id", validationIds);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      validationStatus.set(String(row.id), String(row.status ?? "pending"));
    }
  }

  const transferByCustomer = new Map(transfers.map((row) => [String(row.customer_id), row]));

  // Duplicate detection is name-based and computed across the WHOLE validated set in memory —
  // cheap at this size, and it catches the cross-rep case a per-rep screen structurally cannot:
  // production currently has one doctor captured separately by two different reps.
  const nameCounts = new Map<string, number>();
  for (const row of customers) {
    const key = (text(row, "normalized_name") ?? text(row, "display_name") ?? "").toLowerCase();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const rows: ValidatedCustomerListRow[] = customers.map((row) => {
    const transfer = transferByCustomer.get(String(row.id));
    const nameKey = (text(row, "normalized_name") ?? text(row, "display_name") ?? "").toLowerCase();
    const ownerHrId = text(row, "owner_hr_id");
    const managerHrId = text(row, "manager_hr_id");
    const areaId = num(row, "area_id");
    const lineId = num(row, "line_id");

    return {
      areaName: areaId !== null ? areaName.get(areaId) ?? null : null,
      createdAt: String(row.created_at),
      customerCode: text(row, "customer_code"),
      customerType: text(row, "customer_type"),
      displayName: text(row, "display_name"),
      duplicateCount: Math.max(0, (nameCounts.get(nameKey) ?? 1) - 1),
      evidenceStatus: text(row, "evidence_status"),
      governorate: text(row, "extracted_governorate_name"),
      id: String(row.id),
      lineName: lineId !== null ? lineName.get(lineId) ?? null : null,
      managerHrId,
      managerName: hrNameFrom(employeeName, managerHrId),
      ownerHrId,
      ownerName: hrNameFrom(employeeName, ownerHrId),
      transfer: transfer
        ? {
            directOrderValidationStatus: text(transfer, "direct_order_validation_id")
              ? validationStatus.get(String(transfer.direct_order_validation_id)) ?? null
              : null,
            id: String(transfer.id),
            status: String(transfer.status) as ValidatedCustomerTransferStatus,
            transferredAt: String(transfer.transferred_at),
            transferredByHrId: String(transfer.transferred_by_hr_id),
            transferredByName: hrNameFrom(employeeName, String(transfer.transferred_by_hr_id)),
          }
        : null,
      validatedAt: text(row, "validated_at"),
      validationStatus: String(row.validation_status),
    };
  });

  return {
    rows,
    summary: {
      owners: new Set(rows.map((row) => row.ownerHrId).filter(Boolean)).size,
      total: rows.length,
      transferred: rows.filter((row) => row.transfer).length,
    },
  };
}

export type ValidatedCustomerDetail = {
  customer: ValidatedCustomerListRow & {
    otherTypeDescription: string | null;
    regionName: string | null;
    extractedAreaName: string | null;
    capturedAddress: string | null;
    capturedLatitude: number | null;
    capturedLongitude: number | null;
    capturedAccuracyMeters: number | null;
    capturedAt: string | null;
    evidencePhotoName: string | null;
    evidencePhotoCapturedAt: string | null;
    validationNotes: string | null;
    validatedByHrId: string | null;
    validatedByName: string | null;
    createdByHrId: string | null;
    createdByName: string | null;
  };
  contacts: Array<{
    id: string;
    contactName: string | null;
    specialty: string | null;
    mobileNumber: string | null;
    crmCode: string | null;
    notes: string | null;
  }>;
  pharmacies: Array<{
    id: string;
    displayName: string | null;
    pharmacyCode: string | null;
    capturedAddress: string | null;
    capturedLatitude: number | null;
    capturedLongitude: number | null;
    capturedAt: string | null;
    evidenceStatus: string | null;
    validationStatus: string | null;
    distributorCode: string | null;
    distributorCustomerCode: string | null;
    distributorName: string | null;
    referenceStatus: string | null;
    photoUrl: string | null;
  }>;
  /** Short-lived signed URL for the customer's own storefront photo. */
  photoUrl: string | null;
  geography: {
    marketingAreaCode: string | null;
    marketingAreaName: string | null;
    resolvedAreaCode: string | null;
    resolvedRegionCode: string | null;
    /** Where area/region/brick came from — the page labels a guess as a guess. */
    resolvedFrom: ResolvedDirectOrderGeography["source"];
    suggestedBrickId: string | null;
    suggestedBrickName: string | null;
    suggestedBrickDistanceKm: number | null;
    /** True when the brick is the master database's answer or the evidence photo's own pin — never a nearest-centroid guess. */
    brickIsFromMaster: boolean;
  };
  completeness: ValidatedCustomerCompleteness;
  transfer:
    | (ValidatedCustomerListRow["transfer"] & {
        revertedAt: string | null;
        revertedByHrId: string | null;
        revertReason: string | null;
        directOrderPharmacyId: string | null;
        phoenixPharmacyCode: string | null;
        canRevert: boolean;
        cannotRevertReason: string | null;
      })
    | null;
  /** Whether THIS viewer may transfer or revert. False for the view-only SFE Manager. */
  viewerCanTransfer: boolean;
};

/**
 * Everything about one validated customer, on one page — the owner's "all details in it. His
 * brick, his area, the location, the photo, evidence, everything."
 */
export async function getValidatedMarketingCustomerDetail(
  access: AccessContext,
  customerId: string,
): Promise<ValidatedCustomerDetail> {
  assertValidatedCustomerRegisterAccess(access);
  return assembleValidatedMarketingCustomerDetail(customerId, canTransferValidatedCustomers(access));
}

/**
 * Gate-free assembly of one customer's full validation dossier. The CALLER owns authorization —
 * either the Super-Admin/SFE register gate (getValidatedMarketingCustomerDetail) or a marketing
 * approver holding the request that stands on this customer
 * (getValidatedMarketingCustomerDetailForApprover). `viewerCanTransfer` is passed IN, not derived
 * from access here, because the transfer/revert action belongs ONLY to the register — the approver
 * path always passes false, so its dossier is strictly read-only.
 */
async function assembleValidatedMarketingCustomerDetail(
  customerId: string,
  viewerCanTransfer: boolean,
): Promise<ValidatedCustomerDetail> {
  const id = String(customerId ?? "").trim();
  if (!id) throw validationError("A customer id is required.");
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  if (!isUuid(id)) throw notFoundError("That customer is not on file.");

  const supabase = getSupabaseAdmin();
  const { data: customerData, error } = await supabase
    .from("marketing_customers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!customerData) throw notFoundError("That customer is not on file.");

  const customer = customerData as CustomerRow;
  const areaId = num(customer, "area_id");
  const lineId = num(customer, "line_id");

  const [contactsResult, linksResult, areaResult, lineResult, transferResult, photo] = await Promise.all([
    supabase.from("marketing_customer_contacts").select("*").eq("customer_id", id).neq("active", false),
    supabase.from("marketing_customer_pharmacies").select("*").eq("customer_id", id).neq("active", false),
    areaId !== null
      ? supabase.from("areas").select("id, code, name").eq("id", areaId).maybeSingle()
      : Promise.resolve({ data: null }),
    lineId !== null
      ? supabase.from("lines").select("id, name").eq("id", lineId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("marketing_customer_direct_order_transfers")
      .select("*")
      .eq("customer_id", id)
      .order("transferred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    loadMarketingEvidencePhoto({ entityId: id, entityType: "customer", supabase }),
  ]);

  // Same reasoning as the register: this is the read that decides whether the detail page shows
  // "Transfer to Direct Orders" or "Revert this transfer". Swallowed, it fails open — the page would
  // offer to transfer a customer that is already on the Direct Order desk, and would hide the revert
  // the owner specifically asked for.
  const transferReadError = (transferResult as { error?: { message?: string } }).error;
  if (transferReadError) {
    throw new Error(
      `Could not read this customer's Direct Order transfer history, so the page cannot say whether it was already handed over. (${transferReadError.message ?? "unknown error"})`,
    );
  }

  const areaRow = areaResult.data as Record<string, unknown> | null;
  const lineRow = lineResult.data as Record<string, unknown> | null;
  const marketingAreaCode = text(areaRow, "code");

  const links = (linksResult.data ?? []) as Array<Record<string, unknown>>;
  const pharmacyIds = [...new Set(links.map((row) => String(row.pharmacy_id)).filter(Boolean))];
  const codeIds = [...new Set(links.map((row) => text(row, "distributor_code_id")).filter(Boolean))] as string[];

  const [pharmacyResult, codeResult, pharmacyPhotos] = await Promise.all([
    pharmacyIds.length
      ? supabase.from("marketing_pharmacies").select("*").in("id", pharmacyIds)
      : Promise.resolve({ data: [] as unknown[] }),
    codeIds.length
      ? supabase.from("marketing_pharmacy_distributor_codes").select("*").in("id", codeIds)
      : Promise.resolve({ data: [] as unknown[] }),
    pharmacyIds.length
      ? Promise.all(
          pharmacyIds.map(async (pharmacyId) => ({
            id: pharmacyId,
            photo: await loadMarketingEvidencePhoto({
              entityId: pharmacyId,
              entityType: "pharmacy",
              supabase,
            }),
          })),
        )
      : Promise.resolve([] as Array<{ id: string; photo: { signedUrl: string } | null }>),
  ]);

  const codeRows = (codeResult.data ?? []) as Array<Record<string, unknown>>;
  const codeById = new Map(codeRows.map((row) => [String(row.id), row]));
  const distributorIds = [...new Set(codeRows.map((row) => text(row, "distributor_id")).filter(Boolean))] as string[];
  const distributorName = new Map<string, string | null>();
  if (distributorIds.length) {
    const { data } = await supabase.from("marketing_distributors").select("id, display_name").in("id", distributorIds);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      distributorName.set(String(row.id), text(row, "display_name"));
    }
  }

  const photoByPharmacy = new Map(
    (pharmacyPhotos as Array<{ id: string; photo: { signedUrl: string } | null }>).map((entry) => [
      entry.id,
      entry.photo?.signedUrl ?? null,
    ]),
  );

  const pharmacyRows = (pharmacyResult.data ?? []) as Array<Record<string, unknown>>;
  const linkByPharmacy = new Map(links.map((row) => [String(row.pharmacy_id), row]));

  const pharmacies = pharmacyRows.map((row) => {
    const link = linkByPharmacy.get(String(row.id));
    const codeRow = link ? codeById.get(String(link.distributor_code_id ?? "")) : undefined;
    return {
      capturedAddress: text(row, "captured_address"),
      capturedAt: text(row, "captured_at"),
      capturedLatitude: num(row, "captured_latitude"),
      capturedLongitude: num(row, "captured_longitude"),
      displayName: text(row, "display_name"),
      // The MAPPED pair is the master database's own answer and is what Direct Orders keys on.
      // `distributor_pharmacy_code` is only what the rep typed, so it is the fallback, never the
      // first choice — a code that never matched has no mapped value at all.
      distributorCode: codeRow ? text(codeRow, "mapped_distributor_code") : null,
      distributorCustomerCode: codeRow
        ? text(codeRow, "mapped_customer_code") ?? text(codeRow, "distributor_pharmacy_code")
        : null,
      distributorName: codeRow
        ? distributorName.get(String(codeRow.distributor_id ?? "")) ?? null
        : null,
      evidenceStatus: text(row, "evidence_status"),
      id: String(row.id),
      pharmacyCode: text(row, "pharmacy_code"),
      photoUrl: photoByPharmacy.get(String(row.id)) ?? null,
      referenceStatus: codeRow ? text(codeRow, "reference_status") : null,
      validationStatus: text(row, "validation_status"),
    };
  });

  // The first linked pharmacy's code row is what a transfer would actually carry across, so the
  // page must resolve geography from exactly the same input the transfer will use.
  const primaryLink = links[0];
  const primaryCodeRow = primaryLink ? codeById.get(String(primaryLink.distributor_code_id ?? "")) : undefined;
  const resolvedBase = await resolveDirectOrderGeography({
    mappedAreaCode: primaryCodeRow ? text(primaryCodeRow, "mapped_area_code") : null,
    mappedBrickId: primaryCodeRow ? text(primaryCodeRow, "mapped_brick_id") : null,
    mappedRegionCode: primaryCodeRow ? text(primaryCodeRow, "mapped_region_code") : null,
    marketingAreaCode,
  });
  // The photo's own pin outranks the inherited marketing area AND the master's code answer (owner, 2026-10-18).
  const { geography: geographyBase, pinBrick } = applyPhotoPinTerritory(
    resolvedBase,
    await readPinTerritory(
      num(customer, "captured_latitude"),
      num(customer, "captured_longitude"),
      "Could not read the brick map, so the page cannot say which territory this customer's photo puts it in. Reload in a minute.",
    ),
  );
  // Only fall back to a geometric guess when neither the master nor the photo had a brick to give.
  const brick = pinBrick
    ? pinBrick
    : geographyBase.brickId
      ? { brickId: geographyBase.brickId, brickName: null, distanceKm: null }
      : await suggestBrickForCapture({
          areaCode: geographyBase.areaCode,
          latitude: num(customer, "captured_latitude"),
          longitude: num(customer, "captured_longitude"),
        });

  const contacts = ((contactsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    contactName: text(row, "contact_name"),
    crmCode: text(row, "crm_code"),
    id: String(row.id),
    mobileNumber: text(row, "mobile_number"),
    notes: text(row, "notes"),
    specialty: text(row, "specialty"),
  }));

  const { count: duplicateCount } = await supabase
    .from("marketing_customers")
    .select("id", { count: "exact", head: true })
    .eq("normalized_name", text(customer, "normalized_name") ?? "")
    .neq("id", id)
    .neq("active", false);

  const primaryPharmacy = pharmacies[0] ?? null;
  const completeness = buildValidatedCustomerCompleteness({
    capturedAccuracyMeters: num(customer, "captured_accuracy_meters"),
    capturedAddress: text(customer, "captured_address"),
    capturedLatitude: num(customer, "captured_latitude"),
    capturedLongitude: num(customer, "captured_longitude"),
    contactMobile: contacts.find((c) => c.mobileNumber)?.mobileNumber ?? null,
    contactName: contacts.find((c) => c.contactName)?.contactName ?? null,
    customerType: text(customer, "customer_type"),
    displayName: text(customer, "display_name"),
    distributorCode: primaryPharmacy?.distributorCode ?? null,
    distributorCustomerCode: primaryPharmacy?.distributorCustomerCode ?? null,
    duplicateCount: duplicateCount ?? 0,
    evidenceStatus: text(customer, "evidence_status"),
    hasEvidencePhoto: Boolean(photo?.signedUrl),
    linkedPharmacyCount: pharmacies.length,
    marketingAreaName: text(areaRow, "name"),
    resolvedAreaCode: geographyBase.areaCode,
  });

  const hrIds = [
    text(customer, "owner_hr_id"),
    text(customer, "manager_hr_id"),
    text(customer, "validated_by_hr_id"),
    text(customer, "created_by_hr_id"),
  ].filter((value): value is string => Boolean(value));
  const employeeName = new Map<string, string | null>();
  if (hrIds.length) {
    const { data } = await supabase
      .from("employees")
      .select("hr_id, full_name")
      .in("hr_id", hrIdQueryKeys([...new Set(hrIds)]));
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      employeeName.set(hrNameKey(String(row.hr_id)) ?? String(row.hr_id), text(row, "full_name"));
    }
  }

  const transferRow = transferResult.data as Record<string, unknown> | null;
  let transfer: ValidatedCustomerDetail["transfer"] = null;
  if (transferRow) {
    const validationId = text(transferRow, "direct_order_validation_id");
    let directOrderValidationStatus: string | null = null;
    let phoenixPharmacyCode: string | null = null;
    if (validationId) {
      const { data } = await supabase
        .from("direct_order_pharmacy_validations")
        .select("status")
        .eq("id", validationId)
        .maybeSingle();
      directOrderValidationStatus = data ? String((data as Record<string, unknown>).status ?? "pending") : null;
    }
    const pharmacyId = text(transferRow, "direct_order_pharmacy_id");
    if (pharmacyId) {
      const { data } = await supabase
        .from("direct_order_pharmacies")
        .select("phoenix_pharmacy_code")
        .eq("id", pharmacyId)
        .maybeSingle();
      phoenixPharmacyCode = data ? text(data as Record<string, unknown>, "phoenix_pharmacy_code") : null;
    }

    const isLive = String(transferRow.status) === "transferred";
    const decided = Boolean(directOrderValidationStatus && directOrderValidationStatus !== "pending");
    const transferredBy = String(transferRow.transferred_by_hr_id);
    const transferredByKey = hrNameKey(transferredBy) ?? transferredBy;
    if (!employeeName.has(transferredByKey)) {
      const { data } = await supabase
        .from("employees")
        .select("full_name")
        .in("hr_id", hrIdQueryKeys([transferredBy]))
        .limit(1)
        .maybeSingle();
      employeeName.set(transferredByKey, data ? text(data as Record<string, unknown>, "full_name") : null);
    }

    transfer = {
      canRevert: isLive && !decided,
      cannotRevertReason: !isLive
        ? "This transfer has already been reverted."
        : decided
          ? `Direct Orders has already decided this validation (${directOrderValidationStatus}). Reverting now would undo their decision, so it has to be handled on the Direct Order desk.`
          : null,
      directOrderPharmacyId: pharmacyId,
      directOrderValidationStatus,
      id: String(transferRow.id),
      phoenixPharmacyCode,
      revertReason: text(transferRow, "revert_reason"),
      revertedAt: text(transferRow, "reverted_at"),
      revertedByHrId: text(transferRow, "reverted_by_hr_id"),
      status: String(transferRow.status) as ValidatedCustomerTransferStatus,
      transferredAt: String(transferRow.transferred_at),
      transferredByHrId: transferredBy,
      transferredByName: employeeName.get(transferredByKey) ?? null,
    };
  }

  const ownerHrId = text(customer, "owner_hr_id");
  const managerHrId = text(customer, "manager_hr_id");
  const validatedByHrId = text(customer, "validated_by_hr_id");
  const createdByHrId = text(customer, "created_by_hr_id");

  return {
    completeness,
    contacts,
    customer: {
      areaName: text(areaRow, "name"),
      capturedAccuracyMeters: num(customer, "captured_accuracy_meters"),
      capturedAddress: text(customer, "captured_address"),
      capturedAt: text(customer, "captured_at"),
      capturedLatitude: num(customer, "captured_latitude"),
      capturedLongitude: num(customer, "captured_longitude"),
      createdAt: String(customer.created_at),
      createdByHrId,
      createdByName: hrNameFrom(employeeName, createdByHrId),
      customerCode: text(customer, "customer_code"),
      customerType: text(customer, "customer_type"),
      displayName: text(customer, "display_name"),
      duplicateCount: duplicateCount ?? 0,
      evidencePhotoCapturedAt: text(customer, "evidence_photo_captured_at"),
      evidencePhotoName: text(customer, "evidence_photo_name"),
      evidenceStatus: text(customer, "evidence_status"),
      extractedAreaName: text(customer, "extracted_area_name"),
      governorate: text(customer, "extracted_governorate_name"),
      id: String(customer.id),
      lineName: text(lineRow, "name"),
      managerHrId,
      managerName: hrNameFrom(employeeName, managerHrId),
      otherTypeDescription: text(customer, "other_type_description"),
      ownerHrId,
      ownerName: hrNameFrom(employeeName, ownerHrId),
      regionName: text(customer, "region_name"),
      transfer: transfer
        ? {
            directOrderValidationStatus: transfer.directOrderValidationStatus,
            id: transfer.id,
            status: transfer.status,
            transferredAt: transfer.transferredAt,
            transferredByHrId: transfer.transferredByHrId,
            transferredByName: transfer.transferredByName,
          }
        : null,
      validatedAt: text(customer, "validated_at"),
      validatedByHrId,
      validatedByName: hrNameFrom(employeeName, validatedByHrId),
      validationNotes: text(customer, "validation_notes"),
      validationStatus: String(customer.validation_status),
    },
    geography: {
      brickIsFromMaster: Boolean(geographyBase.brickId),
      marketingAreaCode,
      marketingAreaName: text(areaRow, "name"),
      resolvedAreaCode: geographyBase.areaCode,
      resolvedFrom: geographyBase.source,
      resolvedRegionCode: geographyBase.regionCode,
      suggestedBrickDistanceKm: brick.distanceKm,
      suggestedBrickId: brick.brickId,
      suggestedBrickName: brick.brickName,
    },
    pharmacies,
    photoUrl: photo?.signedUrl ?? null,
    transfer,
    viewerCanTransfer,
  };
}

/**
 * The same full dossier, for the marketing APPROVER currently holding a request that stands on an
 * already-validated customer (owner ask, 2026-09-22 — the badge's "jump to the venue's full
 * validation data": his brick, his area, the location, the photo, the distributor codes,
 * everything). Authorization is INHERITED from getMarketingRequestDecisionSummary — the exact gate
 * that already guards the approver window this dossier is reached from. It throws unless the caller
 * holds the request's current, still-pending step and is not deciding their own request, so this
 * exposes nothing the approver could not already read on the request itself. It only adds the
 * linked pharmacies, distributor codes and completeness the inline panel omits. The transfer action
 * is NEVER offered here (viewerCanTransfer: false); the transfer/revert POST stays register-only.
 */
export async function getValidatedMarketingCustomerDetailForApprover(
  access: AccessContext,
  requestId: string,
): Promise<ValidatedCustomerDetail> {
  // Authorize against the request itself. Throws (forbidden/conflict) for anyone who is not the
  // current holder of this request's pending step — identical tightness to the approver window.
  const summary = await getMarketingRequestDecisionSummary(requestId, "approve", access);
  const customerId = await resolveApproverRequestCustomerId(summary.requestId);
  if (!customerId) {
    throw notFoundError("This request is not linked to a validated customer.");
  }
  return assembleValidatedMarketingCustomerDetail(customerId, false);
}

/** The customer this request stands on. Called only AFTER the summary has authorized the caller. */
async function resolveApproverRequestCustomerId(requestId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_requests")
    .select("customer_id")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  return (data as { customer_id?: string | null } | null)?.customer_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The transfer, and its undo
// ─────────────────────────────────────────────────────────────────────────────

/** Phoenix code for a pharmacy this module mints. Mirrors the `PH-` shape used elsewhere. */
function buildTransferredPharmacyCode(customerCode: string | null, customerId: string): string {
  const seed = (customerCode ?? customerId).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `PHX-MT-${seed.slice(-10) || customerId.replace(/-/g, "").slice(-10).toUpperCase()}`;
}

/**
 * Who a transferred venue belongs to on the Direct Order side. "My venues" lists only the venues a
 * rep CREATED, so a venue stamped with the admin who clicked Transfer is invisible to the rep who
 * stood in front of the shop (found 2026-10-17: a nursery transferred by the owner never showed in
 * the capturing rep's list). The capturer owns it; `validated_by_hr_id` is NOT used because it is
 * the desk reviewer on a `sfe_validated` row and NULL on every `system_validated` one. The admin
 * who made the transfer owns it only when the capture record names nobody.
 */
export function resolveTransferredVenueOwnerHrId(
  customer: { created_by_hr_id?: unknown; owner_hr_id?: unknown } | null | undefined,
  actorHrId: string,
): string {
  for (const candidate of [customer?.created_by_hr_id, customer?.owner_hr_id]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return hrIdForStorage(value) ?? value;
  }
  return hrIdForStorage(actorHrId) ?? actorHrId;
}

/**
 * Hand a validated marketing customer to the Direct Order validation desk.
 *
 * What it creates, and why in this shape:
 *
 *   • a `direct_order_pharmacies` row, `entry_source = 'marketing_transfer'`, `verification_status
 *     = 'pending_review'`, `trust_state = 'provisional'`. Pending and provisional because Direct
 *     Orders has NOT validated it yet — the owner's instruction is that it goes there "to be
 *     validated also there". Marking it verified on arrival would be the module claiming a decision
 *     that belongs to the desk, and would skip the probation the Direct Order design deliberately
 *     puts on a shop the distributor sheets do not know.
 *
 *   • a `direct_order_pharmacy_validations` row, status `pending`, pre-filled with everything the
 *     rep already captured — name, address, contact, the GPS fix, and the marketing evidence photo
 *     by reference. `request_id` is NULL: every validation on record so far hangs off a held order,
 *     but the column is nullable and a transfer is precisely the case that has no order behind it.
 *     The desk sees a fully-evidenced row with nothing to re-collect.
 *
 * The photo is referenced, NOT copied: `storage_bucket` points at `marketing-evidence` and
 * `storage_path` at the file already there. Copying bytes would double the storage for no gain and
 * create a second image that could drift from the first.
 */
export async function transferValidatedCustomerToDirectOrders(
  access: AccessContext,
  input: { customerId: string; notes?: string | null },
): Promise<{ transferId: string; directOrderPharmacyId: string; phoenixPharmacyCode: string }> {
  assertValidatedCustomerTransferAccess(access);

  const customerId = String(input.customerId ?? "").trim();
  if (!customerId) throw validationError("A customer id is required.");

  const actorHrId = access.hrId;
  if (!actorHrId) throw forbiddenError("Forbidden: a transfer must name the admin who made it.");

  const supabase = getSupabaseAdmin();

  const { data: customerData, error: customerError } = await supabase
    .from("marketing_customers")
    .select("*")
    .eq("id", customerId)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customerData) throw notFoundError("That customer is not on file.");
  const customer = customerData as CustomerRow;

  if (!VALIDATED_STATUSES.includes(String(customer.validation_status) as (typeof VALIDATED_STATUSES)[number])) {
    throw validationError(
      "Only a validated customer can be transferred. This one is still pending validation in Marketing.",
    );
  }

  // Refusal #1 of 2. Not a completeness judgement — an integrity one. A second live transfer
  // would mint the same shop twice on the Direct Order desk, which is the duplicate problem this
  // feature exists to reduce. The partial unique index enforces it in the database too; this
  // check exists to return a sentence instead of a constraint violation.
  const { data: existingTransfer, error: existingTransferError } = await supabase
    .from("marketing_customer_direct_order_transfers")
    .select("id, transferred_at")
    .eq("customer_id", customerId)
    .eq("status", "transferred")
    .maybeSingle();
  // Discarding this error made the refusal fail OPEN: any read failure looked exactly like "no
  // previous transfer", so the sentence above would be skipped and the caller would fall through to
  // a raw unique-index violation — the very thing this check exists to replace.
  if (existingTransferError) {
    throw new Error(
      `Could not check whether this customer is already on the Direct Order desk, so nothing was transferred. (${existingTransferError.message})`,
    );
  }
  if (existingTransfer) {
    throw validationError(
      "This customer is already on the Direct Order validation desk. Revert that transfer first if you need to send it again.",
    );
  }

  const { data: linkData } = await supabase
    .from("marketing_customer_pharmacies")
    .select("*")
    .eq("customer_id", customerId)
    .neq("active", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const link = linkData as Record<string, unknown> | null;

  let marketingPharmacy: Record<string, unknown> | null = null;
  let distributorCode: string | null = null;
  let distributorCustomerCode: string | null = null;
  let codeRow: Record<string, unknown> | null = null;
  if (link) {
    const { data: pharmacyData } = await supabase
      .from("marketing_pharmacies")
      .select("*")
      .eq("id", String(link.pharmacy_id))
      .maybeSingle();
    marketingPharmacy = (pharmacyData as Record<string, unknown> | null) ?? null;

    const codeId = text(link, "distributor_code_id");
    if (codeId) {
      const { data: codeData } = await supabase
        .from("marketing_pharmacy_distributor_codes")
        .select("*")
        .eq("id", codeId)
        .maybeSingle();
      codeRow = (codeData as Record<string, unknown> | null) ?? null;
      // Mapped first — that is the master database's answer and the pair Direct Orders keys on.
      distributorCode = realDistributorValue(text(codeRow, "mapped_distributor_code"));
      distributorCustomerCode =
        realDistributorValue(text(codeRow, "mapped_customer_code")) ??
        realDistributorValue(text(codeRow, "distributor_pharmacy_code"));
    }
  }

  const areaId = num(customer, "area_id");
  let marketingAreaCode: string | null = null;
  if (areaId !== null) {
    const { data } = await supabase.from("areas").select("code").eq("id", areaId).maybeSingle();
    marketingAreaCode = data ? text(data as Record<string, unknown>, "code") : null;
  }
  const resolvedGeography = await resolveDirectOrderGeography({
    mappedAreaCode: text(codeRow, "mapped_area_code"),
    mappedBrickId: text(codeRow, "mapped_brick_id"),
    mappedRegionCode: text(codeRow, "mapped_region_code"),
    marketingAreaCode,
  });

  const latitude = num(customer, "captured_latitude") ?? num(marketingPharmacy, "captured_latitude");
  const longitude = num(customer, "captured_longitude") ?? num(marketingPharmacy, "captured_longitude");
  // THE PHOTO IS THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18): a venue the master did not place
  // is filed where its photo's pin falls, not in the area the marketing label inherited.
  const { geography, pinBrick, overrode } = applyPhotoPinTerritory(
    resolvedGeography,
    await readPinTerritory(
      latitude,
      longitude,
      "Could not read the brick map, so the territory this customer's photo falls in could not be checked and nothing was transferred. Try again in a minute.",
    ),
  );
  // Only guess a brick when neither the photo nor the master had one to give.
  const brick = pinBrick
    ? pinBrick
    : geography.brickId
      ? { brickId: geography.brickId, brickName: null, distanceKm: null }
      : await suggestBrickForCapture({ areaCode: geography.areaCode, latitude, longitude });

  const pharmacyName =
    text(marketingPharmacy, "display_name") ?? text(customer, "display_name") ?? "Transferred customer";
  const address = text(customer, "captured_address") ?? text(marketingPharmacy, "captured_address");

  const { data: contactData } = await supabase
    .from("marketing_customer_contacts")
    .select("contact_name")
    .eq("customer_id", customerId)
    .neq("active", false)
    .not("contact_name", "is", null)
    .limit(1)
    .maybeSingle();
  const doctorName = contactData ? text(contactData as Record<string, unknown>, "contact_name") : null;

  const phoenixPharmacyCode = buildTransferredPharmacyCode(text(customer, "customer_code"), customerId);

  const { data: pharmacyInsert, error: pharmacyError } = await supabase
    .from("direct_order_pharmacies")
    .insert({
      active: true,
      area_code: geography.areaCode,
      brick_id: brick.brickId,
      created_by_hr_id: resolveTransferredVenueOwnerHrId(customer, actorHrId),
      // `distributor_code` and `distributor_customer_code` on THIS table are dead columns: nothing
      // in the app or the database reads either, and both are empty on every row. Writing the pair
      // here would also assert a link that the block below deliberately REFUSES to make when the
      // pair is absent from the master map. The link lives in
      // `direct_order_pharmacy_distributor_codes`, written a few lines down.
      doctor_name: doctorName,
      entry_source: "marketing_transfer",
      pharmacy_address: address,
      pharmacy_name: pharmacyName,
      phoenix_pharmacy_code: phoenixPharmacyCode,
      region_code: geography.regionCode,
      trust_state: "provisional",
      verification_status: "pending_review",
    })
    .select("id, phoenix_pharmacy_code")
    .single();
  if (pharmacyError) throw pharmacyError;
  const directOrderPharmacyId = String((pharmacyInsert as Record<string, unknown>).id);

  // A pharmacy with NO row in `direct_order_pharmacy_distributor_codes` is invisible to every
  // distributor-scoped search. `phx_search_direct_order_customers` left-joins that table and then
  // tests `c.distributor_code = p_distributor_code` in its WHERE, which collapses the join to an
  // inner one the moment a rep picks a distributor — and the rep almost always picks one first.
  // So a transfer that knows the real pair has to record it here, exactly as manual registration
  // does, or the shop lands on the Direct Order side and still cannot be found. (Learned on
  // حضانه النيل, 2026-08-22: transferred cleanly, then invisible under both overseas and sofico.)
  //
  // The pair must exist in the master map — same rule the manual path enforces, because matching to
  // something that is not there would just relocate the phantom. When it does not exist we leave
  // the pharmacy uncoded and provisional, which is the honest state: the desk attaches the code
  // once the distributor actually issues one.
  if (distributorCode && distributorCustomerCode) {
    const { data: mapRow } = await supabase
      .from("source_of_sales_customer_map")
      .select("brick_id, area_code, region_code")
      .eq("active", true)
      .eq("distributor_code", distributorCode)
      .eq("customer_code", distributorCustomerCode)
      .maybeSingle();
    if (mapRow) {
      const geo = mapRow as Record<string, unknown>;
      const { error: linkError } = await supabase.from("direct_order_pharmacy_distributor_codes").insert({
        customer_code: distributorCustomerCode,
        distributor_code: distributorCode,
        mapped_area_code: text(geo, "area_code"),
        mapped_brick_id: text(geo, "brick_id"),
        mapped_region_code: text(geo, "region_code"),
        pharmacy_id: directOrderPharmacyId,
      });
      // 23505 = the code already belongs to another pharmacy. The transfer still stands; this shop
      // is left uncoded rather than stealing a code off an existing record.
      if (linkError && String((linkError as { code?: string }).code ?? "") !== "23505") throw linkError;
    }
  }

  // Carry the marketing photo by REFERENCE so the Direct Order desk can open the very image the
  // rep took, without a second copy existing.
  const { data: evidenceRow } = await supabase
    .from("marketing_evidence_files")
    .select("storage_bucket, storage_path, captured_address, captured_accuracy_meters")
    .eq("entity_type", "customer")
    .eq("entity_id", customerId)
    .eq("evidence_type", "location_photo")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const evidence = evidenceRow as Record<string, unknown> | null;

  const reasonParts = [
    `Transferred from Marketing customer validation by ${actorHrId}.`,
    `Marketing status: ${String(customer.validation_status)}.`,
  ];
  if (!geography.areaCode) {
    reasonParts.push(
      `WARNING: the marketing area "${marketingAreaCode ?? "unknown"}" does not map to a Direct Order area, so this pharmacy carries no area code.`,
    );
  }
  if (brick.brickId && geography.source === "master_code") {
    reasonParts.push(`Brick ${brick.brickId} and area ${geography.areaCode} come from the Phoenix master database.`);
  } else if (brick.brickId && geography.source === "photo_pin") {
    reasonParts.push(
      `Brick ${brick.brickId} and area ${geography.areaCode} come from the evidence photo's own GPS pin (${brick.distanceKm} km from that brick's centre) — the photo is the primary source of trust, not the marketing area.`,
    );
    if (overrode) {
      reasonParts.push(
        `The distributor code's master record named area ${overrode.areaCode ?? "none"} / brick ${overrode.brickId ?? "none"}; the photo's pin outranks it (owner ruling 2026-10-18).`,
      );
    }
  } else if (brick.brickId && brick.distanceKm !== null) {
    reasonParts.push(
      `Brick ${brick.brickId} is a SUGGESTION only — nearest centroid, ${brick.distanceKm} km from the captured pin. Confirm it before trusting the territory.`,
    );
  } else if (!brick.brickId) {
    reasonParts.push("No brick could be resolved for this pharmacy.");
  }

  const { data: validationInsert, error: validationError_ } = await supabase
    .from("direct_order_pharmacy_validations")
    .insert({
      captured_accuracy_meters: num(customer, "captured_accuracy_meters"),
      captured_address: text(customer, "captured_address"),
      captured_at: text(customer, "captured_at"),
      captured_latitude: latitude,
      captured_longitude: longitude,
      claimed_address: address,
      claimed_doctor_name: doctorName,
      claimed_pharmacy_name: pharmacyName,
      claimed_reason: reasonParts.join(" "),
      matched_customer_code: distributorCustomerCode,
      matched_distributor_code: distributorCode,
      pharmacy_id: directOrderPharmacyId,
      request_id: null,
      requested_at: new Date().toISOString(),
      requested_by_hr_id: hrIdForStorage(actorHrId),
      requester_area_code: geography.areaCode,
      status: "pending",
      storage_bucket: evidence ? text(evidence, "storage_bucket") : null,
      storage_path: evidence ? text(evidence, "storage_path") : null,
    })
    .select("id")
    .single();
  if (validationError_) throw validationError_;
  const directOrderValidationId = String((validationInsert as Record<string, unknown>).id);

  const { data: transferInsert, error: transferError } = await supabase
    .from("marketing_customer_direct_order_transfers")
    .insert({
      created_direct_order_pharmacy: true,
      customer_id: customerId,
      direct_order_pharmacy_id: directOrderPharmacyId,
      direct_order_validation_id: directOrderValidationId,
      marketing_pharmacy_id: marketingPharmacy ? String(marketingPharmacy.id) : null,
      status: "transferred",
      transfer_notes: input.notes ? String(input.notes).trim() || null : null,
      transferred_by_hr_id: hrIdForStorage(actorHrId),
    })
    .select("id")
    .single();
  if (transferError) throw transferError;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actorHrId,
    entityId: customerId,
    entityType: "marketing_customer",
    newValues: {
      directOrderPharmacyId,
      directOrderValidationId,
      phoenixPharmacyCode,
      resolvedAreaCode: geography.areaCode,
      suggestedBrickId: brick.brickId,
    },
    oldValues: null,
    summary: `Marketing customer "${text(customer, "display_name") ?? customerId}" transferred to Direct Order validation by ${actorHrId}.`,
  });

  return {
    directOrderPharmacyId,
    phoenixPharmacyCode: String((pharmacyInsert as Record<string, unknown>).phoenix_pharmacy_code),
    transferId: String((transferInsert as Record<string, unknown>).id),
  };
}

/**
 * Undo a transfer — the owner's "have the option to revert this transfer. If I notice anything, I
 * can revert".
 *
 * NOTHING IS DELETED. The ledger row survives with both decisions on it, the Direct Order
 * validation is closed as `rejected` with a note naming the revert rather than removed, and the
 * pharmacy is deactivated only when this transfer created it. That last condition is the one worth
 * stating: if the transfer had reused a pharmacy Direct Orders already knew about, retiring it here
 * would destroy a record this module never owned.
 *
 * Refusal #2 of 2: once the Direct Order desk has DECIDED the validation — matched it to an
 * existing shop, approved it, or rejected it — the revert is refused. At that point Direct Orders
 * has acted on the record and may have rewired a held order to it; silently unwinding that from the
 * marketing side would corrupt their state. The detail page shows this as `canRevert: false` with
 * the reason, so the button is never offered in a state where it would fail.
 */
export async function revertValidatedCustomerTransfer(
  access: AccessContext,
  input: { transferId: string; reason?: string | null },
): Promise<{ reverted: true }> {
  assertValidatedCustomerTransferAccess(access);

  const transferId = String(input.transferId ?? "").trim();
  if (!transferId) throw validationError("A transfer id is required.");

  const actorHrId = access.hrId;
  if (!actorHrId) throw forbiddenError("Forbidden: a revert must name the admin who made it.");

  const supabase = getSupabaseAdmin();
  const { data: transferData, error } = await supabase
    .from("marketing_customer_direct_order_transfers")
    .select("*")
    .eq("id", transferId)
    .maybeSingle();
  if (error) throw error;
  if (!transferData) throw notFoundError("That transfer is not on file.");
  const transfer = transferData as Record<string, unknown>;

  if (String(transfer.status) !== "transferred") {
    throw validationError("That transfer has already been reverted.");
  }

  const validationId = text(transfer, "direct_order_validation_id");
  if (validationId) {
    const { data: validationRow } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("status")
      .eq("id", validationId)
      .maybeSingle();
    const status = validationRow ? String((validationRow as Record<string, unknown>).status ?? "pending") : "pending";
    if (status !== "pending") {
      throw validationError(
        `Direct Orders has already decided this validation (${status}). Reverting now would undo their decision — handle it on the Direct Order desk instead.`,
      );
    }

    await supabase
      .from("direct_order_pharmacy_validations")
      .update({
        decided_at: new Date().toISOString(),
        decided_by_hr_id: hrIdForStorage(actorHrId),
        decision_notes: `Transfer reverted from Marketing by ${actorHrId}.${
          input.reason ? ` Reason: ${String(input.reason).trim()}` : ""
        }`,
        status: "rejected",
      })
      .eq("id", validationId)
      // Guard the precondition in the WHERE too: another session could decide this row between
      // the read above and this write.
      .eq("status", "pending");
  }

  const pharmacyId = text(transfer, "direct_order_pharmacy_id");
  if (pharmacyId && transfer.created_direct_order_pharmacy === true) {
    // `direct_order_pharmacies_rejected_is_inactive` requires these two to move together.
    await supabase
      .from("direct_order_pharmacies")
      .update({ active: false, verification_status: "rejected" })
      .eq("id", pharmacyId);
  }

  const { error: updateError } = await supabase
    .from("marketing_customer_direct_order_transfers")
    .update({
      revert_reason: input.reason ? String(input.reason).trim() || null : null,
      reverted_at: new Date().toISOString(),
      reverted_by_hr_id: hrIdForStorage(actorHrId),
      status: "reverted",
    })
    .eq("id", transferId)
    .eq("status", "transferred");
  if (updateError) throw updateError;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actorHrId,
    entityId: String(transfer.customer_id),
    entityType: "marketing_customer",
    newValues: { reason: input.reason ?? null, status: "reverted", transferId },
    oldValues: { status: "transferred", transferId },
    summary: `Direct Order transfer reverted by ${actorHrId}.`,
  });

  return { reverted: true };
}
