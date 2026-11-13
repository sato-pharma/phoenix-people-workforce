import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { rotatedLabel } from "@/lib/share-links/rotated-label";
import { hashShareToken, shareTokenPreview } from "@/lib/share-links/token-hash";

// ─────────────────────────────────────────────────────────────────────────────
// Rotate the live sheet's feed token, end to end, with nobody opening an editor.
//
// WHY THIS EXISTS
// The Apps Script that drives the owner's sheet is committed to this repository, and it has to
// start life knowing SOME token. That bootstrap value therefore lives in git history permanently.
// Rotation is what makes that harmless: once Phoenix hands the sheet a fresh token, the live one
// sits in a Script Property (committed nowhere) and the bootstrap is revoked, so the copy in git
// opens nothing.
//
// ORDER MATTERS, AND IT IS THE WHOLE DESIGN
//   1. mint the new link          — old one still works
//   2. push it to the sheet       — fire it, but do NOT trust the reply
//   3. observe that the sheet USED the new token — evidence, not a claim
//   4. ONLY THEN revoke the old   — and only if step 3 actually observed a read
//
// Revoking first, or revoking on an unconfirmed push, would leave the owner with a sheet that
// cannot read anything and no way to fix it except by hand — the exact failure this is meant to
// remove. A rotation that fails half-way leaves everything working on the old token.
//
// THE WEBHOOK SECRET DOES NOT ROTATE WITH IT, AND MUST NOT.
// The sheet's default webhook secret IS its feed token, so rotating the token would move the secret
// too — while SHEET_REFRESH_WEBHOOK_SECRET here still held the old value, because a running app
// cannot rewrite its own environment. Every push after the first rotation would be denied silently,
// the sheet falling back to its 60-second timer with nobody the wiser. The script therefore PINS
// the current secret as an explicit Script Property before storing the new token, permanently
// separating "may trigger a refresh" from "may read the data". Only the latter rotates.
// ─────────────────────────────────────────────────────────────────────────────

const ROTATION_TIMEOUT_MS = 15000;

/**
 * How long to wait for the sheet to PROVE it took the new token, and how often to look.
 *
 * Proof is an actual read: the script calls refreshDirectOrders() straight after storing the token,
 * which fetches the feed and bumps that link's access_count. Google usually does this within a
 * couple of seconds; 40s is generous and still leaves room inside the route's 60s maxDuration.
 */
const CONFIRM_WINDOW_MS = 40000;
const CONFIRM_POLL_MS = 2500;

/** Has the sheet actually fetched with this token yet? */
async function tokenHasBeenUsed(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  token: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("direct_order_report_share_links")
    .select("access_count")
    .eq("token_hash", hashShareToken(token))
    .maybeSingle();
  return Number((data as { access_count?: number } | null)?.access_count ?? 0) > 0;
}

export type SheetTokenRotationResult =
  | { rotated: false; reason: string }
  | { rotated: true; newTokenPreview: string; revokedTokenPreview: string };

/** Never log or return a whole token — the first 8 characters are enough to correlate. */
function preview(token: string): string {
  return `${shareTokenPreview(token)}…`;
}

/** 32 random bytes, URL-safe — same shape the share-link service mints. */
async function mintToken(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return randomBytes(32).toString("base64url");
}

/**
 * Rotate the feed token behind the owner's live sheet.
 *
 * Deliberately takes the CURRENT token from the environment rather than a caller argument: the
 * thing being rotated is whatever Phoenix is actually configured with, and letting a caller name a
 * different one would make it possible to revoke a link this deployment is not even using.
 */
