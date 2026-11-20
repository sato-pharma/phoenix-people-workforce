/**
 * Phoenix CRM — a photo sealed by the Phoenix Camera, judged on the server before it can validate a place
 * (owner, 20 Nov 2026: the separate camera app for a clinic with no network, "with every precaution against fake
 * locations and fraud, and keep its seal").
 *
 * field-camera-seal.ts judges the file itself (the picture, the signature, the phone's secure chip, our app, the payload). This
 * adds what needs Phoenix or the internet:
 *   - GOOGLE'S REVOCATION LIST: a phone whose attestation key leaked is refused. A list that cannot be read is
 *     said, never taken as clean, and does not refuse (the phone's chip already vouched).
 *   - ONE SEAL, ONE USE: a seal already standing behind another customer's watch is refused.
 *   - THE REP: the seal's HR id must be a Phoenix employee. A different person from the territory's rep, and a
 *     phone that sealed for somebody else before, are told to the Super Admin — he decides.
 */

import { validationError } from "@/lib/http/api-errors";
import { GOOGLE_ATTESTATION_ROOTS } from "@/lib/phoenix-crm/field-camera/google-roots";
import { RELEASE_IDENTITY, verifySealedPhoto } from "@/lib/phoenix-crm/server/field-camera-seal";
import type { SealPayload } from "@/lib/phoenix-crm/field-camera/seal-rules";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const REVOCATION_URL = "https://android.googleapis.com/attestation/status";
const REVOCATION_TTL_MS = 60 * 60 * 1000;
const REVOCATION_TIMEOUT_MS = 8_000;

let revocationCache: { at: number; revoked: Set<string> } | null = null;

/**
 * Google's revoked attestation serials (lower-case hex) and how fresh the copy is. A failed read keeps the last good
 * list; with no list ever read the seal is REFUSED — a leaked factory key is only stopped by this list, so an
 * unread list is never a pass.
 */
