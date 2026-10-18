// Customer Pharmacy Mapping — approve/reject link-management actions.
//
// Deliberately independent from `src/lib/marketing-requests`, matching the standalone rule
// established for this module in `readiness.ts`. Mutates exactly one existing row in
// `marketing_customer_pharmacies` per call: `validation_status`, `validation_notes`, and the
// `updated_at` / `updated_by_hr_id` audit columns. No delete, no bulk actions, no merge logic,
// no automatic matching — every call targets a single `linkId` supplied by the caller.

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { canonicalHrIdKey, resolveStoredHrId, type StoredHrIdDirectoryEntry } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isLicenseOnlyPharmacyNote } from "@/lib/venues/pharmacy-license";
import { licenseVerdictColumns } from "@/lib/venues/pharmacy-license-verdict-columns";
import { WHOLESALER_VENUE_REFUSED_MESSAGE, isCertainWholesalerVenue } from "@/lib/venues/wholesaler-venue-guard";

import {
  assertCustomerPharmacyMappingAccess,
  type CustomerPharmacyValidationStatus,
} from "./readiness";

export type CustomerPharmacyLinkDecisionResult = {
  linkId: string;
  updatedAt: string;
  updatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: CustomerPharmacyValidationStatus;
};

type LinkStatusRow = {
  active: boolean;
  id: string;
  pharmacy_id: string | null;
  validation_notes: string | null;
  validation_status: CustomerPharmacyValidationStatus | null;
};

type LinkDecisionRow = {
  id: string;
  updated_at: string;
  updated_by_hr_id: string | null;
  validation_notes: string | null;
  validation_status: CustomerPharmacyValidationStatus;
};

/**
 * `employees.hr_id` casing is not uniformly uppercase in live data (e.g. `"c-o1"`), and it is the
 * FK target for `updated_by_hr_id`. Resolve the actor's exact stored casing via the shared,
 * TTL-cached employee directory (same convention as `src/lib/excuses/service.ts`) rather than
 * assuming a case — an unmatched case would violate the FK constraint on write.
 */
async function resolveActorStoredHrId(access: AccessContext): Promise<string | null> {
  if (!access.hrId) return null;

  const directory = await getEmployeeDirectory();
  const byHrId = new Map<string, StoredHrIdDirectoryEntry>();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) byHrId.set(key, { hrId: employee.hrId });
  }

  return resolveStoredHrId(access.hrId, byHrId);
}

/** Appends the decision note to any existing notes rather than replacing them, so an inferred
 *  link's `not GPS field-validated` marker (see `INFERRED_HISTORY_MARKER`) survives a manual
 *  approve/reject decision and the link keeps showing its inferred badge. */
export function composeValidationNotes(existingNotes: string | null, addition: string): string {
  const existing = (existingNotes ?? "").trim();
  const trimmedAddition = addition.trim();
  if (!existing) return trimmedAddition;
  if (existing.includes(trimmedAddition)) return existing;
  return `${existing}\n${trimmedAddition}`;
}

async function fetchLinkStatus(linkId: string): Promise<LinkStatusRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_customer_pharmacies")
    .select("id, validation_status, validation_notes, active, pharmacy_id")
    .eq("id", linkId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError(`Customer pharmacy link ${linkId} was not found.`);
  return data as LinkStatusRow;
}

/**
 * The venue name behind a link, for the wholesaler guard on approve. Read on its own rather than
 * embedded in `fetchLinkStatus` to keep this module free of a foreign-table join and its FK-name
 * assumptions. Returns null when the link carries no pharmacy id (never expected, but not an error).
 */
async function fetchLinkedPharmacyName(pharmacyId: string | null): Promise<string | null> {
  if (!pharmacyId) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_pharmacies")
    .select("display_name")
    .eq("id", pharmacyId)
    .maybeSingle();
  if (error) throw error;
  return (data as { display_name?: string | null } | null)?.display_name ?? null;
}

function requireLinkId(linkId: string): string {
  const trimmed = String(linkId ?? "").trim();
  if (!trimmed) throw validationError("linkId is required.");
  return trimmed;
}

function toDecisionResult(row: LinkDecisionRow): CustomerPharmacyLinkDecisionResult {
  return {
    linkId: row.id,
    updatedAt: row.updated_at,
    updatedByHrId: row.updated_by_hr_id,
    validationNotes: row.validation_notes,
    validationStatus: row.validation_status,
  };
}

/**
 * The status a person's Approve writes. Never `system_validated`: that status means NO HUMAN LOOKED
 * (AGENTS.md 4.1) — it is what the evidence gate grants on a GPS fix and a live photo — and until
 * 2026-09-17 this button filed a human ruling under it, with only the note telling the two apart.
 * Not `sfe_validated` either, which is the desk status. Owner decision 2026-09-17, asked in chat.
 */
