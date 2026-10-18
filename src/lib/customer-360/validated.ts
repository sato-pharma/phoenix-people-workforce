/**
 * WHO IS IN CUSTOMER 360 — the one home of every validated-status word the module reads.
 *
 * The owner's ruling (2026-10-18): "you will work only on validated customers … make sure that every
 * validated customer is new is now validated to consider it and to make this module update itself …
 * only work on validated customers because of the correct data." So a customer enters the report
 * because a validation already happened somewhere else in the system, and it enters by itself the
 * moment it does — nothing about membership is stored here.
 *
 * Two kinds of hub, never mixed (PM, AM and pharmacy never mix — the identity module's own rule):
 *
 *   · DOCTOR  — a validated Phoenix CRM PM customer, or a validated marketing customer of type doctor
 *               or clinic.
 *   · ACCOUNT — a validated Phoenix CRM AM customer, or a validated marketing customer of type
 *               hospital, account or other.
 *
 * The pharmacies tied to a hub need NO validation of their own (his answer, same day: "validated
 * doctors and accounts"), but each tie is only as good as its source's own validation — a marketing
 * customer→pharmacy link counts only at a selectable link status, and a direct-order venue only once
 * it is trusted.
 *
 * 🔴 `tests/customer-360-validated.test.ts` refuses a status literal (`system_validated`, `trusted`,
 * `validated_at`…) anywhere else in `src/lib/customer-360/`, so a second definition of "validated"
 * cannot grow inside the module.
 */

import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { LINK_STATUS_PRECEDENCE } from "@/lib/marketing-requests/code-link-reach";

/** The iReports360 placeholder contact every unmatched visit was filed under — never a person. */
export const PLACEHOLDER_CONTACT_CRM_ID = 100000;

export type HubKind = "doctor" | "account";

// ── Phoenix CRM ──────────────────────────────────────────────────────────────────────────────────

/** The columns of `phoenix_crm_customers` this rule reads. */
export type PhoenixCustomerRow = {
  id: string;
  list_type: string | null;
  status: string | null;
  validated_at: string | null;
  is_test: boolean | null;
  speciality: string | null;
  reference_contact_crm_id: number | null;
  own_contact_crm_id: number | null;
};

/** The select list that reads every column {@link isValidatedPhoenixHubRow} needs. */
export const PHOENIX_VALIDATION_COLUMNS =
  "id, list_type, status, validated_at, is_test, speciality, reference_contact_crm_id, own_contact_crm_id";

/** The column whose presence IS the validation — the reader filters `not null` on it. */
export const PHOENIX_VALIDATED_AT_COLUMN = "validated_at";

/** The two lists a hub can come from; `Pharmacy` rows are shops, never hubs. */
export const PHOENIX_HUB_LIST_TYPES = ["PM", "AM"] as const;

/**
 * The one contact id a Phoenix CRM customer is known by everywhere else: the iReports360 contact it
 * was carried over from, else the contact Phoenix minted for a customer a rep added himself.
 */
export function phoenixContactId(row: Pick<PhoenixCustomerRow, "reference_contact_crm_id" | "own_contact_crm_id">): number | null {
  const id = row.reference_contact_crm_id ?? row.own_contact_crm_id ?? null;
  if (id == null || !Number.isFinite(Number(id))) return null;
  const value = Number(id);
  return value === PLACEHOLDER_CONTACT_CRM_ID || value <= 0 ? null : value;
}

/** PM is a doctor, AM is an account, anything else is not a hub. */
export function phoenixHubKind(listType: string | null | undefined): HubKind | null {
  const value = String(listType ?? "").trim().toUpperCase();
  if (value === "PM") return "doctor";
  if (value === "AM") return "account";
  return null;
}

/** A dropped customer stays in the report, said as dropped, because his history is real. */
export function isDroppedPhoenixRow(row: Pick<PhoenixCustomerRow, "status">): boolean {
  return String(row.status ?? "").trim().toLowerCase() === "dropped";
}

/**
 * A Phoenix CRM row is a hub when a validation stands on it, it is a real (not test) PM or AM
 * customer that is active or was dropped after validation, it carries a real contact id, and it is
 * not a pharmacy filed on a doctor's list.
 */
export function isValidatedPhoenixHubRow(row: PhoenixCustomerRow): boolean {
  if (!row.validated_at) return false;
  if (row.is_test) return false;
  if (!phoenixHubKind(row.list_type)) return false;
  const status = String(row.status ?? "").trim().toLowerCase();
  if (status !== "active" && status !== "dropped") return false;
  if (phoenixContactId(row) == null) return false;
  if (isPharmacySpeciality(row.speciality)) return false;
  return true;
}

// ── Marketing customers ─────────────────────────────────────────────────────────────────────────

/** The two statuses a marketing customer is validated at. `pending` is out. */
export const VALIDATED_MARKETING_CUSTOMER_STATUSES = ["system_validated", "sfe_validated"] as const;

export type MarketingCustomerRow = {
  id: string;
  customer_type: string | null;
  validation_status: string | null;
  active: boolean | null;
  merged_into_customer_id: string | null;
};

export function isValidatedMarketingCustomer(row: MarketingCustomerRow): boolean {
  if (row.active === false) return false;
  if (row.merged_into_customer_id) return false;
  return (VALIDATED_MARKETING_CUSTOMER_STATUSES as readonly string[]).includes(String(row.validation_status ?? ""));
}

/** A clinic is a doctor's own place; a hospital, an account or anything else is an account. */
export function marketingCustomerHubKind(customerType: string | null | undefined): HubKind {
  const value = String(customerType ?? "").trim().toLowerCase();
  return value === "doctor" || value === "clinic" ? "doctor" : "account";
}

/**
 * A marketing customer→pharmacy link, and a request target's link, count at the statuses the
 * marketing desk itself treats as selectable — imported, never copied.
 */
export function isCountedMarketingLinkStatus(status: string | null | undefined): boolean {
  return (LINK_STATUS_PRECEDENCE as readonly string[]).includes(String(status ?? ""));
}

// ── Direct orders ──────────────────────────────────────────────────────────────────────────────

export type DirectOrderVenueRow = {
  trust_state: string | null;
  active: boolean | null;
  merged_into_pharmacy_id: string | null;
};

/** A direct-order venue ties to a doctor only once it is TRUSTED; provisional is out. */
export function isTrustedDirectOrderVenue(row: DirectOrderVenueRow): boolean {
  if (row.active === false) return false;
  if (row.merged_into_pharmacy_id) return false;
  return String(row.trust_state ?? "").trim().toLowerCase() === "trusted";
}

/** The order statuses whose value is real: approved, and not itself a reversal or reversed. */
export function isCountedDirectOrder(row: { status: string | null; reversal_of_request_id: string | null; reversed_by_request_id: string | null }): boolean {
  return String(row.status ?? "") === "approved" && !row.reversal_of_request_id && !row.reversed_by_request_id;
}
