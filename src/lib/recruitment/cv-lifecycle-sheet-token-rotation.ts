import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { rotatedLabel } from "@/lib/share-links/rotated-label";
import { hashShareToken, shareTokenPreview } from "@/lib/share-links/token-hash";

// ─────────────────────────────────────────────────────────────────────────────
// Rotate the CV-lifecycle sheet's feed token, end to end, with nobody opening an editor.
//
// A port of src/lib/marketing-requests/sheet-token-rotation.ts, which is itself a port of the
// direct-orders one. The third sheet shipped without rotation and the cost showed within a day:
// its only token was minted by hand in SQL on 2026-09-04, and replacing it on 2026-09-05 took a
// human minting a link, pasting a URL into Apps Script, and a second human confirming the sheet had
// read it. That is a fine thing to do once. It is not a thing to rely on happening every week, and
// a token nobody rotates is a token that reads every candidate's name and phone number forever.
//
// ORDER MATTERS, AND IT IS THE WHOLE DESIGN
//   1. mint the new link          — old one still works
//   2. push it to the sheet       — fire it, but do NOT trust the reply
//   3. observe that the sheet USED the new token — evidence, not a claim
//   4. ONLY THEN revoke the old   — and only if step 3 actually observed a read
//
// Revoking first, or revoking on an unconfirmed push, strands the owner with a sheet that cannot
// read anything. A rotation that fails half-way leaves everything working on the old token.
//
// THE EXPIRY IS INHERITED, NOT RESET. Owner decision, 2026-09-05, and it is the same choice both
// sibling rotations make. Each token lives a week, so a leak self-heals — but the LINK still dies
// on its original date, and cv-lifecycle-link-expiry-alert.ts warns for the 30 days before that.
// Resetting the clock on every rotation would quietly turn a mandatory 365-day expiry into a
// perpetual credential, which is the exact thing createCvLifecycleShareLink's own cap exists to
// prevent: "a link with no practical end date becomes an unowned copy of the candidate pool."
//
// The consequence is deliberate and worth stating: as the expiry approaches, rotation can no longer
// help, because it would mint a link that is already dying. `EXPIRY_FLOOR_MS` below refuses in that
// window rather than doing it — see the comment there.
// ─────────────────────────────────────────────────────────────────────────────

const ROTATION_TIMEOUT_MS = 15000;

/**
 * How long to wait for the sheet to PROVE it took the new token, and how often to look.
 *
 * Proof is an actual read: the script calls refreshCvLifecycle() straight after storing the token,
 * which fetches the feed and bumps that link's access_count. 40s is generous and still leaves room
 * inside the route's 60s maxDuration.
 */
const CONFIRM_WINDOW_MS = 40000;
const CONFIRM_POLL_MS = 2500;

/**
 * Refuse to rotate a link with less than this left, because the replacement inherits the expiry and
 * would therefore be born nearly dead — a "successful" rotation that leaves the sheet days from
 * going dark, having just revoked the only token that was working.
 *
 * Two days rather than two hours: the rotation cron runs WEEKLY, so anything inside a week is
 * already the last rotation this link will ever get. Refusing loudly here is the correct outcome —
 * the expiry alarm has been telling a human for 30 days by this point, and what is needed is a new
 * link, not a new token on a dying one.
 */
const EXPIRY_FLOOR_MS = 2 * 24 * 60 * 60 * 1000;

const TABLE = "ats_cv_lifecycle_share_links";

/** Has the sheet actually fetched with this token yet? */
async function tokenHasBeenUsed(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  token: string,
): Promise<boolean> {
  const { data } = await supabase.from(TABLE).select("access_count").eq("token_hash", hashShareToken(token)).maybeSingle();
  return Number((data as { access_count?: number } | null)?.access_count ?? 0) > 0;
}

export type CvLifecycleSheetTokenRotationResult =
  | { rotated: false; reason: string }
  | { rotated: true; newTokenPreview: string; revokedTokenPreview: string };

/** Never log or return a whole token — the first 8 characters are enough to correlate. */
function preview(token: string): string {
  return `${shareTokenPreview(token)}…`;
}

/** 32 random bytes, URL-safe — the same shape createCvLifecycleShareLink mints. */
async function mintToken(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return randomBytes(32).toString("base64url");
}

/**
 * Rotate the feed token behind the owner's live CV-lifecycle sheet.
 *
 * Deliberately takes the CURRENT webhook credentials from the environment rather than a caller
 * argument: the thing being rotated is whatever Phoenix is actually configured with, and letting a
 * caller name a different one would make it possible to revoke a link this deployment is not using.
 */
