import { hrIdLookupKeys, canonicalHrIdKey } from "@/lib/hr-id";
import { MARKETING_EVIDENCE_BUCKET } from "@/lib/marketing-requests/evidence-photo-storage";
import type { DirectOrderVenueValidationPhoto } from "@/lib/direct-orders/types";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { venueTypeLabel, normalizeVenueType } from "@/lib/venues/venue-type";

// ─────────────────────────────────────────────────────────────────────────────
// Every validation photo on a direct-order venue, for the approval window (owner, 2026-10-21:
// "make 100% sure that the SFE and managerial approvers review in the approval window the
// validation photo of pharmacy and customer with its 100% full detailed data — never hide a
// picture if available").
//
// Before this the window showed ONE photo: the most recent Direct Order claim on the venue. A venue
// captured in the field and later re-filed on an invoice showed the invoice and no photo; a venue a
// rep validated in MARKETING — the pharmacy shot and the doctor shot, both with GPS — showed
// neither, because nothing joined the two modules.
//
// THREE SOURCES, ALL OF THEM, NEWEST FIRST WITHIN EACH:
//   1. every Direct Order claim on the venue that carries a photo, whatever its status — a rejected
//      claim's photo is still a picture of the shop, and the card says it was rejected;
//   2. every live photo of the MARKETING pharmacy this venue is — found through the link table the
//      automatic hand-over writes, and through the venue's own distributor codes, so a catalogue
//      venue a rep also validated in Marketing shows his photos too;
//   3. every live photo of every MARKETING CUSTOMER validated at that pharmacy (usually the doctor).
//
// A Direct Order claim that only REFERENCES a marketing pharmacy photo (the hand-over's own claim) is
// folded into that pharmacy's card, so the same image never shows twice.
//
// NEVER THROWS: it decorates an approval screen, and an approver must never lose the order because a
// decoration could not be read. A file recorded but not signable still gets its card, saying so.
// ─────────────────────────────────────────────────────────────────────────────

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const DIRECT_ORDER_EVIDENCE_BUCKET = "direct-order-evidence";

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

const cairo = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : null;

const MARKETING_STATUS_TEXT: Record<string, string> = {
  system_validated: "Validated — GPS and a live photo, checked automatically",
  sfe_validated: "Validated at the SFE desk",
  admin_approved: "Approved by a person",
  pending: "Pending validation",
  rejected: "Rejected",
};

const CLAIM_STATUS_TEXT: Record<string, string> = {
  pending: "Waiting for the validation desk",
  approved_new: "Approved as a new venue",
  matched_existing: "Matched to the master database",
  rejected: "Rejected by the validation desk",
};

const EVIDENCE_STATUS_TEXT: Record<string, string> = {
  complete: "Complete — GPS and a live photo",
  pending: "Incomplete",
  missing: "No evidence",
};

function statusText(map: Record<string, string>, value: string | null): string | null {
  if (!value) return null;
  return map[value] ?? value.replace(/_/g, " ");
}

function gpsText(latitude: number | null, longitude: number | null, accuracy: number | null): string | null {
  if (latitude === null || longitude === null) return null;
  const base = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  return accuracy === null ? base : `${base} (±${Math.round(accuracy)} m)`;
}

/** Drop the rows with no value, so a card prints only what was actually captured. */
function details(rows: Array<[string, string | null | undefined]>): Array<{ label: string; value: string }> {
  return rows
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([label, value]) => ({ label, value }));
}

