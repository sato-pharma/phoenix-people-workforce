/**
 * THE SECOND SIGN-IN STEP (integration audit INT-005; owner, 13 Nov 2026).
 *
 * Until this file a password alone opened every account: 0 of the sign-in accounts had a second factor, so a
 * stolen Super Admin password opened payroll, permissions and every record. His four choices, word for word:
 *
 *   who         "Super Admin accounts only"
 *   what        "Authenticator app, passkey counts"
 *   how often   "Once per device, 30 days"
 *   lost phone  "Recovery codes plus your reset"
 *
 * So: a Super Admin who signs in with a PASSWORD must also give a 6-digit code from an authenticator app
 * (RFC 6238, the standard every authenticator app speaks), unless this browser passed the step in the last
 * 30 days. A passkey sign-in already proves the device and the person (the passkey route demands user
 * verification), so it is both steps at once and is not asked for a code. Ten one-time recovery codes are
 * shown once at set-up, and a Super Admin can reset another account's second step.
 *
 * This file is the arithmetic and the rules, with no database and no network, so the tests can load it. The
 * rows live in second-step-store.ts; the sign-in route (app/api/auth/login/route.ts) asks both.
 *
 * 🔴 The step is decided at sign-in and nowhere else. Nothing here widens access: every answer either lets a
 * sign-in that already passed its password go on, or stops it.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { PhoenixRole } from "@/lib/auth/permissions";

/** Who must pass the second step. His choice: the Super Admin accounts, and nobody else. */
export const SECOND_STEP_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>(["Super Admin"]);

export function secondStepRequiredForRole(role: PhoenixRole | string | null | undefined): boolean {
  return SECOND_STEP_ROLES.has(role as PhoenixRole);
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side of now: a phone's clock a few seconds off, or a code typed as it rolls over. */
export const TOTP_STEPS_OF_SKEW = 1;

/** His choice: a browser that passed the step is trusted for 30 days. */
export const TRUSTED_DEVICE_DAYS = 30;
export const TRUSTED_DEVICE_MAX_AGE_SECONDS = TRUSTED_DEVICE_DAYS * 24 * 60 * 60;
export const trustedDeviceCookieName = "phoenix_trusted_device";

export const RECOVERY_CODE_COUNT = 10;
/** A set-up key that was handed over waits this long for its first code; after that it finishes nothing. */
export const PENDING_SETUP_MINUTES = 15;

export const SECOND_STEP_ISSUER = "Phoenix Workforce";

// ── Base32 (RFC 4648, no padding): the alphabet authenticator apps read a key in ──────────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** Null for anything that is not base32: a key is never guessed at. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── The authenticator code ──────────────────────────────────────────────────────────────────────

/** A new key: 160 random bits, as RFC 4226 recommends, written in base32 (32 characters). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The 6-digit code of one 30-second step (RFC 6238 over HMAC-SHA1, what every authenticator app computes). */
export function totpCode(secretBase32: string, step: number): string | null {
  const key = base32Decode(secretBase32);
  if (!key || key.length < 10 || !Number.isSafeInteger(step) || step < 0) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The step a typed code belongs to, or null when it is wrong.
 *
 * 🔴 A code is good ONCE. `lastUsedStep` is the newest step this account already used; a code of that step
 * or an older one is refused, so a code read over a shoulder or caught in transit cannot be used again.
 */
export function matchTotp(input: { code: string; lastUsedStep: number | null; nowMs: number; secret: string }): number | null {
  if (!/^\d{6}$/.test(input.code)) return null;
  const current = totpStepAt(input.nowMs);
  let matched: number | null = null;
  // Every candidate is computed and compared, so the time taken does not say which step matched.
  for (let step = current - TOTP_STEPS_OF_SKEW; step <= current + TOTP_STEPS_OF_SKEW; step += 1) {
    const expected = totpCode(input.secret, step);
    if (expected && sameText(expected, input.code) && (input.lastUsedStep === null || step > input.lastUsedStep)) {
      matched = matched ?? step;
    }
  }
  return matched;
}

/** What an authenticator app opens: the key, the account's name, and the standard's own settings. */
export function otpauthUri(input: { account: string; secret: string }): string {
  const label = `${encodeURIComponent(SECOND_STEP_ISSUER)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    issuer: SECOND_STEP_ISSUER,
    period: String(TOTP_PERIOD_SECONDS),
    secret: input.secret,
  });
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, "%20")}`;
}

/** The key in fours, as a person types it into the app: "ABCD EFGH …". */
export function secretForTyping(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

// ── Recovery codes ──────────────────────────────────────────────────────────────────────────────

// No 0/O, 1/I/L: a code is read off paper.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_LENGTH = 10;

/** Ten one-time codes, each 10 characters shown as XXXXX-XXXXX (about 49 bits; every try is throttled). */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    let code = "";
    while (code.length < RECOVERY_CODE_LENGTH) {
      // Rejection sampling: a byte past the last whole multiple of the alphabet would favour its first letters.
      const byte = randomBytes(1)[0];
      if (byte < RECOVERY_ALPHABET.length * Math.floor(256 / RECOVERY_ALPHABET.length)) {
        code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      }
    }
    const shown = `${code.slice(0, 5)}-${code.slice(5)}`;
    if (!codes.includes(shown)) codes.push(shown);
  }
  return codes;
}

export type SecondStepCode = { kind: "totp"; code: string } | { kind: "recovery"; code: string };

/** What the person typed, read as an authenticator code or a recovery code; null when it is neither. */
export function readSecondStepCode(raw: unknown): SecondStepCode | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{6}$/.test(compact)) return { code: compact, kind: "totp" };
  if (compact.length === RECOVERY_CODE_LENGTH && [...compact].every((character) => RECOVERY_ALPHABET.includes(character))) {
    return { code: compact, kind: "recovery" };
  }
  return null;
}