export async function rotateCvLifecycleSheetToken(): Promise<CvLifecycleSheetTokenRotationResult> {
  const webhookUrl = process.env.CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL?.trim();
  const currentSecret = process.env.CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !currentSecret) {
    return { rotated: false, reason: "cv-lifecycle sheet webhook is not configured; nothing to rotate" };
  }

  const supabase = getSupabaseAdmin();
  // The live FEED link — the newest unrevoked one. Selecting it rather than matching a stored token
  // is what makes rotation repeatable rather than a one-shot.
  const { data: rows } = await supabase
    .from(TABLE)
    .select("*")
    .eq("surface", "feed")
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(2);
  const live = (rows ?? []) as Array<Record<string, unknown>>;
  if (live.length === 0) {
    return { rotated: false, reason: "no live cv-lifecycle feed share link exists to rotate" };
  }
  if (live.length > 1) {
    // More than one live link means an earlier rotation left a stray, or someone minted a second by
    // hand — which is exactly what a mid-rotation state looks like. Rotating blind could revoke the
    // one the sheet is actually using, so stop and say so.
    return {
      rotated: false,
      reason: `${live.length} live cv-lifecycle feed links exist; resolve the ambiguity before rotating`,
    };
  }
  const old = live[0]!;

  const expiresAt = String(old.expires_at ?? "");
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) {
    return { rotated: false, reason: "the live link has an unreadable expiry; refusing to rotate blind" };
  }
  if (expiresMs - Date.now() < EXPIRY_FLOOR_MS) {
    // See EXPIRY_FLOOR_MS. Rotating here would revoke a working token and mint one that dies in
    // hours — the failure would look exactly like a successful rotation until the sheet went quiet.
    return {
      rotated: false,
      reason:
        `the live link expires ${expiresAt.slice(0, 10)}, inside the ${EXPIRY_FLOOR_MS / 86400000}-day floor. ` +
        `The replacement inherits that date, so rotating would revoke a working token for a dying one — ` +
        `mint a NEW link from /recruitment/cv-lifecycle-sheet instead`,
    };
  }

  // 1. Mint the replacement, carrying the SAME expiry. A rotation is the same link with a new name.
  const newToken = await mintToken();
  const { error: insertError } = await supabase.from(TABLE).insert({
    created_by_hr_id: String(old.created_by_hr_id ?? ""),
    expires_at: expiresAt,
    label: rotatedLabel(old.label, "Rotated CV-lifecycle feed link"),
    surface: String(old.surface ?? "feed"),
    token_hash: hashShareToken(newToken),
    token_preview: shareTokenPreview(newToken),
  });
  if (insertError) throw insertError;

  // 2. Hand it to the sheet, authorised by the webhook secret still in force.
  //
  // The reply is NOT the confirmation. Apps Script answers a POST with a 302, and per the fetch
  // spec a 302 on POST is followed as a GET — so what comes back is whatever that redirect serves,
  // often an HTML page, even though doPost has already run and done the work. Trusting that body
  // made the direct-orders rotation report failure over success twice on 2026-08-05.
  try {
    await fetch(webhookUrl, {
      body: JSON.stringify({ reason: "token_rotation", rotateToken: newToken, secret: currentSecret }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "follow",
      signal: AbortSignal.timeout(ROTATION_TIMEOUT_MS),
    });
  } catch (error) {
    // Even a thrown fetch is not proof of failure — the request may well have been delivered and
    // processed before the connection went wrong. The observation below decides, not this.
    logWarning("CV-lifecycle sheet token rotation: the push errored (the observation still decides)", {
      error,
      labels: { event: "cv_lifecycle_sheet_rotation_push_error" },
    });
  }

  // 3. Confirm by OBSERVATION, on our side of the wire.
  //
  // The sheet proves it stored the token by USING it: the script calls refreshCvLifecycle()
  // immediately after saving, which fetches the feed and bumps that link's access_count. A read we
  // recorded ourselves cannot be faked by a redirect, an HTML error page, or a flaky connection.
  let confirmed = false;
  const deadline = Date.now() + CONFIRM_WINDOW_MS;
  while (Date.now() < deadline) {
    if (await tokenHasBeenUsed(supabase, newToken)) {
      confirmed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }

  if (!confirmed) {
    // The sheet never took the new token. Delete the one we minted and leave everything on the old
    // one — a working sheet with an old token beats a dead sheet with a new one. Deleting also
    // keeps the "more than one live link" guard above meaningful on the next run.
    await supabase.from(TABLE).delete().eq("token_hash", hashShareToken(newToken));
    return {
      rotated: false,
      reason:
        `the sheet never read with the new token within ${Math.round(CONFIRM_WINDOW_MS / 1000)}s, ` +
        `so it was deleted and nothing was revoked — the old token is still live and the sheet keeps working`,
    };
  }

  // 4. Confirmed by observation — only now can the old one go.
  await supabase
    .from(TABLE)
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: "system:rotation" })
    .eq("id", String(old.id));

  await writeRequiredAuditLog({
    actorLoginId: "system:rotation",
    entityId: `share-link:${shareTokenPreview(newToken)}`,
    entityType: "cv_lifecycle_share_link",
    newValues: { confirmedBySheet: true, expiresAt, token: preview(newToken) },
    oldValues: { revoked: true, token: `${String(old.token_preview ?? "")}…` },
    summary:
      `CV-lifecycle live sheet feed token rotated. The sheet confirmed the new token before the old ` +
      `one was revoked, so a previously exposed token no longer reads any candidate's name or phone ` +
      `number. Expiry unchanged at ${expiresAt.slice(0, 10)}.`,
  });

  return {
    newTokenPreview: preview(newToken),
    revokedTokenPreview: `${String(old.token_preview ?? "")}…`,
    rotated: true,
  };
}
