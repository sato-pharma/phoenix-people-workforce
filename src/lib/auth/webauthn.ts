// Biometric sign-in (WebAuthn / passkeys) — domain service.
//
// Everything about passkeys lives here. API routes call these functions; they must not talk to
// @simplewebauthn or to the credential tables directly, per the domain-first rule in CLAUDE.md.
//
// What a passkey is, in one paragraph: the phone or laptop generates a key pair inside its secure
// enclave, keeps the private half forever, and hands Phoenix the public half. To sign in, Phoenix
// sends a random challenge, the device asks for Face ID / fingerprint / Windows Hello to unlock the
// private key, signs the challenge, and Phoenix verifies the signature against the stored public
// key. No biometric data is transmitted or stored — the fingerprint never leaves the device, and
// there is nothing in app_auth_credentials that could reconstruct one.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { systemIdentity } from "@/config/system-settings";
import { allowedPhoenixOrigins, requestOriginCandidates } from "@/lib/security/origins";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// A challenge is short-lived on purpose: it is the anti-replay window. Two minutes is long enough
// for a person to find the fingerprint reader and short enough that a captured challenge is dead
// before it is useful.
export const webauthnChallengeTtlSeconds = 120;

const registrationPurpose = "registration";
const authenticationPurpose = "authentication";

export type BiometricCredentialRow = {
  backed_up: boolean;
  created_at: string;
  credential_id: string;
  device_label: string;
  hr_id: string | null;
  id: string;
  last_used_at: string | null;
  login_id: string;
  public_key: string;
  revoked_at: string | null;
  sign_count: number;
  transports: string[] | null;
};

export type BiometricCredentialSummary = {
  backedUp: boolean;
  createdAt: string;
  deviceLabel: string;
  id: string;
  lastUsedAt: string | null;
};

export type RelyingParty = {
  origin: string;
  rpId: string;
};

// ---------------------------------------------------------------------------
// Pure helpers. Exported so they can be unit-tested without a Supabase client —
// see the convention in tests/auth-webauthn.test.ts.
// ---------------------------------------------------------------------------

/**
 * A passkey is permanently bound to the RP ID it was created under, so this value can never be
 * guessed or defaulted: get it wrong once and every credential enrolled under the wrong ID is
 * silently unusable forever. It is therefore derived from the request's own origin and accepted
 * ONLY if that origin is already in the trusted set used for CSRF/redirect checks. An attacker who
 * controls the Host header cannot widen it.
 */
export function resolveRelyingParty(request: Pick<Request, "headers" | "url">): RelyingParty | null {
  const candidates = requestOriginCandidates(request);
  const allowed = allowedPhoenixOrigins();
  const isLocalDev = process.env.NODE_ENV !== "production";

  for (const origin of [
    candidates.forwardedOrigin,
    candidates.originHeader,
    candidates.hostOrigin,
    candidates.requestUrlOrigin,
  ]) {
    if (!origin) continue;

    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      continue;
    }

    // WebAuthn only runs on a secure context: HTTPS, or localhost as the spec's dev exemption.
    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
    if (!allowed.has(origin) && !(isLocalDev && isLocalhost)) continue;
    if (!origin.startsWith("https://") && !isLocalhost) continue;

    return { origin, rpId: isLocalhost ? "localhost" : hostname };
  }

  return null;
}

/**
 * The cloned-authenticator check. An authenticator increments a counter on every signature, so a
 * counter that fails to advance means the same signed assertion is being presented twice, or a
 * cloned key is in play.
 *
 * The `stored === 0 && incoming === 0` exemption is not a loophole: Apple's and most platform
 * authenticators deliberately always report 0 (a syncing passkey has no single device to count on),
 * and treating that as an attack would reject every iPhone. Once a counter has moved above zero we
 * hold it to the rule strictly.
 */
export function isSignCountReplay(storedSignCount: number, incomingSignCount: number) {
  if (storedSignCount === 0 && incomingSignCount === 0) return false;
  return incomingSignCount <= storedSignCount;
}