function authSecret(): string {
  const secret = process.env.PHOENIX_AUTH_SECRET;
  if (typeof secret !== "string" || secret.trim().length < 16) {
    throw new Error("PHOENIX_AUTH_SECRET is not set; the second sign-in step cannot store or check a recovery code.");
  }
  return secret;
}

/**
 * What is stored for a recovery code: a keyed fingerprint, never the code. Keyed with the server's own
 * secret, so a copy of the table alone cannot be searched for a code.
 */
export function recoveryCodeHash(loginId: string, code: string): string {
  return createHmac("sha256", `${authSecret()}\u0000second-step-recovery`)
    .update(`${loginId.toLowerCase()}\u0000${code}`)
    .digest("hex");
}

// ── The trusted device ──────────────────────────────────────────────────────────────────────────

/** 256 random bits, kept by the browser in an HttpOnly cookie. Only its fingerprint is stored. */
export function newTrustedDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function trustedDeviceTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A cookie value that could be one of ours; anything else is not looked up. */
export function looksLikeTrustedDeviceToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// ── What the sign-in route does next ────────────────────────────────────────────────────────────

export type SecondStepDecision =
  /** The role is not asked, or this browser is trusted: go on. */
  | "pass"
  /** Set up, not trusted, no code sent: ask for one. */
  | "ask_code"
  /** Set up, not trusted, a code was sent: check it. */
  | "check_code"
  /** Not set up, no code sent: hand over a key to set up with. */
  | "offer_setup"
  /** Not set up, a code was sent: check it against the key handed over, and finish the set-up. */
  | "finish_setup";

/**
 * 🔴 A trusted browser is honoured ONLY for an account that is set up. Without that, a cookie left from
 * before a reset would carry an account past its own new set-up.
 */
export function decideSecondStep(input: {
  codeSent: boolean;
  required: boolean;
  setUp: boolean;
  trustedDevice: boolean;
}): SecondStepDecision {
  if (!input.required) return "pass";
  if (!input.setUp) return input.codeSent ? "finish_setup" : "offer_setup";
  if (input.trustedDevice) return "pass";
  return input.codeSent ? "check_code" : "ask_code";
}
