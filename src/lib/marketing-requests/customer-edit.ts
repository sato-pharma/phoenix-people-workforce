/**
 * The Super Admin opens a customer already on file and changes it — the owner's ask, 2026-11-25:
 * "make the super admin able to open the customer and edit".
 *
 * Before this, the ONLY door that wrote a marketing customer was Customer Validation, and every
 * press of Save Validation minted a new `MKT-HCP-…` row. Adding one more pharmacy to a doctor who
 * was already set up therefore meant saving him again — which copied the doctor AND every pharmacy
 * already on him (25 Nov 2026 23:12: Dr Othman El Shewehy and four Damietta pharmacies, all twice),
 * and the copies then had to be merged by hand on another screen.
 *
 * Four acts, Super Admin only, each one press on the Customer Check page:
 *  - change the customer's name, speciality and phone;
 *  - find a pharmacy by its distributor and code — the one already on file, else the distributor's
 *    own record of that code;
 *  - add that pharmacy to the customer, through the SAME save Customer Validation uses
 *    (`createMarketingValidationRecord` with `attachPharmaciesOnly`), so every venue, code, link,
 *    Direct Orders and validation rule still applies — nothing here re-implements them;
 *  - remove a pharmacy from the customer (its links are switched off, never deleted; adding it
 *    again switches them back on).
 *
 * 🔴 A pharmacy whose code is already on file is ATTACHED, never re-created: "add" with a code that
 * an active venue holds is refused unless it names that venue. That is the duplicate this exists to
 * stop.
 */
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import type { AccessContext } from "@/lib/auth/permissions";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { hrIdForStorage } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { createMarketingValidationRecord } from "@/lib/marketing-requests/service";
import {
  MARKETING_CUSTOMER_SPECIALITIES,
  type MarketingValidationPharmacyEntry,
} from "@/lib/marketing-requests/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Who may open a customer on file and change it. The UI hiding the buttons is not the boundary. */
export function canEditMarketingCustomer(access: AccessContext | null | undefined): boolean {
  return access?.role === "Super Admin";
}

function assertCanEdit(access: AccessContext) {
  if (!canEditMarketingCustomer(access)) {
    throw forbiddenError("Forbidden: only the Super Admin can change a customer on file.");
  }
}