async function selectIn(
  table: string,
  column: string,
  values: string[],
  columns = "*",
  /** `marketing_evidence_files` is indexed on (entity_type, entity_id) and times out without its type. */
  equals: Record<string, string> = {},
): Promise<Row[]> {
  const ids = Array.from(new Set(values.filter(Boolean)));
  const rows: Row[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    let query = getSupabaseAdmin().from(table).select(columns).in(column, ids.slice(index, index + 50));
    for (const [key, value] of Object.entries(equals)) query = query.eq(key, value);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows;
}

async function signPhoto(bucket: string, path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await getSupabaseAdmin().storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}

async function loadNames(hrIds: Array<string | null>): Promise<(hrId: string | null) => string | null> {
  const keys = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  const names = new Map<string, string>();
  if (keys.length > 0) {
    const rows = await selectIn("employees", "hr_id", keys, "hr_id, full_name");
    for (const row of rows) {
      const key = canonicalHrIdKey(text(row, "hr_id"));
      const name = text(row, "full_name");
      if (key && name) names.set(key, name);
    }
  }
  // A name, never an HR id — an id nobody can resolve is said as such.
  return (hrId) => (hrId ? names.get(canonicalHrIdKey(hrId) ?? "") ?? "Not in the employee directory" : null);
}

/** The marketing pharmacies this Direct Order venue IS: through the hand-over's link, or its codes. */
export async function findMarketingPharmacyIds(directOrderPharmacyId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const [{ data: linked }, { data: venueCodes }] = await Promise.all([
    supabase
      .from("marketing_pharmacy_direct_order_venues")
      .select("marketing_pharmacy_id")
      .eq("direct_order_pharmacy_id", directOrderPharmacyId),
    supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("distributor_code, customer_code")
      .eq("pharmacy_id", directOrderPharmacyId),
  ]);
  const ids = new Set(((linked ?? []) as Row[]).map((row) => String(row.marketing_pharmacy_id)));
  // Pairwise, never two crossed .in() lists — that would match distributor A's code to B's customer.
  for (const pair of (venueCodes ?? []) as Row[]) {
    const distributorCode = text(pair, "distributor_code");
    const customerCode = text(pair, "customer_code");
    if (!distributorCode || !customerCode) continue;
    const { data } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("pharmacy_id")
      .eq("mapped_distributor_code", distributorCode)
      .eq("mapped_customer_code", customerCode)
      .neq("active", false)
      .limit(20);
    for (const row of (data ?? []) as Row[]) if (text(row, "pharmacy_id")) ids.add(String(row.pharmacy_id));
  }
  return Array.from(ids);
}

export async function loadDirectOrderVenueValidationPhotos(
  directOrderPharmacyId: string | null | undefined,
): Promise<DirectOrderVenueValidationPhoto[]> {
  if (!directOrderPharmacyId) return [];
  try {
    return await assemble(String(directOrderPharmacyId));
  } catch (error) {
    logError("Venue validation photos could not be loaded for the approval window", {
      labels: { event: "direct_order_venue_photos_failed" },
      context: { directOrderPharmacyId },
      error,
    });
    return [];
  }
}

async function assemble(directOrderPharmacyId: string): Promise<DirectOrderVenueValidationPhoto[]> {
  const supabase = getSupabaseAdmin();

  const [{ data: claimRows }, marketingPharmacyIds] = await Promise.all([
    supabase
      .from("direct_order_pharmacy_validations")
      .select("*")
      .eq("pharmacy_id", directOrderPharmacyId)
      .not("storage_path", "is", null)
      .order("requested_at", { ascending: false })
      .limit(50),
    findMarketingPharmacyIds(directOrderPharmacyId),
  ]);
  const claims = (claimRows ?? []) as Row[];

  const pharmacies = marketingPharmacyIds.length ? await selectIn("marketing_pharmacies", "id", marketingPharmacyIds) : [];
  const links = marketingPharmacyIds.length
    ? (await selectIn("marketing_customer_pharmacies", "pharmacy_id", marketingPharmacyIds)).filter((row) => row.active !== false)
    : [];
  const customerIds = Array.from(new Set(links.map((row) => String(row.customer_id ?? "")).filter(Boolean)));
  const customers = customerIds.length
    ? (await selectIn("marketing_customers", "id", customerIds)).filter((row) => row.active !== false)
    : [];
  const [contacts, pharmacyEvidence, customerEvidence, codeRows] = await Promise.all([
    customerIds.length ? selectIn("marketing_customer_contacts", "customer_id", customerIds) : Promise.resolve([] as Row[]),
    selectIn("marketing_evidence_files", "entity_id", marketingPharmacyIds, "*", { entity_type: "pharmacy", evidence_type: "location_photo" }),
    selectIn("marketing_evidence_files", "entity_id", customerIds, "*", { entity_type: "customer", evidence_type: "location_photo" }),
    selectIn(
      "marketing_pharmacy_distributor_codes",
      "id",
      links.map((row) => String(row.distributor_code_id ?? "")),
    ),
  ]);
  const photos = [...pharmacyEvidence, ...customerEvidence]
    .filter((row) => row.evidence_type === "location_photo" && text(row, "storage_path"))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

  const nameOf = await loadNames([
    ...claims.flatMap((row) => [text(row, "requested_by_hr_id"), text(row, "decided_by_hr_id")]),
    ...pharmacies.flatMap((row) => [text(row, "created_by_hr_id"), text(row, "validated_by_hr_id"), text(row, "license_name_checked_by_hr_id")]),
    ...customers.flatMap((row) => [text(row, "created_by_hr_id"), text(row, "owner_hr_id"), text(row, "validated_by_hr_id")]),
    ...photos.map((row) => text(row, "uploaded_by_hr_id")),
  ]);

  const out: DirectOrderVenueValidationPhoto[] = [];
  const marketingPhotoPaths = new Set(photos.map((row) => String(row.storage_path)));

  // 1 — the marketing pharmacy, the shop itself.
  for (const pharmacy of pharmacies) {
    const pharmacyId = String(pharmacy.id);
    const pharmacyLinks = links.filter((row) => String(row.pharmacy_id) === pharmacyId);
    const codes = pharmacyLinks
      .map((row) => codeRows.find((code) => String(code.id) === String(row.distributor_code_id ?? "")))
      .filter((row): row is Row => Boolean(row))
      .map((code) => [text(code, "mapped_distributor_code"), text(code, "mapped_customer_code") ?? text(code, "distributor_pharmacy_code")].filter(Boolean).join(" · "))
      .filter(Boolean);
    const shopPhotos = photos.filter((row) => row.entity_type === "pharmacy" && String(row.entity_id) === pharmacyId);
    const shared = details([
      ["Venue type", venueTypeLabel(normalizeVenueType(pharmacy.venue_type))],
      ["Pharmacy code", text(pharmacy, "pharmacy_code")],
      ["Distributor codes", codes.length ? Array.from(new Set(codes)).join(", ") : "No distributor code"],
      ["Address", text(pharmacy, "captured_address")],
      ["Area · governorate", [text(pharmacy, "extracted_area_name"), text(pharmacy, "extracted_governorate_name")].filter(Boolean).join(" · ")],
      ["Region", text(pharmacy, "region_name")],
      ["Venue GPS", gpsText(num(pharmacy, "captured_latitude"), num(pharmacy, "captured_longitude"), num(pharmacy, "captured_accuracy_meters"))],
      ["Captured", cairo(text(pharmacy, "captured_at"))],
      ["Captured by", nameOf(text(pharmacy, "created_by_hr_id"))],
      ["Evidence", statusText(EVIDENCE_STATUS_TEXT, text(pharmacy, "evidence_status"))],
      ["Marketing validation", statusText(MARKETING_STATUS_TEXT, text(pharmacy, "validation_status"))],
      ["Validated by", nameOf(text(pharmacy, "validated_by_hr_id"))],
      ["Validated", cairo(text(pharmacy, "validated_at"))],
      [
        "Licence name vs shop sign",
        pharmacy.license_name_matches_sign === true
          ? "Matches the shop sign"
          : pharmacy.license_name_matches_sign === false
            ? "Does NOT match the shop sign"
            : null,
      ],
      ["Validation notes", text(pharmacy, "validation_notes")],
    ]);
    const cards = shopPhotos.length > 0 ? shopPhotos : [null];
    for (const [index, photo] of cards.entries()) {
      out.push({
        key: `mp:${pharmacyId}:${index}`,
        source: "marketing_pharmacy",
        title: "Pharmacy — Marketing validation",
        subject: text(pharmacy, "display_name") ?? "Marketing pharmacy",
        photoUrl: photo ? await signPhoto(text(photo, "storage_bucket") ?? MARKETING_EVIDENCE_BUCKET, text(photo, "storage_path")) : null,
        photoCapturedAt: photo ? text(photo, "captured_at") : null,
        photoLatitude: photo ? num(photo, "captured_latitude") : null,
        photoLongitude: photo ? num(photo, "captured_longitude") : null,
        photoAccuracyMeters: photo ? num(photo, "captured_accuracy_meters") : null,
        details: photo
          ? [
              ...shared,
              ...details([
                ["Photo taken", cairo(text(photo, "captured_at"))],
                ["Photo GPS", gpsText(num(photo, "captured_latitude"), num(photo, "captured_longitude"), num(photo, "captured_accuracy_meters"))],
                ["Photo uploaded by", nameOf(text(photo, "uploaded_by_hr_id"))],
              ]),
            ]
          : [...shared, { label: "Photo", value: "No live photo of this pharmacy is on file in Marketing." }],
      });
    }
  }

  // 2 — every marketing customer validated at that pharmacy (usually the doctor).
  for (const customer of customers) {
    const customerId = String(customer.id);
    const contactRows = contacts.filter((row) => String(row.customer_id) === customerId && row.active !== false);
    const customerLinks = links.filter((row) => String(row.customer_id) === customerId);
    const atPharmacies = customerLinks
      .map((row) => pharmacies.find((pharmacy) => String(pharmacy.id) === String(row.pharmacy_id)))
      .filter((row): row is Row => Boolean(row))
      .map((row) => text(row, "display_name"))
      .filter(Boolean);
    const customerPhotos = photos.filter((row) => row.entity_type === "customer" && String(row.entity_id) === customerId);
    const shared = details([
      ["Customer type", text(customer, "customer_type") === "other" ? text(customer, "other_type_description") ?? "Other" : text(customer, "customer_type")],
      ["Customer code", text(customer, "customer_code")],
      ["Contact", contactRows.map((row) => [text(row, "contact_name"), text(row, "specialty")].filter(Boolean).join(" — ")).filter(Boolean).join(", ")],
      ["Mobile", contactRows.map((row) => text(row, "mobile_number")).filter(Boolean).join(", ")],
      ["CRM code", contactRows.map((row) => text(row, "crm_code")).filter(Boolean).join(", ")],
      ["Linked pharmacies", Array.from(new Set(atPharmacies)).join(", ")],
      ["Link validation", Array.from(new Set(customerLinks.map((row) => statusText(MARKETING_STATUS_TEXT, text(row, "validation_status"))).filter(Boolean))).join(", ")],
      ["Address", text(customer, "captured_address")],
      ["Area · governorate", [text(customer, "extracted_area_name"), text(customer, "extracted_governorate_name")].filter(Boolean).join(" · ")],
      ["Region", text(customer, "region_name")],
      ["Customer GPS", gpsText(num(customer, "captured_latitude"), num(customer, "captured_longitude"), num(customer, "captured_accuracy_meters"))],
      ["Captured", cairo(text(customer, "captured_at"))],
      ["Captured by", nameOf(text(customer, "created_by_hr_id"))],
      ["Owner", nameOf(text(customer, "owner_hr_id"))],
      ["Evidence", statusText(EVIDENCE_STATUS_TEXT, text(customer, "evidence_status"))],
      ["Marketing validation", statusText(MARKETING_STATUS_TEXT, text(customer, "validation_status"))],
      ["Validated by", nameOf(text(customer, "validated_by_hr_id"))],
      ["Validated", cairo(text(customer, "validated_at"))],
      ["Validation notes", text(customer, "validation_notes")],
    ]);
    const cards = customerPhotos.length > 0 ? customerPhotos : [null];
    for (const [index, photo] of cards.entries()) {
      out.push({
        key: `mc:${customerId}:${index}`,
        source: "marketing_customer",
        title: "Customer — Marketing validation",
        subject: text(customer, "display_name") ?? "Marketing customer",
        photoUrl: photo ? await signPhoto(text(photo, "storage_bucket") ?? MARKETING_EVIDENCE_BUCKET, text(photo, "storage_path")) : null,
        photoCapturedAt: photo ? text(photo, "captured_at") : null,
        photoLatitude: photo ? num(photo, "captured_latitude") : null,
        photoLongitude: photo ? num(photo, "captured_longitude") : null,
        photoAccuracyMeters: photo ? num(photo, "captured_accuracy_meters") : null,
        details: photo
          ? [
              ...shared,
              ...details([
                ["Photo taken", cairo(text(photo, "captured_at"))],
                ["Photo GPS", gpsText(num(photo, "captured_latitude"), num(photo, "captured_longitude"), num(photo, "captured_accuracy_meters"))],
                ["Photo uploaded by", nameOf(text(photo, "uploaded_by_hr_id"))],
              ]),
            ]
          : [...shared, { label: "Photo", value: "No live photo of this customer is on file in Marketing." }],
      });
    }
  }

  // 3 — every Direct Order claim with a photo, unless it only points at a marketing photo shown above.
  for (const claim of claims) {
    const path = text(claim, "storage_path");
    if (path && marketingPhotoPaths.has(path)) continue;
    out.push({
      key: `do:${String(claim.id)}`,
      source: "direct_order_claim",
      title: "Pharmacy — Direct Order validation",
      subject: text(claim, "claimed_pharmacy_name") ?? "Venue",
      photoUrl: await signPhoto(text(claim, "storage_bucket") ?? DIRECT_ORDER_EVIDENCE_BUCKET, path),
      photoCapturedAt: text(claim, "photo_captured_at") ?? text(claim, "captured_at"),
      photoLatitude: num(claim, "photo_latitude"),
      photoLongitude: num(claim, "photo_longitude"),
      photoAccuracyMeters: num(claim, "photo_accuracy_meters"),
      details: details([
        ["Status", statusText(CLAIM_STATUS_TEXT, text(claim, "status"))],
        ["Doctor", text(claim, "claimed_doctor_name")],
        ["Address given", text(claim, "claimed_address")],
        ["Address at the pin", text(claim, "captured_address")],
        ["Venue GPS", gpsText(num(claim, "captured_latitude"), num(claim, "captured_longitude"), num(claim, "captured_accuracy_meters"))],
        ["Photo GPS", gpsText(num(claim, "photo_latitude"), num(claim, "photo_longitude"), num(claim, "photo_accuracy_meters"))],
        ["Photo taken", cairo(text(claim, "photo_captured_at") ?? text(claim, "captured_at"))],
        ["Submitted by", nameOf(text(claim, "requested_by_hr_id"))],
        ["Submitted", cairo(text(claim, "requested_at"))],
        ["Reason given", text(claim, "claimed_reason")],
        ["Matched code", [text(claim, "matched_distributor_code"), text(claim, "matched_customer_code")].filter(Boolean).join(" · ")],
        ["Decided by", nameOf(text(claim, "decided_by_hr_id")) ?? (text(claim, "decided_at") ? "Automatic — validated in Marketing" : null)],
        ["Decided", cairo(text(claim, "decided_at"))],
        ["Decision notes", text(claim, "decision_notes")],
      ]),
    });
  }

  return out;
}
