import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";
import { stripComments } from "./support/comment-strip.ts";
import { checkPasskeyAddPassword, passkeyAddAsksPassword } from "../src/lib/auth/second-step-management.ts";
import { type SecondStepDb, resetSecondStep } from "../src/lib/auth/second-step-store.ts";

/**
 * ADDING A PASSKEY ASKS A SUPER ADMIN FOR THE PASSWORD (the second sign-in step's risk review, 13 Nov 2026:
 * "Adding a passkey asks only for a live session").
 *
 * A passkey signs in as both steps. Without the password, somebody holding a stolen Super Admin session
 * cookie could add their own passkey, and it would outlive a reset of the second step and a password
 * change. What is pinned:
 *
 *   1. Who is asked: the roles the second step is asked of, read the way sign-in reads the role; every
 *      other role adds a passkey with a live session, as before.
 *   2. The answers: no password → password_required, a wrong one → wrong_password, the right one → ok.
 *   3. The options route asks it after the session and before any challenge exists, from the account's
 *      own role, and writes an audit row for a wrong password.
 *   4. The verify route needs none: only the options route makes a registration challenge, and a
 *      challenge is single-use and redeemed only by the login it was made for.
 *   5. The card sends the password and asks for it when the route says so.
 *   6. A reset of the second step never removes a passkey (the lost-phone path is "sign in with a
 *      passkey, then reset"), and the card says where to check them.
 */

const OPTIONS_ROUTE = "app/api/auth/biometric/register/options/route.ts";
const VERIFY_ROUTE = "app/api/auth/biometric/register/verify/route.ts";
const CARD = "src/components/auth/biometric-devices-card.tsx";
const SECOND_STEP_CARD = "src/components/auth/second-step-card.tsx";
const PROFILE_PAGE = "app/(admin)/admin/profile/page.tsx";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