export const CUSTOMER_PHARMACY_APPROVED_STATUS: CustomerPharmacyValidationStatus = "admin_approved";

/** Appended to the notes of a licence-only link when a person releases it. */
const LICENSE_RELEASE_NOTE =
  "Released on its licence: the trade name was read against the shop sign and matches. Usable in requests with no sales channel until a distributor code is added.";

/**
 * The row patch an Approve writes, built without IO so the status it carries is under test and not
 * only under a source pattern.
 */
export function buildCustomerPharmacyApprovalPatch(input: {
  accessHrId: string | null | undefined;
  actorHrId: string | null;
  existingNotes: string | null;
  notes?: string | null;
  now: Date;
}) {
  const trimmedNotes = typeof input.notes === "string" ? input.notes.trim() : "";
  const approvalNote = trimmedNotes.length > 0
    ? `Approved: ${trimmedNotes}`
    : `Approved by ${input.actorHrId ?? input.accessHrId ?? "system"}.`;

  return {
    updated_at: input.now.toISOString(),
    updated_by_hr_id: input.actorHrId,
    validation_notes: composeValidationNotes(input.existingNotes, approvalNote),
    validation_status: CUSTOMER_PHARMACY_APPROVED_STATUS,
  };
}

/**
 * A licence verdict is permanent with no correction path, and the Approve below writes `true` onto the
 * pharmacy. If a request approver already recorded that the trade name does NOT match the shop sign,
 * this release must not silently replace that answer: the link is rejected instead, or the licence
 * file is replaced (which resets the check to "not checked yet").
 */
export function assertRecordedVerdictAllowsRelease(recorded: boolean | null): void {
  if (recorded === false) {
    throw validationError(
      "A reviewer already recorded that the trade name on this licence does not match the shop sign, so it cannot be released on its licence. Reject the link, or replace the licence file to reset the check.",
      "license_mismatch_recorded",
    );
  }
}

export type CustomerPharmacyApprovalInput = {
  linkId: string;
  /**
   * For a pharmacy saved on its licence alone: the reviewer's answer to "does the trade name on the
   * licence match the shop sign?". Approving such a link REQUIRES an explicit `true` - releasing a
   * pharmacy as a request target without anyone having compared the two names is the one thing this
   * screen must not do. A name that does not match is a Reject.
   */
  licenseMatchesSign?: boolean | null;
  notes?: string | null;
};

/**
 * pending → admin_approved. Requires the link to currently be pending and active; the update is
 * conditioned on that same status in the `WHERE` clause (not just pre-checked) so a concurrent
 * decision on the same link loses the race cleanly instead of double-applying.
 */