export async function rotateDirectOrderSheetToken(): Promise<SheetTokenRotationResult> {
  const webhookUrl = process.env.SHEET_REFRESH_WEBHOOK_URL?.trim();
  const currentSecret = process.env.SHEET_REFRESH_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !currentSecret) {
    return { rotated: false, reason: "sheet webhook is not configured; nothing to rotate" };
  }

  const supabase = getSupabaseAdmin();
  // Find the live FEED link, not the one matching the webhook secret.
  //
  // Those are the same thing only before the first rotation. Afterwards the secret is pinned to the
  // original (now revoked) token while the feed token has moved on — so looking up by secret would
  // find a revoked row and refuse, making rotation a one-shot. Selecting the newest unrevoked feed
  // link is what makes this repeatable.
  const { data: rows } = await supabase
    .from("direct_order_report_share_links")
    .select("*")
    .eq("surface", "feed")
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(2);
  const live = (rows ?? []) as Array<Record<string, unknown>>;
  if (live.length === 0) {
    return { rotated: false, reason: "no live feed share link exists to rotate" };
  }
  if (live.length > 1) {
    // More than one live feed link means an earlier rotation left a stray, or someone created a
    // second by hand. Rotating blind could revoke the one actually in use, so stop and say so.
    return { rotated: false, reason: `${live.length} live feed links exist; resolve the ambiguity before rotating` };
  }
  const old = live[0];

  // 1. Mint the replacement, carrying the SAME frozen scope. A rotation must not widen or narrow
  //    what the link can see — it is the same link with a new name. allow_files rides along for
  //    the same reason: the evidence photographs must stay exactly as reachable as before, no more.
  //    Leaving it out does not fail — the column defaults to false — and that is how every rotation
  //    from 2026-08-23 minted a link the live sheet could no longer open a single photo with.
  const newToken = await mintToken();
  const { error: insertError } = await supabase.from("direct_order_report_share_links").insert({
    token_hash: hashShareToken(newToken),
    token_preview: shareTokenPreview(newToken),
    surface: String(old.surface ?? "feed"),
    label: rotatedLabel(old.label, "Rotated feed link"),
    created_by_hr_id: String(old.created_by_hr_id ?? ""),
    scope: String(old.scope ?? "own"),
    scope_hr_id: String(old.scope_hr_id ?? ""),
    filters: old.filters ?? null,
    passcode_hash: old.passcode_hash ?? null,
    expires_at: String(old.expires_at),
    allow_files: old.allow_files ?? false,
  });
  if (insertError) throw insertError;

  // 2. Hand it to the sheet, authorised by the token still in force.
  //
  // The reply is NOT the confirmation, and this is the whole point of the fix. Apps Script answers
  // a POST with a 302, and per the fetch spec a 302 on POST is followed as a GET — so what comes
  // back is whatever that redirect serves, often an HTML page, even though doPost has already run
  // and done the work. Trusting that body made the rotation refuse twice on 2026-08-05 while the
  // sheet had in fact stored the new token perfectly. It reported failure over success.
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: currentSecret, reason: "token_rotation", rotateToken: newToken }),
      signal: AbortSignal.timeout(ROTATION_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    // Even a thrown fetch is not proof of failure — the request may well have been delivered and
    // processed before the connection went wrong. The observation below decides, not this.
    logWarning("Direct Orders sheet token rotation: the push errored (the observation still decides)", {
      labels: { event: "direct_order_sheet_rotation_push_error" },
      error,
    });
  }

  // 3. Confirm by OBSERVATION, on our side of the wire.
  //
  // The sheet proves it stored the token by USING it: the script calls refreshDirectOrders()
  // immediately after saving, which fetches the feed and bumps that link's access_count. A read we
  // recorded ourselves cannot be faked by a redirect, an HTML error page, or a flaky connection —
  // it is the difference between a claim and evidence.
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
    // The sheet never took the new token. Clean up the one we minted and leave everything on the
    // old one — a working sheet with an old token beats a dead sheet with a new one.
    await supabase.from("direct_order_report_share_links").delete().eq("token_hash", hashShareToken(newToken));
    return {
      rotated: false,
      reason:
        `the sheet never read with the new token within ${Math.round(CONFIRM_WINDOW_MS / 1000)}s, ` +
        `so it was deleted and nothing was revoked — the old token is still live and the sheet keeps working`,
    };
  }

  // 4. Confirmed by observation — only now can the old one go.
  await supabase
    .from("direct_order_report_share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: "system:rotation" })
    .eq("id", String(old.id));

  await writeRequiredAuditLog({
    actorLoginId: "system:rotation",
    entityType: "direct_order_request",
    entityId: `share-link:${preview(newToken)}`,
    oldValues: { token: `${String(old.token_preview ?? "")}…`, revoked: true },
    newValues: {
      token: preview(newToken),
      scope: String(old.scope ?? ""),
      allowFiles: Boolean(old.allow_files),
      confirmedBySheet: true,
    },
    summary:
      `Live sheet feed token rotated. The sheet confirmed the new token before the old one was ` +
      `revoked, so the bootstrap token committed in docs/direct-orders-live-sheet.gs no longer opens anything.`,
  });

  return { rotated: true, newTokenPreview: preview(newToken), revokedTokenPreview: `${String(old.token_preview ?? "")}…` };
}
