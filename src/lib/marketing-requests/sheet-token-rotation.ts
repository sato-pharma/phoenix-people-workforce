import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { rotatedLabel } from "@/lib/share-links/rotated-label";
import { hashShareToken, shareTokenPreview } from "@/lib/share-links/token-hash";

// ─────────────────────────────────────────────────────────────────────────────
// Rotate the marketing live sheet's feed token, end to end, with nobody opening an editor.
//
// This is a port of src/lib/direct-orders/sheet-token-rotation.ts. Marketing shipped its share
// link WITHOUT rotation, and on 2026-08-05 that cost a manual paste: check:schema-shape found
// marketing_request_report_share_links reachable by `anon` with RLS disabled, so its `token`
// column — the secret that grants report access AND opens the evidence photographs — had been
// publicly readable. Closing the grant did not un-expose the token, so it had to be rotated; with
// no rotation path the owner had to edit the Apps Script by hand while the sheet sat dead.
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
// ONE DIFFERENCE FROM DIRECT ORDERS, AND IT SIMPLIFIES THINGS.
// The direct-orders script falls back to using its feed token as the webhook secret, so rotating
// the token would move the secret with it — which is why that script has to PIN the secret before
// storing a new token. The marketing script has never had that fallback: its doPost fails closed
// unless an explicit WEBHOOK_SECRET script property is set. "May trigger a refresh" and "may read
// the data" are already separate here, so nothing needs pinning and only the feed token rotates.
// ─────────────────────────────────────────────────────────────────────────────

const ROTATION_TIMEOUT_MS = 15000;

/**
 * How long to wait for the sheet to PROVE it took the new token, and how often to look.
 *
 * Proof is an actual read: the script calls refreshMarketingRequests() straight after storing the
 * token, which fetches the feed and bumps that link's access_count. 40s is generous and still
 * leaves room inside the route's 60s maxDuration.
 */
const CONFIRM_WINDOW_MS = 40000;
const CONFIRM_POLL_MS = 2500;

const TABLE = "marketing_request_report_share_links";

/** Has the sheet actually fetched with this token yet? */
async function tokenHasBeenUsed(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  token: string,
): Promise<boolean> {
  const { data } = await supabase
    .from(TABLE)
    .select("access_count")
    .eq("token_hash", hashShareToken(token))
    .maybeSingle();
  return Number((data as { access_count?: number } | null)?.access_count ?? 0) > 0;
}

export type MarketingSheetTokenRotationResult =
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
 * Rotate the feed token behind the owner's live marketing sheet.
 *
 * Deliberately takes the CURRENT webhook credentials from the environment rather than a caller
 * argument: the thing being rotated is whatever Phoenix is actually configured with, and letting a
 * caller name a different one would make it possible to revoke a link this deployment is not using.
 */
export async function rotateMarketingSheetToken(): Promise<MarketingSheetTokenRotationResult> {
  const webhookUrl = process.env.MARKETING_SHEET_REFRESH_WEBHOOK_URL?.trim();
  const currentSecret = process.env.MARKETING_SHEET_REFRESH_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !currentSecret) {
    return { rotated: false, reason: "marketing sheet webhook is not configured; nothing to rotate" };
  }

  const supabase = getSupabaseAdmin();
  // Find the live FEED link — the newest unrevoked one, never by matching the webhook secret.
  // Those are different values here by design, and selecting the newest unrevoked row is what
  // makes rotation repeatable rather than a one-shot.
  const { data: rows } = await supabase
    .from(TABLE)
    .select("*")
    .eq("surface", "feed")
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(2);
  const live = (rows ?? []) as Array<Record<string, unknown>>;
  if (live.length === 0) {
    return { rotated: false, reason: "no live marketing feed share link exists to rotate" };
  }
  if (live.length > 1) {
    // More than one live feed link means an earlier rotation left a stray, or someone created a
    // second by hand. Rotating blind could revoke the one actually in use, so stop and say so.
    return {
      rotated: false,
      reason: `${live.length} live marketing feed links exist; resolve the ambiguity before rotating`,
    };
  }
  const old = live[0];

  // 1. Mint the replacement, carrying the SAME frozen scope. A rotation must not widen or narrow
  //    what the link can see — it is the same link with a new name. allow_files rides along for
  //    the same reason: the evidence photographs must stay exactly as reachable as before, no more.
  const newToken = await mintToken();
  const { error: insertError } = await supabase.from(TABLE).insert({
    token_hash: hashShareToken(newToken),
    token_preview: shareTokenPreview(newToken),
    surface: String(old.surface ?? "feed"),
    label: rotatedLabel(old.label, "Rotated marketing feed link"),
    created_by_hr_id: String(old.created_by_hr_id ?? ""),
    scope: String(old.scope ?? "own"),
    scope_hr_id: String(old.scope_hr_id ?? ""),
    filters: old.filters ?? null,
    passcode_hash: old.passcode_hash ?? null,
    expires_at: String(old.expires_at),
    allow_files: old.allow_files ?? false,
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: currentSecret, reason: "token_rotation", rotateToken: newToken }),
      signal: AbortSignal.timeout(ROTATION_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    // Even a thrown fetch is not proof of failure — the request may well have been delivered and
    // processed before the connection went wrong. The observation below decides, not this.
    logWarning("Marketing sheet token rotation: the push errored (the observation still decides)", {
      labels: { event: "marketing_sheet_rotation_push_error" },
      error,
    });
  }

  // 3. Confirm by OBSERVATION, on our side of the wire.
  //
  // The sheet proves it stored the token by USING it: the script calls refreshMarketingRequests()
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
    // The sheet never took the new token. Clean up the one we minted and leave everything on the
    // old one — a working sheet with an old token beats a dead sheet with a new one.
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
    entityType: "marketing_request",
    entityId: `share-link:${preview(newToken)}`,
    oldValues: { token: `${String(old.token_preview ?? "")}…`, revoked: true },
    newValues: {
      token: preview(newToken),
      scope: String(old.scope ?? ""),
      allowFiles: Boolean(old.allow_files),
      confirmedBySheet: true,
    },
    summary:
      `Marketing live sheet feed token rotated. The sheet confirmed the new token before the old ` +
      `one was revoked, so a previously exposed token no longer reads any request or opens any ` +
      `evidence photograph.`,
  });

  return { rotated: true, newTokenPreview: preview(newToken), revokedTokenPreview: `${String(old.token_preview ?? "")}…` };
}
