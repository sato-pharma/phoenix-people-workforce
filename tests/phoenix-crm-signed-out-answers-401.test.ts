import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SignedOutRefusal, isSignedOutRefusal } from "@/lib/auth/signed-out-refusal.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A PHOENIX CRM SAVE FROM SOMEONE WHOSE SIGN-IN ENDED ANSWERS 401 "signed out", NEVER 403.
 *
 * 24 Oct 2026: a district manager's session reached its absolute expiry at 02:35:58 Cairo while he
 * was filling his plan. His next half-day save, 24 seconds later, was refused 403 — which the screen
 * reads as "you are not allowed" — and he signed in again 6 seconds after that. Nothing about his
 * permissions was wrong: `resolveAccessContext` hands back the guest context for an ended session,
 * and `assertPermission` refused the guest with the same "Forbidden:" sentence as a real refusal.
 *
 * Three things must hold together:
 *   1. assertPermission marks the GUEST refusal (SignedOutRefusal) and keeps its "Forbidden:" prefix,
 *      so the ~550 routes keyed on isForbiddenError answer exactly as before.
 *   2. phoenixCrmFailure answers the marked refusal 401 with `signed_out`, BEFORE the 403 mapping —
 *      the client (src/components/phoenix-crm/api.ts) turns every 401 into "You are signed out".
 *   3. A signed-in refusal stays 403: the mark is asked only of the guest context.
 */
export function runPhoenixCrmSignedOutAnswers401Tests() {
  const refusal = new SignedOutRefusal("Forbidden: Employee cannot create phoenix_crm.");
  assert.ok(refusal instanceof Error, "a SignedOutRefusal is a plain Error to every route");
  assert.ok(isSignedOutRefusal(refusal), "isSignedOutRefusal recognises the mark");
  assert.ok(refusal.message.startsWith("Forbidden:"), "the message keeps the prefix isForbiddenError keys on");
  assert.equal(isSignedOutRefusal(new Error("Forbidden: Medical Rep cannot approve phoenix_crm.")), false, "an ordinary refusal carries no mark");

  const permissions = stripComments(readFileSync("src/lib/auth/permissions.ts", "utf8"));
  const assertBody = permissions.slice(permissions.indexOf("export async function assertPermission("));
  const guestThrow = assertBody.search(/if \(context\.source === "guest"\) throw new SignedOutRefusal\(`Forbidden: /);
  assert.ok(guestThrow > 0, "assertPermission throws SignedOutRefusal, with the Forbidden: prefix, for the guest context only");
  assert.ok(guestThrow < assertBody.indexOf("canAccess(") + 400, "the guest mark sits right after the canAccess check, before the module lock");
  assert.ok(guestThrow > assertBody.indexOf("if (await canAccess(context, resource, action)) return;"), "the mark is asked only of a request already being refused");

  const http = stripComments(readFileSync("src/lib/phoenix-crm/server/http.ts", "utf8"));
  const failure = http.slice(http.indexOf("export function phoenixCrmFailure("));
  const signedOut = failure.indexOf("if (isSignedOutRefusal(error))");
  assert.ok(signedOut > 0, "phoenixCrmFailure asks for the signed-out mark");
  assert.match(failure.slice(signedOut, signedOut + 300), /error: "signed_out"[\s\S]*status: 401/, "the signed-out refusal answers 401 signed_out");
  assert.ok(signedOut < failure.indexOf("isForbiddenError(error) ? 403"), "the 401 is decided before the 403 mapping would claim it");

  const client = stripComments(readFileSync("src/components/phoenix-crm/api.ts", "utf8"));
  assert.match(client, /status === 401/, "the CRM client still turns a 401 into its signed-out sentence");
}