/**
 * A human-readable device name for the "your enrolled devices" list, derived from the user agent.
 * Owner rule: show names, never raw codes — "iPhone (Safari)" not a 40-char credential ID.
 */
export function describeDeviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? "");
  if (!ua.trim()) return "Unknown device";

  const platform = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android phone"
        : /Windows/i.test(ua)
          ? "Windows PC"
          : /Macintosh|Mac OS X/i.test(ua)
            ? "Mac"
            : /Linux/i.test(ua)
              ? "Linux PC"
              : "Device";

  // Order matters: Edge's UA contains "Chrome", and Chrome's contains "Safari".
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /OPR\/|Opera/i.test(ua)
      ? "Opera"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Chrome\//i.test(ua)
          ? "Chrome"
          : /Safari\//i.test(ua)
            ? "Safari"
            : null;

  return browser ? `${platform} (${browser})` : platform;
}

export function toCredentialSummary(row: BiometricCredentialRow): BiometricCredentialSummary {
  return {
    backedUp: Boolean(row.backed_up),
    createdAt: row.created_at,
    deviceLabel: row.device_label,
    id: row.id,
    lastUsedAt: row.last_used_at,
  };
}

// ---------------------------------------------------------------------------
// Challenge store. Single-use: issued once, deleted the moment it is consumed.
// ---------------------------------------------------------------------------

async function storeChallenge(input: {
  challenge: string;
  loginId: string | null;
  purpose: typeof registrationPurpose | typeof authenticationPurpose;
}) {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // Opportunistic sweep of expired rows. Deliberately not a cron job: the Cloud Scheduler crons
  // died with GCP on 2026-08-01 and have no Railway replacement, so anything relying on one would
  // grow without bound. This keeps the table self-limiting at the cost of one cheap delete.
  await supabase
    .from("app_auth_webauthn_challenges")
    .delete()
    .lt("expires_at", nowIso)
    .then(() => undefined, () => undefined);

  const { error } = await supabase.from("app_auth_webauthn_challenges").insert({
    challenge: input.challenge,
    expires_at: new Date(Date.now() + webauthnChallengeTtlSeconds * 1000).toISOString(),
    login_id: input.loginId,
    purpose: input.purpose,
  });

  if (error) throw error;
}

/**
 * Consumes a challenge, returning it only if it was issued for this purpose and has not expired.
 * The delete is what makes it single-use, and it runs whether or not the row was still valid, so a
 * replayed challenge finds nothing on the second attempt.
 */
async function consumeChallenge(input: {
  challenge: string;
  purpose: typeof registrationPurpose | typeof authenticationPurpose;
}): Promise<{ loginId: string | null } | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("app_auth_webauthn_challenges")
    .delete()
    .eq("challenge", input.challenge)
    .eq("purpose", input.purpose)
    .select("login_id,expires_at")
    .maybeSingle();

  if (error) throw error;
  const row = (data as { expires_at: string; login_id: string | null } | null) ?? null;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  return { loginId: row.login_id };
}

// ---------------------------------------------------------------------------
// Credential reads
// ---------------------------------------------------------------------------

export async function listActiveCredentialsForLogin(loginId: string): Promise<BiometricCredentialRow[]> {
  const normalized = String(loginId ?? "").trim();
  if (!normalized) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_credentials")
    .select(
      "id,credential_id,public_key,sign_count,login_id,hr_id,device_label,transports,backed_up,created_at,last_used_at,revoked_at",
    )
    .ilike("login_id", normalized)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data as BiometricCredentialRow[] | null) ?? [];
}

async function findActiveCredentialById(credentialId: string): Promise<BiometricCredentialRow | null> {
  const normalized = String(credentialId ?? "").trim();
  if (!normalized) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_credentials")
    .select(
      "id,credential_id,public_key,sign_count,login_id,hr_id,device_label,transports,backed_up,created_at,last_used_at,revoked_at",
    )
    .eq("credential_id", normalized)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw error;
  return (data as BiometricCredentialRow | null) ?? null;
}

