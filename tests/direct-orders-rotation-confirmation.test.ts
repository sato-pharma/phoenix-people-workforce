import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Rotation must be confirmed by EVIDENCE, not by what the other side says.
//
// The first version gated on the webhook's reply:
//
//     confirmed = response.ok && (await response.text()).trim() === "rotated";
//
// Apps Script answers a POST with a 302, and per the fetch spec a 302 on POST is followed as a GET.
// So the body that comes back is whatever that redirect serves — frequently an HTML page — even
// though doPost has already run and stored the token. On 2026-08-05 that check refused the rotation
// TWICE while the sheet had taken the new token perfectly. It reported failure over success, which
// is the more dangerous direction here: a false failure leaves a permanent credential live.
//
// The fix is to look at something we record ourselves. The script calls refreshDirectOrders()
// straight after saving the token, which fetches the feed and increments that link's access_count
// in our own database. A read we logged cannot be faked by a redirect, an error page, or a dropped
// connection.
//
// The failure direction still matters and is asserted below: no evidence means the NEW link is
// deleted and the OLD one survives. A rotation that cannot be proven must never revoke anything.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrderRotationConfirmationTests() {
  const source = readFileSync(
    new URL("../src/lib/direct-orders/sheet-token-rotation.ts", import.meta.url),
    "utf8",
  );

  // ── THE HEADLINE: the reply body must not be the gate ────────────────────────────────────
  assert.doesNotMatch(
    source,
    /confirmed\s*=\s*response\.ok/,
    "ROTATION IS TRUSTING THE REPLY AGAIN: Apps Script's 302-to-GET means the body is unreliable even when doPost succeeded. Confirm by observing that the sheet USED the new token.",
  );
  assert.doesNotMatch(
    source,
    /=== "rotated"/,
    'the literal "rotated" reply must not decide the outcome — it is a courtesy, not evidence',
  );

  // ── Confirmation is an observed read of the new token ────────────────────────────────────
  assert.match(
    source,
    /async function tokenHasBeenUsed\(/,
    "confirmation must be a function that checks whether the token has actually been used",
  );
  assert.match(
    source,
    /\.select\("access_count"\)[\s\S]{0,200}?access_count\s*\?\?\s*0\)\s*>\s*0/,
    "the proof must be access_count > 0 on the NEW link — a read we recorded ourselves",
  );
  assert.match(
    source,
    /while \(Date\.now\(\) < deadline\) \{[\s\S]{0,220}?tokenHasBeenUsed\(supabase, newToken\)/,
    "the check must poll until a deadline — the sheet needs a moment to store the token and refresh",
  );

  // ── The failure direction is the safety property ─────────────────────────────────────────
  // Unproven must mean: delete the new link, revoke nothing. The opposite would strand the owner
  // with a report that cannot read anything.
  const unconfirmed = source.slice(source.indexOf("if (!confirmed)"), source.indexOf("// 4."));
  assert.match(
    unconfirmed,
    /\.delete\(\)\.eq\("token_hash", hashShareToken\(newToken\)\)/,
    "an unconfirmed rotation must delete the new link it minted rather than leave a stray behind",
  );
  assert.doesNotMatch(
    unconfirmed,
    /revoked_at/,
    "an unconfirmed rotation must NEVER revoke the old token — the sheet is still using it",
  );

  // A thrown fetch must not be treated as failure either: the request may have been delivered and
  // processed before the connection broke. Only the observation decides.
  assert.match(
    source,
    /catch \(error\) \{[\s\S]{0,320}?direct_order_sheet_rotation_push_error/,
    "a push error must be logged and then deferred to the observation, not treated as a verdict",
  );

  // Revocation must come strictly after the observation, never before.
  assert.ok(
    source.indexOf("let confirmed = false") < source.indexOf("revoked_at: new Date().toISOString()"),
    "REVOKE BEFORE CONFIRM: the old token must only be revoked after the new one is proven in use",
  );
}
