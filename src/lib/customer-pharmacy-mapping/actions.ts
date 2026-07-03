// Customer Pharmacy Mapping — approve/reject link-management actions.
//
// Deliberately independent from `src/lib/marketing-requests`, matching the standalone rule
// established for this module in `readiness.ts`. Mutates exactly one existing row in
// `marketing_customer_pharmacies` per call: `validation_status`, `validation_notes`, and the
// `updated_at` / `updated_by_hr_id` audit columns. No delete, no bulk actions, no merge logic,
// no automatic matching — every call targets a single `linkId` supplied by the caller.

import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { canonicalHrIdKey, resolveStoredHrId, type StoredHrIdDirectoryEntry } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
    .select("id, validation_status, validation_notes, active")
    .eq("id", linkId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError(`Customer pharmacy link ${linkId} was not found.`);
  return data as LinkStatusRow;
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
 * pending → system_validated. Requires the link to currently be pending and active; the update is
 * conditioned on that same status in the `WHERE` clause (not just pre-checked) so a concurrent
 * decision on the same link loses the race cleanly instead of double-applying.
 */
export async function approveCustomerPharmacyLink(
  access: AccessContext,
  input: { linkId: string; notes?: string | null },
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

  const actorHrId = await resolveActorStoredHrId(access);
  const trimmedNotes = typeof input.notes === "string" ? input.notes.trim() : "";
  const approvalNote = trimmedNotes.length > 0
    ? `Approved: ${trimmedNotes}`
    : `Approved by ${actorHrId ?? access.hrId ?? "system"}.`;

  const { data, error } = await getSupabaseAdmin()
    .from("marketing_customer_pharmacies")
    .update({
      updated_at: new Date().toISOString(),
      updated_by_hr_id: actorHrId,
      validation_notes: composeValidationNotes(existing.validation_notes, approvalNote),
      validation_status: "system_validated",
    })
    .eq("id", linkId)
    .eq("validation_status", "pending")
    .select("id, validation_status, validation_notes, updated_at, updated_by_hr_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError("This link was just changed by someone else. Reload and try again.");

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

  return toDecisionResult(data as LinkDecisionRow);
}
