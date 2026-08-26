import { writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE } from "@/lib/marketing-requests/evidence-photo-storage";
import { getMarketingRequestDecisionSummary } from "@/lib/marketing-requests/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// "Does the trade name on the licence match the name on the shop sign?" — recorded, on the
// marketing side.
//
// The Direct Orders validation desk has asked and stored this since 20260825120000. The marketing
// approver could already SEE both documents — the storefront photo and the licence sit stacked in
// the target-pharmacy row for exactly this comparison — but no answer was ever captured, so the
// check existed as an invitation rather than as evidence. This is the service behind the control
// that closes it.
//
// THREE-VALUED, LIKE EVERY OTHER VERDICT IN THIS REPO. `null` is not "no", it is "nobody was
// asked", and clearing a mis-click must return the row to exactly that state rather than to a
// recorded false. The database enforces the shape (all three columns set, or all three null);
// this module enforces the two things a CHECK constraint cannot see.
//
// IT NEVER BLOCKS A DECISION. Recording a mismatch does not reject the pharmacy, hold the request,
// or change validation_status — the system flags, it never rejects (owner's standing rule). What
// it does is make the answer durable and attributable, so the next person to look knows whether
// anyone actually compared the two names.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type MarketingPharmacyLicenseVerdictInput = {
  /** `true` matches, `false` differs, `null` clears the answer back to "nobody was asked". */
  matchesSign: boolean | null;
  pharmacyId: string;
  requestId: string;
};

export type MarketingPharmacyLicenseVerdictResult = {
  checkedAt: string | null;
  checkedByHrId: string | null;
  matchesSign: boolean | null;
  pharmacyId: string;
};

/**
 * Normalise whatever arrived over the wire into the three-valued answer.
 *
 * ONLY an explicit `true` or `false` is an answer. Everything else — undefined, a missing key, a
 * string "true", a number — clears back to "nobody was asked". A verdict accuses a real pharmacy of
 * carrying a name that does not match its licence, so it must never be arrived at by coercion.
 */
export function parseLicenseVerdict(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/**
 * The three columns, always moving together.
 *
 * `marketing_pharmacies_license_verdict_check` refuses any other shape: a verdict with no author,
 * or an author and a timestamp stranded beside a cleared verdict. Building the patch in one place
 * means the constraint can only ever be hit by a bug in this function, rather than by any of the
 * call sites forgetting one field.
 */
export function licenseVerdictColumns(input: {
  actorHrId: string | null;
  matchesSign: boolean | null;
  now: string;
}): {
  license_name_checked_at: string | null;
  license_name_checked_by_hr_id: string | null;
  license_name_matches_sign: boolean | null;
} {
  if (input.matchesSign === null) {
    return {
      license_name_checked_at: null,
      license_name_checked_by_hr_id: null,
      license_name_matches_sign: null,
    };
  }
  return {
    license_name_checked_at: input.now,
    license_name_checked_by_hr_id: input.actorHrId,
    license_name_matches_sign: input.matchesSign,
  };
}

/**
 * Record (or clear) one approver's verdict on one pharmacy's trade licence.
 *
 * AUTHORIZATION IS BORROWED, DELIBERATELY. `getMarketingRequestDecisionSummary(…, "approve", …)`
 * is the same gate that guards the approver detail screen — it throws unless the caller holds the
 * request's CURRENT approval step. Reusing it verbatim means the right to record the verdict can
 * never drift from the right to see the licence it is about. Rolling a fresh permission check here
 * would be a second copy of a visibility rule, which is how the two ends of a gate stop agreeing.
 */
export async function recordMarketingPharmacyLicenseVerdict(
  access: AccessContext,
  input: MarketingPharmacyLicenseVerdictInput,
): Promise<MarketingPharmacyLicenseVerdictResult> {
  const requestId = String(input.requestId ?? "").trim();
  const pharmacyId = String(input.pharmacyId ?? "").trim();
  if (!requestId) throw validationError("Marketing request ID is required.");
  if (!pharmacyId) throw validationError("Pharmacy ID is required.");

  const matchesSign = parseLicenseVerdict(input.matchesSign);

  // Throws unless this caller holds the current step of THIS request.
  const summary = await getMarketingRequestDecisionSummary(requestId, "approve", access);

  // …and the pharmacy must actually be on that request. Without this, holding one approval step
  // would license writing a verdict onto ANY pharmacy in the company by passing its id — the
  // request id would authorize, and the pharmacy id would go unchecked. The two must be tied.
  const onThisRequest = summary.targetPharmacies.some(
    (pharmacy) => pharmacy.pharmacyId != null && String(pharmacy.pharmacyId) === pharmacyId,
  );
  if (!onThisRequest) {
    throw notFoundError("That pharmacy is not on this marketing request.");
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // A verdict about a licence that is not on file is not a verdict about anything. The direct-order
  // table refuses this shape with a CHECK, because the licence path sits on the same row it does;
  // here the licence lives in marketing_evidence_files, so the guard has to be right here.
  //
  // Only on the way IN. Clearing is always allowed — otherwise a verdict recorded before a licence
  // was replaced or removed could never be taken back.
  if (matchesSign !== null) {
    const { data: licenseRow, error: licenseError } = await supabase
      .from("marketing_evidence_files")
      .select("id")
      .eq("entity_id", pharmacyId)
      .eq("evidence_type", MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE)
      .limit(1)
      .maybeSingle();
    if (licenseError) throw licenseError;
    if (!licenseRow) {
      throw validationError("There is no pharmacy licence on file for this pharmacy to check.");
    }
  }

  const actorHrId = access.hrId ?? null;
  if (matchesSign !== null && !actorHrId) {
    // The DB constraint would refuse this anyway; failing here says why in words an approver can
    // act on, rather than surfacing a constraint name.
    throw validationError("Your HR id could not be resolved, so the check cannot be attributed.");
  }

  const { error: updateError } = await supabase
    .from("marketing_pharmacies")
    .update({
      // All three move together — see licenseVerdictColumns.
      ...licenseVerdictColumns({ actorHrId, matchesSign, now }),
      updated_by_hr_id: actorHrId,
      updated_at: now,
      // NOTHING ELSE. validation_status and evidence_status are deliberately untouched: a licence
      // name that does not match is a FLAG for the approver, not a rejection of the venue (owner's
      // standing rule). Demoting the pharmacy here would make the check something a rep learns to
      // avoid triggering.
    })
    .eq("id", pharmacyId);
  if (updateError) throw updateError;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "marketing_pharmacy",
    entityId: pharmacyId,
    newValues: { licenseNameMatchesSign: matchesSign, requestId },
    summary:
      matchesSign === null
        ? `Pharmacy licence name check cleared by ${actorHrId ?? "unknown"}.`
        : `Pharmacy licence name ${matchesSign ? "confirmed to match" : "recorded as NOT matching"} the shop sign by ${actorHrId ?? "unknown"}.`,
  });

  return {
    checkedAt: matchesSign === null ? null : now,
    checkedByHrId: matchesSign === null ? null : actorHrId,
    matchesSign,
    pharmacyId,
  };
}