export async function approveCustomerPharmacyLink(
  access: AccessContext,
  input: CustomerPharmacyApprovalInput,
): Promise<CustomerPharmacyLinkDecisionResult> {
  assertCustomerPharmacyMappingAccess(access);

  const linkId = requireLinkId(input.linkId);
  const existing = await fetchLinkStatus(linkId);
  if (!existing.active) throw conflictError("This customer pharmacy link is no longer active.");
  if (existing.validation_status !== "pending") {
    throw conflictError(
      `Only pending links can be approved. Current status: ${existing.validation_status ?? "unknown"}.`,
    );
  }

  // Owner rule 2026-09-22 ("never never never"): approving a link IS validating its venue, so a
  // wholesaler / makhzan is refused here — the one place a person turns a pending link into
  // `admin_approved`. Name-only (a marketing pharmacy code is a different code space from the SoS
  // override codes); the two-tier detector still protects owner pharmacy-overrides by name.
  const pharmacyName = await fetchLinkedPharmacyName(existing.pharmacy_id);
  if (isCertainWholesalerVenue(pharmacyName)) {
    throw validationError(WHOLESALER_VENUE_REFUSED_MESSAGE);
  }

  const actorHrId = await resolveActorStoredHrId(access);

  // A pharmacy saved on its licence alone (owner, 2026-10-14) is released on the strength of the
  // licence, so the release records the comparison: the verdict is written onto the pharmacy, where
  // the Customer Database register and the request approvers read it back. It is written BEFORE the
  // link moves - a lost race on the link then leaves a true statement behind (this person did read
  // the licence), whereas the other order could release a pharmacy with no recorded comparison.
  const releasedOnLicence = isLicenseOnlyPharmacyNote(existing.validation_notes);
  if (releasedOnLicence) {
    if (!existing.pharmacy_id) throw validationError("This link has no pharmacy, so there is no licence to read.");
    if (input.licenseMatchesSign !== true) {
      throw validationError(
        "Read the pharmacy licence and confirm its trade name matches the shop sign before approving. If it does not match, reject the link.",
        "license_check_required",
      );
    }
    const { data: licenseRow, error: licenseError } = await getSupabaseAdmin()
      .from("marketing_evidence_files")
      .select("id")
      .eq("entity_id", existing.pharmacy_id)
      .eq("evidence_type", "pharmacy_license")
      .limit(1)
      .maybeSingle();
    if (licenseError) throw licenseError;
    if (!licenseRow) {
      throw validationError("There is no licence on file for this pharmacy, so it cannot be released on its licence.");
    }
    const { data: verdictRow, error: verdictReadError } = await getSupabaseAdmin()
      .from("marketing_pharmacies")
      .select("license_name_matches_sign")
      .eq("id", existing.pharmacy_id)
      .maybeSingle();
    if (verdictReadError) throw verdictReadError;
    assertRecordedVerdictAllowsRelease((verdictRow as { license_name_matches_sign?: boolean | null } | null)?.license_name_matches_sign ?? null);
    const verdictNow = new Date().toISOString();
    const { error: verdictError } = await getSupabaseAdmin()
      .from("marketing_pharmacies")
      .update({
        ...licenseVerdictColumns({ actorHrId: access.hrId ?? null, matchesSign: true, now: verdictNow }),
        updated_at: verdictNow,
        updated_by_hr_id: actorHrId,
      })
      .eq("id", existing.pharmacy_id);
    if (verdictError) throw verdictError;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("marketing_customer_pharmacies")
    .update(
      buildCustomerPharmacyApprovalPatch({
        accessHrId: access.hrId,
        actorHrId,
        existingNotes: existing.validation_notes,
        notes: releasedOnLicence ? [input.notes, LICENSE_RELEASE_NOTE].filter(Boolean).join(" ") : input.notes,
        now: new Date(),
      }),
    )
    .eq("id", linkId)
    .eq("validation_status", "pending")
    .select("id, validation_status, validation_notes, updated_at, updated_by_hr_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("This link was just changed by someone else. Reload and try again.");

  // The decision that makes a venue a request target is a ruling about money, so it is audited and
  // the audit is REQUIRED: a link approved with no record of who approved it is the failure.
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: existing.pharmacy_id,
    entityType: "marketing_pharmacy",
    newValues: { linkId, licenseMatchesSign: releasedOnLicence ? true : null, validationStatus: CUSTOMER_PHARMACY_APPROVED_STATUS },
    oldValues: { validationStatus: existing.validation_status },
    summary: releasedOnLicence
      ? `Customer pharmacy link for "${pharmacyName ?? "a pharmacy"}" released on its licence by ${actorHrId ?? access.hrId ?? "unknown"}: trade name confirmed to match the shop sign.`
      : `Customer pharmacy link for "${pharmacyName ?? "a pharmacy"}" approved by ${actorHrId ?? access.hrId ?? "unknown"}.`,
  });

  bumpCustomer360Cache("customer pharmacy link approved");
  return toDecisionResult(data as LinkDecisionRow);
}

/**
 * pending → rejected. Requires a non-empty reason and the link to currently be pending and active.
 * The link is never deleted — only its status/notes/audit columns change, same as approve.
 */
export async function rejectCustomerPharmacyLink(
  access: AccessContext,
  input: { linkId: string; reason: string },
): Promise<CustomerPharmacyLinkDecisionResult> {
  assertCustomerPharmacyMappingAccess(access);

  const linkId = requireLinkId(input.linkId);
  const trimmedReason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!trimmedReason) throw validationError("A rejection reason is required.");

  const existing = await fetchLinkStatus(linkId);
  if (!existing.active) throw conflictError("This customer pharmacy link is no longer active.");
  if (existing.validation_status !== "pending") {
    throw conflictError(
      `Only pending links can be rejected. Current status: ${existing.validation_status ?? "unknown"}.`,
    );
  }

  const actorHrId = await resolveActorStoredHrId(access);
  const rejectionNote = `Rejected: ${trimmedReason}`;

  const { data, error } = await getSupabaseAdmin()
    .from("marketing_customer_pharmacies")
    .update({
      updated_at: new Date().toISOString(),
      updated_by_hr_id: actorHrId,
      validation_notes: composeValidationNotes(existing.validation_notes, rejectionNote),
      validation_status: "rejected",
    })
    .eq("id", linkId)
    .eq("validation_status", "pending")
    .select("id, validation_status, validation_notes, updated_at, updated_by_hr_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("This link was just changed by someone else. Reload and try again.");

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: existing.pharmacy_id,
    entityType: "marketing_pharmacy",
    newValues: { linkId, reason: trimmedReason, validationStatus: "rejected" },
    oldValues: { validationStatus: existing.validation_status },
    summary: `Customer pharmacy link rejected by ${actorHrId ?? access.hrId ?? "unknown"}: ${trimmedReason}`,
  });

  bumpCustomer360Cache("customer pharmacy link rejected");
  return toDecisionResult(data as LinkDecisionRow);
}
