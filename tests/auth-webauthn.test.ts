import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decodeClientDataChallenge,
  describeDeviceLabel,
  isSignCountReplay,
  resolveRelyingParty,
} from "../src/lib/auth/webauthn.ts";
import { stripComments } from "./support/comment-strip.ts";

// Strips comments so an "X must be absent" assertion cannot be tripped by the very comment that
// explains WHY X is absent. Hit exactly that on the allowCredentials check below on first run.
function withoutComments(source: string) {
  return stripComments(source);
}

function bodyOf(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find "${declaration}" — the test's anchor has moved`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of "${declaration}"`);
  return source.slice(start, end);
}

export function runAuthWebauthnTests() {
  // -------------------------------------------------------------------------
  // Sign-counter replay detection — the cloned-authenticator check.
  // -------------------------------------------------------------------------
  assert.equal(
    isSignCountReplay(5, 6),
    false,
    "a counter that advances is a normal, fresh assertion",
  );
  assert.equal(
    isSignCountReplay(5, 5),
    true,
    "a counter that did not move means the same assertion is being presented twice",
  );
  assert.equal(
    isSignCountReplay(5, 4),
    true,
    "a counter that went BACKWARDS means a cloned authenticator, never a legitimate device",
  );
  assert.equal(
    isSignCountReplay(0, 0),
    false,
    "Apple and most platform authenticators always report 0 — treating that as replay would reject every iPhone",
  );
  assert.equal(
    isSignCountReplay(0, 1),
    false,
    "a counter leaving 0 for the first time is normal, not a replay",
  );

  // -------------------------------------------------------------------------
  // Relying-party resolution. A passkey is permanently bound to the RP ID it was
  // created under, so a wrong or attacker-supplied value is unrecoverable.
  // -------------------------------------------------------------------------
  const trusted = resolveRelyingParty(
    new Request("https://phoenix-hr.satopharma.com/api/auth/biometric/login/options"),
  );
  assert.equal(
    trusted?.rpId,
    "phoenix-hr.satopharma.com",
    "the production custom domain must resolve to itself as the RP ID",
  );
  assert.equal(
    trusted?.origin,
    "https://phoenix-hr.satopharma.com",
    "expectedOrigin must be the full production origin, not just the hostname",
  );

  assert.equal(
    resolveRelyingParty(new Request("https://evil.example.com/api/auth/biometric/login/options")),
    null,
    "an origin outside the trusted set must resolve to no relying party, so the route refuses rather than minting a passkey for an attacker's domain",
  );

  assert.equal(
    resolveRelyingParty(new Request("http://phoenix-hr.satopharma.com/api/auth/biometric/login/options")),
    null,
    "plain http on a public host must be refused — WebAuthn requires a secure context",
  );

  const localhost = resolveRelyingParty(new Request("http://localhost:3000/api/auth/biometric/login/options"));
  assert.equal(
    localhost?.rpId,
    "localhost",
    "localhost is the WebAuthn spec's dev exemption and must keep working, or the feature cannot be developed",
  );

  // -------------------------------------------------------------------------
  // Challenge extraction from clientDataJSON.
  // -------------------------------------------------------------------------
  const encoded = Buffer.from(JSON.stringify({ challenge: "abc123", type: "webauthn.get" })).toString(
    "base64url",
  );
  assert.equal(
    decodeClientDataChallenge(encoded),
    "abc123",
    "the challenge must be readable from clientDataJSON so it can be looked up in the single-use table",
  );
  assert.equal(
    decodeClientDataChallenge("not-valid-base64url-json"),
    null,
    "malformed clientDataJSON must return null, never throw into a 500",
  );
  assert.equal(decodeClientDataChallenge(null), null, "a missing clientDataJSON must return null");

  // -------------------------------------------------------------------------
  // Device labels. Owner rule: show human-readable names, never raw codes.
  // -------------------------------------------------------------------------
  assert.equal(
    describeDeviceLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    "iPhone (Safari)",
    "an iPhone must be named as an iPhone so a person recognises which device to remove",
  );
  assert.equal(
    describeDeviceLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    ),
    "Windows PC (Edge)",
    "Edge's user agent contains both Chrome and Safari — the branch order must report Edge, not Chrome",
  );
  assert.equal(
    describeDeviceLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    "Windows PC (Chrome)",
    "Chrome's user agent contains Safari — the branch order must report Chrome, not Safari",
  );
  assert.equal(describeDeviceLabel(""), "Unknown device", "an empty user agent must still label something");

  // -------------------------------------------------------------------------
  // Source-shape assertions.
  //
  // These are source-shape tests on purpose. Every gate below only fails against a live Supabase
  // plus a real authenticator, which no unit test can stand up ([[test-seams-for-supabase-backed-code]]).
  // Each assertion maps to one specific way biometric login could silently become a way AROUND a
  // control the password path enforces.
  // -------------------------------------------------------------------------
  const loginVerifySource = readFileSync("app/api/auth/biometric/login/verify/route.ts", "utf8");

  assert.match(
    loginVerifySource,
    /resolveAuthUserForPasswordlessLogin/,
    "biometric login must resolve the account through resolveAuthUserForPasswordlessLogin, which is what enforces is_active AND terminal employment status — without it a resigned employee's enrolled phone keeps working",
  );
  assert.match(
    loginVerifySource,
    /isLoginRateLimited/,
    "account lockout must apply to biometric sign-in, or a locked account is reachable through a side door",
  );
  assert.match(
    loginVerifySource,
    /readIpBlock\(/,
    "the admin IP blocklist must apply to biometric sign-in as well as password sign-in",
  );
  assert.match(
    loginVerifySource,
    /rejectUntrustedForwardedOrigin/,
    "biometric login must reject untrusted origins exactly as the password route does",
  );
  assert.match(
    loginVerifySource,
    /user\.forcePasswordReset/,
    "an account flagged for password setup must not be able to skip that by signing in biometrically",
  );
  assert.match(
    loginVerifySource,
    /shouldBlockLoginWhenSupabaseBridgeUnavailable/,
    "if PHOENIX_STRICT_SUPABASE_BRIDGE is ever switched on, a bridge-required role must be refused here rather than handed a quietly weaker session than the password path gives",
  );
  assert.match(
    loginVerifySource,
    /supabaseSessionAvailable:\s*false/,
    "the app_sessions row must record honestly that no Supabase bridge session exists on this path",
  );

  const credentialsSource = readFileSync("src/lib/auth/credentials.ts", "utf8");
  const passwordlessBody = bodyOf(
    credentialsSource,
    "export async function resolveAuthUserForPasswordlessLogin",
  );
  assert.match(
    passwordlessBody,
    /isLinkedEmployeeAccessRevoked/,
    "the passwordless lookup must run the SAME dated-departure gate authenticateLoginId runs; dropping it is the single highest-impact regression this feature can have",
  );
  assert.match(
    passwordlessBody,
    /findActiveAuthUserRow/,
    "the passwordless lookup must go through findActiveAuthUserRow, which is what filters is_active = true",
  );

  const webauthnSource = readFileSync("src/lib/auth/webauthn.ts", "utf8");

  assert.equal(
    (webauthnSource.match(/requireUserVerification:\s*true/g) ?? []).length,
    2,
    "BOTH registration and authentication must require user verification — this is precisely what makes it a biometric login rather than a tap-to-continue",
  );
  assert.match(
    webauthnSource,
    /userVerification:\s*"required"/,
    "the authenticator must be asked to verify the person, not merely detect one",
  );
  assert.match(
    webauthnSource,
    /residentKey:\s*"required"/,
    "a discoverable credential is what allows one-tap sign-in with no login ID typed first",
  );
  assert.match(
    webauthnSource,
    /authenticatorAttachment:\s*"platform"/,
    "only the built-in sensor counts as biometric here",
  );

  // The login page. tests/login-page-hardening.test.ts already pins the password form itself, so
  // these two cover only what adding biometrics could break.
  const loginPageSource = readFileSync("src/components/auth/premium-login-page.tsx", "utf8");

  assert.match(
    loginPageSource,
    /\{biometricAvailable && \(/,
    "the biometric button must be gated on a detected platform authenticator — rendering it on a device with no sensor offers a control that can only fail",
  );
  assert.match(
    loginPageSource,
    /isUserVerifyingPlatformAuthenticatorAvailable\?\.\(\)/,
    "availability must be probed optionally, so an older browser without PublicKeyCredential silently gets the password form instead of a crashed login page",
  );
  const biometricBlockStart = loginPageSource.indexOf("{biometricAvailable && (");
  const biometricBlock = loginPageSource.slice(
    biometricBlockStart,
    loginPageSource.indexOf("</>", biometricBlockStart),
  );
  assert.match(
    biometricBlock,
    /onClick=\{onBiometricSignIn\}\s*\n\s*type="button"/,
    "the biometric button must be type=button; it sits inside the password <form>, so a default type=submit would fire a password login with an empty password on every tap",
  );

  const consumeBody = bodyOf(webauthnSource, "async function consumeChallenge");
  assert.match(
    consumeBody,
    /\.delete\(\)/,
    "consuming a challenge must DELETE it — that delete is the only thing making the challenge single-use, and without it a captured assertion can be replayed inside the TTL",
  );

  const authOptionsBody = bodyOf(webauthnSource, "export async function buildAuthenticationOptions");
  assert.doesNotMatch(
    withoutComments(authOptionsBody),
    /allowCredentials/,
    "the public sign-in options endpoint must not return an allowCredentials list, which would let anyone enumerate who has biometrics enrolled",
  );
}
