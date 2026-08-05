import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
//   2. push it to the sheet       — sheet stores it and confirms with "rotated"
//   3. ONLY THEN revoke the old   — and only if step 2 actually confirmed
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

export type SheetTokenRotationResult =
  | { rotated: false; reason: string }
  | { rotated: true; newTokenPreview: string; revokedTokenPreview: string };

/** Never log or return a whole token — the first 8 characters are enough to correlate. */
function preview(token: string): string {
  return `${token.slice(0, 8)}…`;
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
  //    what the link can see — it is the same link with a new name.
  const newToken = await mintToken();
  const { error: insertError } = await supabase.from("direct_order_report_share_links").insert({
    token: newToken,
    surface: String(old.surface ?? "feed"),
    label: old.label ? `${String(old.label)} (rotated)` : "Rotated feed link",
    created_by_hr_id: String(old.created_by_hr_id ?? ""),
    scope: String(old.scope ?? "own"),
    scope_hr_id: String(old.scope_hr_id ?? ""),
    filters: old.filters ?? null,
    passcode_hash: old.passcode_hash ?? null,
    expires_at: String(old.expires_at),
  });
  if (insertError) throw insertError;

  // 2. Hand it to the sheet, authorised by the token still in force.
  let confirmed = false;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: currentSecret, reason: "token_rotation", rotateToken: newToken }),
      signal: AbortSignal.timeout(ROTATION_TIMEOUT_MS),
      redirect: "follow",
    });
    confirmed = response.ok && (await response.text()).trim() === "rotated";
  } catch (error) {
    logWarning("Direct Orders sheet token rotation could not reach the sheet", {
      labels: { event: "direct_order_sheet_rotation_unreachable" },
      error,
    });
  }

  if (!confirmed) {
    // The sheet never took the new token. Clean up the one we minted and leave everything on the
    // old one — a working sheet with an old token beats a dead sheet with a new one.
    await supabase.from("direct_order_report_share_links").delete().eq("token", newToken);
    return { rotated: false, reason: "the sheet did not confirm the new token; nothing was revoked" };
  }

  // 3. Confirmed — now the old one can go.
  await supabase
    .from("direct_order_report_share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by_hr_id: "system:rotation" })
    .eq("token", String(old.token));

  await writeRequiredAuditLog({
    actorLoginId: "system:rotation",
    entityType: "direct_order_request",
    entityId: `share-link:${preview(newToken)}`,
    oldValues: { token: preview(String(old.token)), revoked: true },
    newValues: { token: preview(newToken), scope: String(old.scope ?? ""), confirmedBySheet: true },
    summary:
      `Live sheet feed token rotated. The sheet confirmed the new token before the old one was ` +
      `revoked, so the bootstrap token committed in docs/direct-orders-live-sheet.gs no longer opens anything.`,
  });

  return { rotated: true, newTokenPreview: preview(newToken), revokedTokenPreview: preview(String(old.token)) };
}
