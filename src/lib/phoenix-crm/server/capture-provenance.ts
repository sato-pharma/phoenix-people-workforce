/**
 * Phoenix CRM — filing WHEN the phone took the position it sent, and WHICH install sent it.
 *
 * The same two rules govern this file as govern `server/location-integrity.ts` beside it, and both
 * are the owner's (2026-09-25):
 *
 *   1. THE REP MUST NOT KNOW. This runs AFTER the save has already succeeded, it returns void, and
 *      nothing it writes is read back towards a rep. A visit whose provenance is perfect and one
 *      whose provenance is missing come back to him identical.
 *
 *   2. IT MUST NEVER COST A REP HIS VISIT. Every path is wrapped. The worst case is one unwritten
 *      row about a visit that is itself safely on file — never a rep standing in front of a doctor
 *      watching a save fail.
 *
 * WHY IT IS A SEPARATE FILE AND NOT FOUR MORE COLUMNS ON THE VISIT. `phoenix_crm_save_visit` is a
 * ~300-line database function that three migrations already replace in turn, and it inserts into
 * `phoenix_crm_visits` at two sites. Re-emitting it to carry four fields nothing on the save path
 * reads would put every visit at risk for evidence that is not needed until somebody asks a
 * question weeks later. So the row is written here, immediately after the save, exactly where
 * `judgeCapture` already runs.
 *
 * WHAT IS SERVER-READ AND WHAT IS NOT, deliberately:
 *
 *   · `fix_taken_at` and the install id come from the BODY — they are facts only the phone holds, and
 *     a patched build could of course lie about either. That is why neither refuses anything and why
 *     neither is ever the only evidence: the fix's own coordinates, its accuracy and the server's
 *     receipt are all on the visit already.
 *   · `app_revision` and `user_agent` are read on the SERVER, from the running build and from the
 *     request's own headers, so a patched client cannot report them falsely at all.
 *
 * 🔴 NOT A DEVICE SCAN. No package list, no APK inspection, no handset serial — the owner forbids a
 * package or APK scan by name. An install id is a random value a browser keeps in its own storage and
 * clears with its site data.
 */

import { headers } from "next/headers";

import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type CaptureProvenanceInput = {
  visitId: string;
  seatId: string;
  repHrId: string;
  /** The Cairo business day the visit itself filed under — copied, never re-derived here. */
  visitDate: string;
  /** The server's own receipt, as the saved visit returned it. */
  capturedAt: Date;
  /** The phone's clock when it took the position (`fixTakenAt`, entry-rules.ts). */
  fixTakenAt: string | null;
  /** The phone's clock at the TAP, which is what makes the age above measurable. */
  deviceCapturedAt: string | null;
  deviceInstallId: string | null;
  /** How long the phone held this save before it arrived (visit-resend-rules.ts). Null for a save never held. */
  queuedSeconds: number | null;
  isTest: boolean;
};

/**
 * How old the reading already was when he pressed, in whole seconds.
 *
 * 🔴 BOTH ENDS ON THE PHONE'S OWN CLOCK, so a handset that is an hour out still answers correctly —
 * the error is in both terms and cancels. Null is NOT MEASURED and must never be read as zero, which
 * is the one answer that would mean "taken at the instant he tapped".
 *
 * A NEGATIVE age — a reading stamped after the tap — is not a measurement of anything, so it lands as
 * null rather than as a clamped 0 that would read as a perfect capture. Nothing is lost: `fix_taken_at`
 * is stored raw beside it, and the visit's own `device_skew_minutes` already carries the phone's
 * disagreement with the server.
 */
export function fixAgeSeconds(fixTakenAt: string | null, deviceCapturedAt: string | null): number | null {
  if (!fixTakenAt || !deviceCapturedAt) return null;
  const taken = Date.parse(fixTakenAt);
  const tapped = Date.parse(deviceCapturedAt);
  if (Number.isNaN(taken) || Number.isNaN(tapped)) return null;
  const seconds = Math.floor((tapped - taken) / 1000);
  return seconds >= 0 ? seconds : null;
}

/** The request's own User-Agent, or null. Never throws: outside a request scope there is none. */
async function userAgent(): Promise<string | null> {
  try {
    const value = (await headers()).get("user-agent");
    return value ? value.slice(0, 400) : null;
  } catch {
    return null;
  }
}

/**
 * Files one visit's capture provenance. Answers nothing, and swallows everything it can produce.
 *
 * A repeat save of the same visit id upserts rather than piling rows up — the visit's own id is the
 * primary key, so the one row always describes the capture that actually stands.
 */
export async function recordCaptureProvenance(input: CaptureProvenanceInput): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("phoenix_crm_visit_capture_provenance")
      .upsert(
        {
          visit_id: input.visitId,
          seat_id: input.seatId,
          rep_hr_id: input.repHrId.toUpperCase(),
          visit_date: input.visitDate,
          captured_at: input.capturedAt.toISOString(),
          fix_taken_at: input.fixTakenAt,
          fix_age_seconds: fixAgeSeconds(input.fixTakenAt, input.deviceCapturedAt),
          queued_seconds: input.queuedSeconds,
          device_install_id: input.deviceInstallId,
          app_revision: getDeployRevision(),
          user_agent: await userAgent(),
          is_test: input.isTest,
        },
        { onConflict: "visit_id" },
      );
    // Logged, never thrown and never returned: the visit it describes is already saved and answered.
    if (error) console.error("[phoenix-crm] capture provenance not filed", error.message);
  } catch (error) {
    console.error("[phoenix-crm] capture provenance not filed", error);
  }
}