async function loadRevokedSerials(): Promise<{ revoked: Set<string>; fresh: boolean } | null> {
  if (revocationCache && Date.now() - revocationCache.at < REVOCATION_TTL_MS) return { revoked: revocationCache.revoked, fresh: true };
  try {
    const response = await fetch(REVOCATION_URL, { cache: "no-store", signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`revocation list answered ${response.status}`);
    const body = (await response.json()) as { entries?: Record<string, unknown> };
    const revoked = new Set(Object.keys(body.entries ?? {}).map((serial) => serial.toLowerCase().replace(/^0+/, "")));
    revocationCache = { at: Date.now(), revoked };
    return { revoked, fresh: true };
  } catch {
    return revocationCache ? { revoked: revocationCache.revoked, fresh: false } : null;
  }
}

/** What is kept beside the watch, and shown to the Super Admin. No photo, no key — only what the seal said. */
export type FieldCameraReport = {
  sealId: string;
  deviceKey: string;
  securityLevel: "TEE" | "StrongBox";
  revocation: "checked" | "last_copy";
  takenAtUtc: string;
  hrId: string;
  repName: string;
  lat: number;
  lon: number;
  accuracyMeters: number;
  satellitesUsed: number;
  satellitesSeen: number;
  deviceModel: string;
  androidSdk: number;
  appVersion: string;
  phoneClockUtc: string;
  networkTimeUtc: string | null;
  warnings: string[];
};

export type FieldCameraCheck = { payload: SealPayload; report: FieldCameraReport };

/**
 * Judge a sealed file for a watch on `seat`. Throws a validation error naming the first thing that does not hold;
 * returns the payload and the report to keep when it all does.
 */
export async function checkFieldCameraPhoto(
  bytes: Uint8Array,
  context: { occupantHrIds: readonly string[] },
): Promise<FieldCameraCheck> {
  const verdict = verifySealedPhoto(bytes, { rootsPem: GOOGLE_ATTESTATION_ROOTS.map((root) => root.pem), identity: RELEASE_IDENTITY });
  if (!verdict.ok) throw validationError(`The Phoenix Camera seal does not hold: ${verdict.problem}`, "phoenix_crm_admin_photo_bad_seal");
  const { payload } = verdict;
  const warnings = [...verdict.warnings];

  const revocation = await loadRevokedSerials();
  if (!revocation) {
    throw validationError(
      "Google's list of withdrawn phone certificates cannot be read just now, so the seal cannot be checked. Try again in a minute.",
      "phoenix_crm_admin_photo_revocation_unread",
    );
  }
  const revoked = revocation.revoked;
  if (verdict.serials.some((serial) => revoked.has(serial.replace(/^0+/, "")))) {
    throw validationError(
      "The Phoenix Camera seal does not hold: Google has withdrawn this phone's security certificate.",
      "phoenix_crm_admin_photo_bad_seal",
    );
  }
  if (!revocation.fresh) warnings.push("Google's list of withdrawn phone certificates could not be read just now; the last copy Phoenix read was used.");

  const admin = getSupabaseAdmin();
  const used = await admin
    .from("phoenix_crm_admin_photo_validations")
    .select("id")
    .eq("seal_id", verdict.sealId)
    .neq("status", "cancelled")
    .limit(1);
  throwIfError(used.error);
  if ((used.data ?? []).length > 0) {
    throw validationError("This sealed photo was already used for a customer. Each photo validates one customer.", "phoenix_crm_admin_photo_seal_used");
  }

  const occupants = context.occupantHrIds.map((id) => id.trim().toUpperCase()).filter(Boolean);
  const occupant = occupants[0] ?? null;
  const history = await admin
    .from("phoenix_crm_admin_photo_validations")
    .select("rep_hr_id")
    .eq("seal_report->>deviceKey", verdict.deviceKey)
    .neq("rep_hr_id", payload.hrId)
    .limit(5);
  throwIfError(history.error);
  const others = [...new Set(((history.data ?? []) as { rep_hr_id: string | null }[]).map((row) => row.rep_hr_id).filter((id): id is string => Boolean(id)))];

  const names = await loadPeopleNames([payload.hrId, occupant, ...others]);
  const unknown = "\u0000";
  if (nameOf(names, payload.hrId, unknown) === unknown) {
    throw validationError(
      `The Phoenix Camera seal names ${payload.hrId}, who is not a Phoenix employee. Ask the rep to enter their own HR id in the app.`,
      "phoenix_crm_admin_photo_seal_person",
    );
  }
  // The place is created in the name of the person the seal names, so it must be this territory's own rep.
  if (occupant && !occupants.includes(payload.hrId)) {
    throw validationError(
      `The photo was sealed by ${nameOf(names, payload.hrId, payload.hrId)}, not by this territory's rep, ${nameOf(names, occupant, occupant)}. Only the territory's own rep's sealed photo is accepted.`,
      "phoenix_crm_admin_photo_seal_not_rep",
    );
  }
  if (!occupant) {
    throw validationError(
      "This territory has no rep now, so a sealed photo cannot validate its customers.",
      "phoenix_crm_admin_photo_seal_not_rep",
    );
  }
  if (others.length > 0) {
    warnings.push(`This phone sealed photos for ${others.map((id) => nameOf(names, id, id)).join(", ")} before.`);
  }

  return {
    payload,
    report: {
      sealId: verdict.sealId,
      deviceKey: verdict.deviceKey,
      securityLevel: verdict.securityLevel,
      revocation: revocation.fresh ? "checked" : "last_copy",
      takenAtUtc: payload.takenAtUtc,
      hrId: payload.hrId,
      repName: payload.repName,
      lat: payload.lat,
      lon: payload.lon,
      accuracyMeters: payload.accuracyMeters,
      satellitesUsed: payload.satellitesUsed,
      satellitesSeen: payload.satellitesSeen,
      deviceModel: payload.deviceModel,
      androidSdk: payload.androidSdk,
      appVersion: payload.appVersion,
      phoneClockUtc: payload.phoneClockUtc,
      networkTimeUtc: payload.networkTimeUtc,
      warnings,
    },
  };
}