/** The same key the save stores in `normalized_name` / `normalized_pharmacy_code`. */
export function normalizeEditLookupKey(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

type CustomerRow = {
  active: boolean | null;
  captured_address: string | null;
  captured_at: string | null;
  captured_latitude: number | null;
  captured_longitude: number | null;
  customer_type: string | null;
  display_name: string | null;
  extracted_area_name: string | null;
  extracted_governorate_name: string | null;
  id: string;
  merged_into_customer_id: string | null;
  owner_hr_id: string | null;
  region_name: string | null;
};

async function loadEditableCustomer(customerId: string): Promise<CustomerRow> {
  const id = String(customerId ?? "").trim();
  if (!isUuid(id)) throw notFoundError("That customer is not on file.");
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_customers")
    .select(
      "id, active, display_name, customer_type, owner_hr_id, merged_into_customer_id, captured_address, captured_at,"
        + " captured_latitude, captured_longitude, extracted_area_name, extracted_governorate_name, region_name",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  const row = data as CustomerRow | null;
  if (!row) throw notFoundError("That customer is not on file.");
  if (row.merged_into_customer_id) {
    throw conflictError("This customer was merged into another one. Open the one it was merged into.", "customer_merged");
  }
  if (row.active === false) throw conflictError("This customer is switched off.", "customer_inactive");
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name, speciality, phone
// ─────────────────────────────────────────────────────────────────────────────

export type MarketingCustomerDetailsEdit = {
  displayName: string;
  mobileNumber?: string | null;
  speciality?: string | null;
};

/** Pure: what the details form may save, or the one sentence saying why it may not. */
export function normalizeCustomerDetailsEdit(input: MarketingCustomerDetailsEdit): {
  displayName: string;
  mobileNumber: string | null;
  speciality: string | null;
} {
  const displayName = cleanText(input.displayName);
  if (!displayName) throw validationError("The customer needs a name.");
  const rawSpeciality = cleanText(input.speciality);
  const speciality = rawSpeciality
    ? MARKETING_CUSTOMER_SPECIALITIES.find((option) => option.toLowerCase() === rawSpeciality.toLowerCase()) ?? null
    : null;
  if (rawSpeciality && !speciality) {
    throw validationError(`"${rawSpeciality}" is not one of the specialities on the list.`, "unknown_speciality");
  }
  const mobileNumber = cleanText(input.mobileNumber);
  if (mobileNumber && !/^[0-9+\s-]{6,20}$/.test(mobileNumber)) {
    throw validationError("The phone number can hold only digits, spaces, + and -.");
  }
  return { displayName, mobileNumber, speciality };
}

export async function updateMarketingCustomerDetails(
  access: AccessContext,
  customerId: string,
  input: MarketingCustomerDetailsEdit,
): Promise<{ customerId: string }> {
  assertCanEdit(access);
  assertRealSessionForDecision(access, "change a customer on file");
  const row = await loadEditableCustomer(customerId);
  const next = normalizeCustomerDetailsEdit(input);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const customerUpdate = await supabase
    .from("marketing_customers")
    .update({
      display_name: next.displayName,
      normalized_name: normalizeEditLookupKey(next.displayName),
      updated_at: now,
      updated_by_hr_id: hrIdForStorage(access.hrId),
    })
    .eq("id", row.id);
  if (customerUpdate.error) throw customerUpdate.error;

  // The speciality and phone live on the customer's contact. The first live one is the doctor
  // himself on every desk and field capture; a customer with none gets one, so the fields stick.
  const contacts = await supabase
    .from("marketing_customer_contacts")
    .select("id, specialty, mobile_number, contact_name")
    .eq("customer_id", row.id)
    .neq("active", false)
    .order("created_at", { ascending: true })
    .limit(1);
  if (contacts.error) throw contacts.error;
  const contact = (contacts.data ?? [])[0] as
    | { contact_name: string | null; id: string; mobile_number: string | null; specialty: string | null }
    | undefined;
  if (contact) {
    const contactUpdate = await supabase
      .from("marketing_customer_contacts")
      .update({ contact_name: next.displayName, mobile_number: next.mobileNumber, specialty: next.speciality, updated_at: now })
      .eq("id", contact.id);
    if (contactUpdate.error) throw contactUpdate.error;
  } else if (next.mobileNumber || next.speciality) {
    const contactInsert = await supabase.from("marketing_customer_contacts").insert({
      contact_name: next.displayName,
      created_by_hr_id: hrIdForStorage(access.hrId),
      customer_id: row.id,
      mobile_number: next.mobileNumber,
      specialty: next.speciality,
    });
    if (contactInsert.error) throw contactInsert.error;
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: row.id,
    entityType: "marketing_customer",
    newValues: next,
    oldValues: {
      displayName: row.display_name,
      mobileNumber: contact?.mobile_number ?? null,
      speciality: contact?.specialty ?? null,
    },
    summary: `Marketing customer "${row.display_name ?? row.id}" edited on the Customer Check page.`,
  });
  bumpCustomer360Cache("marketing customer edited");
  return { customerId: row.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Find a pharmacy by its distributor code
// ─────────────────────────────────────────────────────────────────────────────

export type PharmacyOnFile = {
  address: string | null;
  /** Every distributor code this venue carries, as "<distributor> <code>". */
  codes: string[];
  hasPin: boolean;
  /** True when this customer already has it, live. */
  alreadyOnCustomer: boolean;
  name: string;
  pharmacyId: string;
};

export type PharmacyCodeFinding = {
  /** The venues already on file holding this exact code — attach one of these. */
  onFile: PharmacyOnFile[];
  /** The distributor's own record of this code, when no venue holds it yet. */
  distributorRecord: { address: string | null; area: string | null; region: string | null } | null;
};

export async function findPharmacyForCustomerByCode(
  access: AccessContext,
  input: { customerId: string; distributorId: number | string; pharmacyCode: string },
): Promise<PharmacyCodeFinding> {
  assertCanEdit(access);
  const row = await loadEditableCustomer(input.customerId);
  const distributorId = Number(input.distributorId);
  if (!Number.isInteger(distributorId) || distributorId <= 0) throw validationError("Choose the distributor.");
  const code = normalizeEditLookupKey(input.pharmacyCode);
  if (!code) throw validationError("Type the pharmacy's code at that distributor.");
  const supabase = getSupabaseAdmin();

  const codeRows = await supabase
    .from("marketing_pharmacy_distributor_codes")
    .select("pharmacy_id")
    .eq("distributor_id", distributorId)
    .eq("normalized_pharmacy_code", code)
    .eq("active", true);
  if (codeRows.error) throw codeRows.error;
  const pharmacyIds = [...new Set(((codeRows.data ?? []) as Array<{ pharmacy_id: string }>).map((entry) => entry.pharmacy_id))];

  const onFile: PharmacyOnFile[] = [];
  if (pharmacyIds.length > 0) {
    const [venues, allCodes, distributors, links] = await Promise.all([
      supabase
        .from("marketing_pharmacies")
        .select("id, display_name, captured_address, captured_latitude, active, merged_into_pharmacy_id")
        .in("id", pharmacyIds),
      supabase
        .from("marketing_pharmacy_distributor_codes")
        .select("pharmacy_id, distributor_id, distributor_pharmacy_code")
        .in("pharmacy_id", pharmacyIds)
        .eq("active", true),
      supabase.from("marketing_distributors").select("id, display_name"),
      supabase
        .from("marketing_customer_pharmacies")
        .select("pharmacy_id")
        .eq("customer_id", row.id)
        .eq("active", true)
        .in("pharmacy_id", pharmacyIds),
    ]);
    for (const result of [venues, allCodes, distributors, links]) if (result.error) throw result.error;
    const distributorName = new Map(
      ((distributors.data ?? []) as Array<{ display_name: string | null; id: number }>).map((entry) => [Number(entry.id), entry.display_name ?? `Distributor ${entry.id}`]),
    );
    const linked = new Set(((links.data ?? []) as Array<{ pharmacy_id: string }>).map((entry) => entry.pharmacy_id));
    for (const venue of (venues.data ?? []) as Array<{
      active: boolean | null;
      captured_address: string | null;
      captured_latitude: number | null;
      display_name: string | null;
      id: string;
      merged_into_pharmacy_id: string | null;
    }>) {
      if (venue.active === false || venue.merged_into_pharmacy_id) continue;
      onFile.push({
        address: venue.captured_address,
        alreadyOnCustomer: linked.has(venue.id),
        codes: ((allCodes.data ?? []) as Array<{ distributor_id: number; distributor_pharmacy_code: string; pharmacy_id: string }>)
          .filter((entry) => entry.pharmacy_id === venue.id)
          .map((entry) => `${distributorName.get(Number(entry.distributor_id)) ?? "Distributor"} ${entry.distributor_pharmacy_code}`),
        hasPin: venue.captured_latitude !== null,
        name: venue.display_name ?? "Unnamed pharmacy",
        pharmacyId: venue.id,
      });
    }
  }

  let distributorRecord: PharmacyCodeFinding["distributorRecord"] = null;
  if (onFile.length === 0) {
    const reference = await supabase
      .from("marketing_pharmacy_code_references")
      .select("raw_pharmacy_address, raw_area, raw_region")
      .eq("distributor_id", distributorId)
      .eq("normalized_pharmacy_code", code)
      .limit(1);
    if (reference.error) throw reference.error;
    const found = (reference.data ?? [])[0] as
      | { raw_area: string | null; raw_pharmacy_address: string | null; raw_region: string | null }
      | undefined;
    if (found) distributorRecord = { address: found.raw_pharmacy_address, area: found.raw_area, region: found.raw_region };
  }
  return { distributorRecord, onFile };
}

// ─────────────────────────────────────────────────────────────────────────────
// Add a pharmacy
// ─────────────────────────────────────────────────────────────────────────────

export type AddPharmacyToCustomerInput =
  /** A venue already on file — the normal case. Every code it carries is linked. */
  | { pharmacyId: string }
  /** A pharmacy no venue holds yet: its name, one distributor code and its map pin. */
  | {
    address?: string | null;
    area?: string | null;
    displayName: string;
    distributorId: number | string;
    governorate?: string | null;
    latitude: number;
    longitude: number;
    pharmacyCode: string;
  };

/** Pure: the one pharmacy entry the shared save receives. */
export function buildAddPharmacyEntry(input: AddPharmacyToCustomerInput, pinnedAt: string): MarketingValidationPharmacyEntry {
  if ("pharmacyId" in input) {
    const pharmacyId = String(input.pharmacyId ?? "").trim();
    if (!pharmacyId) throw validationError("Choose the pharmacy to add.");
    return { existingPharmacyId: pharmacyId };
  }
  const displayName = cleanText(input.displayName);
  if (!displayName) throw validationError("Type the pharmacy's name.");
  const pharmacyCode = cleanText(input.pharmacyCode);
  if (!pharmacyCode) throw validationError("Type the pharmacy's code at that distributor.");
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw validationError("Pick the pharmacy on the map first.");
  }
  return {
    capturedAddress: cleanText(input.address),
    // When the Super Admin pinned it — the same stamp a desk map pick carries on Customer Validation.
    capturedAt: pinnedAt,
    capturedLatitude: latitude,
    capturedLongitude: longitude,
    displayName,
    extractedAreaName: cleanText(input.area),
    extractedGovernorateName: cleanText(input.governorate),
    vendorCodes: [{ distributorId: input.distributorId, distributorPharmacyCode: pharmacyCode }],
    venueType: "pharmacy",
  };
}

export async function addPharmacyToMarketingCustomer(
  access: AccessContext,
  customerId: string,
  input: AddPharmacyToCustomerInput,
): Promise<{ linksWritten: number }> {
  assertCanEdit(access);
  assertRealSessionForDecision(access, "add a pharmacy to a customer");
  const row = await loadEditableCustomer(customerId);
  if (!row.owner_hr_id) {
    throw conflictError("This customer has no owner, so its pharmacies cannot be filed. Set its owner first.", "customer_without_owner");
  }

  // 🔴 The duplicate this file exists to stop: a code an active venue already holds is attached
  // through that venue, never minted a second time.
  if (!("pharmacyId" in input)) {
    const finding = await findPharmacyForCustomerByCode(access, {
      customerId: row.id,
      distributorId: input.distributorId,
      pharmacyCode: input.pharmacyCode,
    });
    if (finding.onFile.length > 0) {
      throw conflictError(
        `"${finding.onFile[0].name}" already holds this code. Add that pharmacy instead of a new one.`,
        "pharmacy_code_on_file",
      );
    }
  }

  const entry = buildAddPharmacyEntry(input, new Date().toISOString());
  const rows = await createMarketingValidationRecord(
    {
      customers: [{
        // Identity is read by the save from the stored row; these only satisfy its shape. With
        // `attachPharmaciesOnly` the customer row itself is never written.
        capturedAddress: row.captured_address,
        capturedAt: row.captured_at,
        capturedLatitude: row.captured_latitude,
        capturedLongitude: row.captured_longitude,
        customerType: (row.customer_type ?? "clinic") as never,
        displayName: row.display_name ?? "Customer",
        existingCustomerId: row.id,
        extractedAreaName: row.extracted_area_name,
        extractedGovernorateName: row.extracted_governorate_name,
        pharmacies: [entry],
        regionName: row.region_name,
      }],
      // The pharmacy is filed under the customer's owner, exactly as the desk files it.
      onBehalfOfHrId: row.owner_hr_id,
    },
    access,
    { attachPharmaciesOnly: true },
  );
  bumpCustomer360Cache("marketing customer pharmacy added");
  return { linksWritten: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Remove a pharmacy
// ─────────────────────────────────────────────────────────────────────────────

export async function removePharmacyFromMarketingCustomer(
  access: AccessContext,
  customerId: string,
  input: { pharmacyId: string; reason: string },
): Promise<{ linksRemoved: number }> {
  assertCanEdit(access);
  assertRealSessionForDecision(access, "remove a pharmacy from a customer");
  const row = await loadEditableCustomer(customerId);
  const pharmacyId = String(input.pharmacyId ?? "").trim();
  if (!isUuid(pharmacyId)) throw validationError("Choose the pharmacy to remove.");
  const reason = cleanText(input.reason);
  if (!reason) throw validationError("Say why this pharmacy comes off the customer. It is the only record of it.");

  const supabase = getSupabaseAdmin();
  const live = await supabase
    .from("marketing_customer_pharmacies")
    .select("id, validation_notes")
    .eq("customer_id", row.id)
    .eq("pharmacy_id", pharmacyId)
    .eq("active", true);
  if (live.error) throw live.error;
  const links = (live.data ?? []) as Array<{ id: string; validation_notes: string | null }>;
  if (links.length === 0) throw notFoundError("That pharmacy is not on this customer.");

  const now = new Date().toISOString();
  const note = `Removed from this customer by the Super Admin on the Customer Check page: ${reason}`;
  for (const link of links) {
    // Switched off, never deleted — a request already raised on it keeps its target, and adding
    // the pharmacy again switches this same row back on.
    const update = await supabase
      .from("marketing_customer_pharmacies")
      .update({
        active: false,
        updated_at: now,
        updated_by_hr_id: hrIdForStorage(access.hrId),
        validation_notes: link.validation_notes ? `${link.validation_notes}\n${note}` : note,
      })
      .eq("id", link.id);
    if (update.error) throw update.error;
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: row.id,
    entityType: "marketing_customer",
    newValues: { active: false, linkIds: links.map((link) => link.id), pharmacyId },
    oldValues: { active: true, pharmacyId },
    summary: `Pharmacy ${pharmacyId} removed from marketing customer "${row.display_name ?? row.id}". Reason: ${reason}`,
  });
  bumpCustomer360Cache("marketing customer pharmacy removed");
  return { linksRemoved: links.length };
}

/** The distributors the "Add pharmacy" picker offers — the shown ones, by name. */
export async function listCustomerEditDistributors(access: AccessContext): Promise<Array<{ id: number; name: string }>> {
  assertCanEdit(access);
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_distributors")
    .select("id, display_name")
    .eq("active", true)
    .order("display_name");
  if (error) throw error;
  return ((data ?? []) as Array<{ display_name: string | null; id: number }>).map((row) => ({
    id: Number(row.id),
    name: row.display_name ?? `Distributor ${row.id}`,
  }));
}