export async function revokeCredential(input: {
  credentialRowId: string;
  loginId: string;
  reason: string;
}): Promise<boolean> {
  // Scoped by login_id as well as row id so one person can never revoke another's device by
  // guessing a UUID.
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_credentials")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: input.reason })
    .eq("id", input.credentialRowId)
    .ilike("login_id", input.loginId)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data !== null;
}

/**
 * Revokes every passkey a person holds. Called when their access ends or their session_version is
 * bumped — a resigned employee's enrolled phone must stop working at the same moment their password
 * does, not whenever the credential happens to be noticed.
 */
export async function revokeAllCredentialsForLogin(loginId: string, reason: string): Promise<number> {
  const normalized = String(loginId ?? "").trim();
  if (!normalized) return 0;

  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_credentials")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .ilike("login_id", normalized)
    .is("revoked_at", null)
    .select("id");

  if (error) throw error;
  return ((data as { id: string }[] | null) ?? []).length;
}

// ---------------------------------------------------------------------------
// Registration (enrolling a device)
// ---------------------------------------------------------------------------

export async function buildRegistrationOptions(input: {
  displayName: string;
  loginId: string;
  relyingParty: RelyingParty;
}) {
  const existing = await listActiveCredentialsForLogin(input.loginId);

  const options = await generateRegistrationOptions({
    attestationType: "none",
    authenticatorSelection: {
      // "platform" = the biometric sensor built into this phone or laptop. This is what makes the
      // feature "biometric login" rather than "plug in a USB key".
      authenticatorAttachment: "platform",
      // A discoverable credential is what allows one-tap sign-in with no login ID typed first —
      // the device tells us who it is.
      residentKey: "required",
      // "required" forces the device to actually verify the person (Face ID, fingerprint, or the
      // device PIN as the platform's own fallback) rather than merely confirming someone is there.
      userVerification: "required",
    },
    // Stops the same device being enrolled twice, which would leave a confusing duplicate in the
    // person's device list.
    excludeCredentials: existing.map((row) => ({
      id: row.credential_id,
      transports: (row.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    rpID: input.relyingParty.rpId,
    rpName: systemIdentity.appName,
    timeout: webauthnChallengeTtlSeconds * 1000,
    userDisplayName: input.displayName,
    userID: new TextEncoder().encode(input.loginId),
    userName: input.loginId,
  });

  await storeChallenge({
    challenge: options.challenge,
    loginId: input.loginId,
    purpose: registrationPurpose,
  });

  return options;
}

export type RegistrationOutcome =
  | { credentialId: string; deviceLabel: string; ok: true }
  | { ok: false; reason: "challenge_expired" | "challenge_mismatch" | "not_verified" };

export async function completeRegistration(input: {
  hrId: string | null;
  loginId: string;
  relyingParty: RelyingParty;
  response: RegistrationResponseJSON;
  userAgent: string | null;
}): Promise<RegistrationOutcome> {
  const expectedChallenge = decodeClientDataChallenge(input.response?.response?.clientDataJSON);
  if (!expectedChallenge) return { ok: false, reason: "challenge_mismatch" };

  const consumed = await consumeChallenge({
    challenge: expectedChallenge,
    purpose: registrationPurpose,
  });
  if (!consumed) return { ok: false, reason: "challenge_expired" };

  // The challenge was issued to a specific signed-in person; it must be redeemed by that same
  // person. Without this, a challenge minted for one account could enrol a device onto another.
  if ((consumed.loginId ?? "").toLowerCase() !== input.loginId.toLowerCase()) {
    return { ok: false, reason: "challenge_mismatch" };
  }

  const verification = await verifyRegistrationResponse({
    expectedChallenge,
    expectedOrigin: input.relyingParty.origin,
    expectedRPID: input.relyingParty.rpId,
    requireUserVerification: true,
    response: input.response,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, reason: "not_verified" };
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;
  const deviceLabel = describeDeviceLabel(input.userAgent);

  const { error } = await getSupabaseAdmin().from("app_auth_credentials").insert({
    backed_up: credentialBackedUp,
    credential_id: credential.id,
    device_label: deviceLabel,
    hr_id: input.hrId,
    login_id: input.loginId,
    public_key: Buffer.from(credential.publicKey).toString("base64url"),
    sign_count: credential.counter,
    transports: credential.transports ?? null,
  });

  if (error) throw error;

  return { credentialId: credential.id, deviceLabel, ok: true };
}

// ---------------------------------------------------------------------------
// Authentication (signing in)
// ---------------------------------------------------------------------------

export async function buildAuthenticationOptions(relyingParty: RelyingParty) {
  const options = await generateAuthenticationOptions({
    // No allowCredentials: the credential is discoverable, so the browser offers the right passkey
    // itself. Sending a list here would leak which accounts have biometrics enrolled to anyone who
    // can hit the endpoint.
    rpID: relyingParty.rpId,
    timeout: webauthnChallengeTtlSeconds * 1000,
    userVerification: "required",
  });

  await storeChallenge({
    challenge: options.challenge,
    loginId: null,
    purpose: authenticationPurpose,
  });

  return options;
}

export type AuthenticationOutcome =
  | { hrId: string | null; loginId: string; ok: true }
  | {
      ok: false;
      reason: "challenge_expired" | "credential_revoked" | "not_verified" | "sign_count_replay";
    };

export async function completeAuthentication(input: {
  relyingParty: RelyingParty;
  response: AuthenticationResponseJSON;
}): Promise<AuthenticationOutcome> {
  const expectedChallenge = decodeClientDataChallenge(input.response?.response?.clientDataJSON);
  if (!expectedChallenge) return { ok: false, reason: "challenge_expired" };

  const consumed = await consumeChallenge({
    challenge: expectedChallenge,
    purpose: authenticationPurpose,
  });
  if (!consumed) return { ok: false, reason: "challenge_expired" };

  const stored = await findActiveCredentialById(String(input.response?.id ?? ""));
  if (!stored) return { ok: false, reason: "credential_revoked" };

  const verification = await verifyAuthenticationResponse({
    credential: {
      counter: Number(stored.sign_count ?? 0),
      id: stored.credential_id,
      publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")),
      transports: (stored.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    },
    expectedChallenge,
    expectedOrigin: input.relyingParty.origin,
    expectedRPID: input.relyingParty.rpId,
    requireUserVerification: true,
    response: input.response,
  });

  if (!verification.verified) return { ok: false, reason: "not_verified" };

  const newCounter = Number(verification.authenticationInfo.newCounter ?? 0);
  if (isSignCountReplay(Number(stored.sign_count ?? 0), newCounter)) {
    // A counter that did not advance means a replayed or cloned credential. Revoke rather than
    // merely refuse — if the key really is cloned, letting it stay enrolled invites a retry.
    await revokeCredential({
      credentialRowId: stored.id,
      loginId: stored.login_id,
      reason: "sign_count_replay",
    }).catch(() => undefined);
    return { ok: false, reason: "sign_count_replay" };
  }

  const { error } = await getSupabaseAdmin()
    .from("app_auth_credentials")
    .update({ last_used_at: new Date().toISOString(), sign_count: newCounter })
    .eq("id", stored.id);

  if (error) throw error;

  return { hrId: stored.hr_id, loginId: stored.login_id, ok: true };
}

/**
 * Reads the challenge back out of clientDataJSON so it can be looked up in the challenge table.
 * The value is NOT trusted on the strength of this read — it is only a lookup key. The real check
 * is @simplewebauthn verifying that the signature covers this exact clientDataJSON.
 */
export function decodeClientDataChallenge(clientDataJSON: string | null | undefined): string | null {
  const raw = String(clientDataJSON ?? "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    const challenge = typeof parsed.challenge === "string" ? parsed.challenge.trim() : "";
    return challenge || null;
  } catch {
    return null;
  }
}