export async function runPasskeyAddAsksPasswordTests() {
  // ── 1. Who is asked ─────────────────────────────────────────────────────────────────────────────
  assert.equal(passkeyAddAsksPassword("Super Admin"), true);
  assert.equal(passkeyAddAsksPassword("super admin"), true, "a role stored in other casing is read the way sign-in reads it");
  for (const role of ["Employee", "HR Manager", "CEO", "Medical Rep", null, undefined, ""]) {
    assert.equal(passkeyAddAsksPassword(role), false, `${String(role)}: adds a passkey as before`);
  }

  // ── 2. The answers ─────────────────────────────────────────────────────────────────────────────
  const asked: Array<[string, string]> = [];
  const matches = async (loginId: string, password: string) => {
    asked.push([loginId, password]);
    return password === "the-right-one";
  };
  assert.deepEqual(
    await checkPasskeyAddPassword({ loginId: "owner", password: undefined, role: "Super Admin" }, matches),
    { ok: false, reason: "password_required" },
  );
  assert.deepEqual(
    await checkPasskeyAddPassword({ loginId: "owner", password: "", role: "Super Admin" }, matches),
    { ok: false, reason: "password_required" },
  );
  assert.deepEqual(
    await checkPasskeyAddPassword({ loginId: "owner", password: { nested: "the-right-one" }, role: "Super Admin" }, matches),
    { ok: false, reason: "password_required" },
    "only a string is a password",
  );
  assert.equal(asked.length, 0, "a missing password is never checked against the store");
  assert.deepEqual(
    await checkPasskeyAddPassword({ loginId: "owner", password: "a-guess", role: "Super Admin" }, matches),
    { ok: false, reason: "wrong_password" },
  );
  assert.deepEqual(
    await checkPasskeyAddPassword({ loginId: "owner", password: "the-right-one", role: "Super Admin" }, matches),
    { ok: true },
  );
  assert.deepEqual(asked.at(-1), ["owner", "the-right-one"], "the password is checked against the caller's own account");
  const before = asked.length;
  assert.deepEqual(
    await checkPasskeyAddPassword({ loginId: "rep", password: undefined, role: "Medical Rep" }, matches),
    { ok: true },
  );
  assert.equal(asked.length, before, "another role is never asked");

  // ── 3. The options route ──────────────────────────────────────────────────────────────────────
  const options = stripComments(readFileSync(OPTIONS_ROUTE, "utf8"));
  const sessionChecked = options.indexOf("if (!sessionState || !sessionState.access.loginId)");
  const rateLimited = options.indexOf("await assertApiRateLimit(");
  const passwordChecked = options.indexOf("await checkPasskeyAddPassword({");
  const challengeMade = options.indexOf("await buildRegistrationOptions(");
  assert.ok(sessionChecked !== -1 && rateLimited > sessionChecked, "the session, then the rate limit");
  assert.ok(passwordChecked > rateLimited, "the password is asked after the rate limit, so guesses are capped");
  assert.ok(challengeMade > passwordChecked, "🔴 the password is asked before any challenge exists");
  assert.ok(options.indexOf("if (!passwordCheck.ok)") > passwordChecked && options.indexOf("if (!passwordCheck.ok)") < challengeMade);
  assert.ok(options.includes("role: sessionState.access.role,"), "the role is the account's own, from its session");
  assert.ok(!/role:\s*body/.test(options), "never a role the caller sends");
  const refusal = options.slice(options.indexOf("if (!passwordCheck.ok)"), challengeMade);
  assert.ok(refusal.includes('summary: "Biometric enrollment refused: wrong password"'), "a wrong password leaves an audit row");
  assert.ok(refusal.includes("{ status: 403 }") && refusal.includes('error: "password_required"') && refusal.includes('error: "wrong_password"'));
  assert.ok(options.includes("resolveSessionState(sessionToken, { allowRecentCopy: false })"), "the session is read live");

  // ── 4. The verify route needs no password ──────────────────────────────────────────────────────
  const webauthn = stripComments(readFileSync("src/lib/auth/webauthn.ts", "utf8"));
  const makers = [...sourceFiles("app"), ...sourceFiles("src")].filter(
    (file) => file.replace(/\\/g, "/") !== "src/lib/auth/webauthn.ts" && stripComments(readFileSync(file, "utf8")).includes("buildRegistrationOptions("),
  );
  assert.deepEqual(makers.map((file) => file.replace(/\\/g, "/")), [OPTIONS_ROUTE], "🔴 only the options route makes a registration challenge");
  const consume = webauthn.slice(webauthn.indexOf("async function consumeChallenge"), webauthn.indexOf("// Credential reads"));
  assert.ok(consume.includes(".delete()") && consume.includes('.eq("purpose", input.purpose)'), "a challenge is single-use and kept to its purpose");
  const complete = webauthn.slice(webauthn.indexOf("export async function completeRegistration"));
  assert.ok(complete.includes("purpose: registrationPurpose,"), "verify redeems only a registration challenge");
  assert.ok(complete.includes('(consumed.loginId ?? "").toLowerCase() !== input.loginId.toLowerCase()'), "and only the login it was made for");
  const verify = stripComments(readFileSync(VERIFY_ROUTE, "utf8"));
  assert.ok(!verify.includes("buildRegistrationOptions(") && verify.includes("completeRegistration("));

  // ── 5. The card ───────────────────────────────────────────────────────────────────────────────
  const card = stripComments(readFileSync(CARD, "utf8"));
  const optionsCall = card.slice(card.indexOf('fetch("/api/auth/biometric/register/options"'), card.indexOf('method: "POST"', card.indexOf('fetch("/api/auth/biometric/register/options"')));
  assert.ok(optionsCall.includes("body: JSON.stringify(currentPassword ? { password: currentPassword } : {})"), "the card sends the password with the request for a challenge");
  assert.ok(card.includes('if (payload?.error === "password_required")') && card.includes("setAskPassword(true);"), "and asks for it when the route says so");
  assert.ok(card.includes("onClick={() => handleEnroll()}"), "the button never passes its click event as a password");
  const panel = card.slice(card.indexOf("{askPassword && ("), card.indexOf("</form>", card.indexOf("{askPassword && (")));
  assert.ok(panel.includes('autoComplete="current-password"') && panel.includes('type="password"'));
  assert.ok(panel.includes("className={phxFieldClassName}") && panel.includes("<FormField"), "the same fields as the second step's password panel");
  assert.ok(panel.includes("className={phxButtonPrimaryClassName}") && panel.includes("className={phxButtonGhostClassName}"));
  assert.ok(!/\brounded\b/.test(panel), "square edges");

  // ── 6. A reset never removes a passkey ─────────────────────────────────────────────────────────
  const passkeyRow = { id: "pk-1", login_id: "owner", revoked_at: null };
  const client = fakeSupabaseClient({
    app_auth_second_step: [{ login_id: "owner", secret_sealed: "sealed" }],
    app_auth_second_step_recovery_codes: [{ code_hash: "h", login_id: "owner" }],
    app_auth_trusted_devices: [{ login_id: "owner", token_hash: "t" }],
    app_auth_webauthn_credentials: [passkeyRow],
  });
  assert.equal(await resetSecondStep("owner", client as unknown as SecondStepDb), true);
  const left = await client.from("app_auth_webauthn_credentials").select("id, login_id, revoked_at");
  assert.deepEqual(left.data, [passkeyRow], "🔴 the lost-phone path is a passkey sign-in, then a reset: the reset leaves the passkey");
  const store = stripComments(readFileSync("src/lib/auth/second-step-store.ts", "utf8"));
  const manage = stripComments(readFileSync("app/api/auth/second-step/route.ts", "utf8"));
  for (const [name, code] of [["second-step-store.ts", store], ["second-step route", manage]] as const) {
    assert.ok(!code.includes("app_auth_webauthn_credentials") && !/revoke\w*Credential/.test(code), `${name}: touches no passkey`);
  }

  const secondStepCard = stripComments(readFileSync(SECOND_STEP_CARD, "utf8"));
  assert.ok(secondStepCard.includes("Your passkeys stay: check the devices under") && secondStepCard.includes("Biometric sign-in and remove any you do not recognise."), "moving to a new phone says where to check the passkeys");
  assert.ok(secondStepCard.includes("Their passkeys stay, and only they can see and remove them"), "resetting another account says its passkeys stay");
  const page = stripComments(readFileSync(PROFILE_PAGE, "utf8"));
  const biometricAt = page.indexOf("<BiometricDevicesCard />");
  const secondStepAt = page.indexOf("<SecondStepCard />");
  assert.equal(
    biometricAt === -1 || secondStepAt < biometricAt
      ? null
      : page.slice(biometricAt, secondStepAt).replace(/\{\s*\}/g, "").replace(/\s+/g, " "),
    "<BiometricDevicesCard /> {secondStepRequiredForRole(access.role) && !access.seatView ? ",
    "the passkey list sits right beside the second step's card",
  );
}
