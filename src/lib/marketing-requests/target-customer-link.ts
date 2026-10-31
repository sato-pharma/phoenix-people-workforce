/**
 * "Is this target pharmacy validated WITH this request's customer?" — the line every approval screen
 * prints under each target pharmacy (owner, 2026-10-31: "when the request go to the approval windows
 * must obvious clear show that those ph are validated with the customer").
 *
 * The green "Validated" stamp beside a pharmacy is about the VENUE (`marketing_pharmacies`). This is
 * about the PAIRING — the `marketing_customer_pharmacies` link between the request's doctor and that
 * pharmacy — which is what a request's ROI actually rests on. A pharmacy can be a validated venue
 * and still never have been validated with this doctor.
 *
 * A desk link (`isDeskValidated`) is still a validated link, but the pharmacy was never stood in
 * front of, so the sentence says so — never presented as a field capture.
 *
 * Pure: no database, no React. The read is in `getMarketingRequestDecisionSummary`.
 */

import { isDeskValidated } from "@/lib/customer-pharmacy-mapping/readiness";

/** The link statuses that mean the pairing was accepted — by the evidence rules or by a person. */
const VALIDATED_LINK_STATUSES: ReadonlySet<string> = new Set(["system_validated", "sfe_validated", "admin_approved"]);

export type TargetCustomerLinkRow = {
  distributor_code_id: string | null;
  pharmacy_id: string | null;
  validation_notes?: string | null;
  validation_status?: string | null;
};

export type TargetCustomerLink = {
  state: "validated" | "not_validated" | "no_link";
  /** Validated at a desk: the pharmacy itself has no field GPS or live photo. */
  deskEntry: boolean;
};

/**
 * The link for one target, matched on its distributor code first (the request names a code), then on
 * the pharmacy, so a target whose code row could not be read is still answered.
 */
export function resolveTargetCustomerLink(
  links: ReadonlyArray<TargetCustomerLinkRow>,
  target: { distributorCodeId: string | null; pharmacyId: string | null },
): TargetCustomerLink {
  const byCode = target.distributorCodeId
    ? links.filter((link) => link.distributor_code_id === target.distributorCodeId)
    : [];
  const candidates = byCode.length > 0
    ? byCode
    : target.pharmacyId
      ? links.filter((link) => link.pharmacy_id === target.pharmacyId)
      : [];
  if (candidates.length === 0) return { deskEntry: false, state: "no_link" };
  const validated = candidates.find((link) => VALIDATED_LINK_STATUSES.has(String(link.validation_status ?? "")));
  if (!validated) return { deskEntry: false, state: "not_validated" };
  return { deskEntry: isDeskValidated(validated.validation_notes), state: "validated" };
}

/** The one sentence every approval screen prints. */
export function targetCustomerLinkSentence(link: TargetCustomerLink, customerName: string | null): string {
  const customer = customerName?.trim() || "this customer";
  if (link.state === "validated") {
    return link.deskEntry
      ? `Validated with ${customer} · desk entry, the pharmacy has no field photo`
      : `Validated with ${customer}`;
  }
  if (link.state === "not_validated") return `Not validated with ${customer} yet`;
  return `No link to ${customer} on file`;
}
