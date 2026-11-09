/**
 * The Google credential for the Android Management API.
 *
 * WHY THIS IS NOT `sheets-client.ts`'s minting reused. That function bakes the Sheets scope into the
 * assertion it signs, and a token minted for `spreadsheets` answers 403 against
 * `androidmanagement` — a failure that looks like a broken enterprise binding rather than a wrong
 * scope, and gets debugged in the wrong file. Rather than reach into a sales-domain module and
 * widen its signature, the flow is spelled here for this domain's one scope. If a third caller ever
 * needs it, THAT is the moment to lift a shared helper out — two is not yet a pattern.
 *
 * 🔴 PRODUCTION RUNS ON A SERVICE-ACCOUNT KEY, AND ROTATING IT IS THE OWNER'S OWN JOB. Decided and
 * done 2026-09-18: `phoenix-amapi@phoenix-hr-2026.iam.gserviceaccount.com`, holding
 * `roles/androidmanagement.user` and nothing else, with one key stored base64 in Railway's
 * `ANDROID_MANAGEMENT_KEY`. The owner's Google Cloud org enforces
 * `constraints/iam.disableServiceAccountKeyCreation`, so that key exists only because he lifted the
 * constraint on that one project for the minting and restored it straight after. The constraint is
 * not retroactive, which is the only reason the key keeps working — so a rotation needs the same
 * lift, mint and restore, and it is his (a security setting and a credential), never a session's.
 * Everything above this file is written against `GoogleTokenProvider`, so moving to impersonation
 * or workload identity federation later would still change this file and nothing else.
 */

import { createSign } from "node:crypto";

import { ANDROID_MANAGEMENT_SCOPE } from "@/lib/devices/android-web-app";
import type { GoogleTokenProvider } from "@/lib/devices/android-web-app";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * The token exchange's deadline — the same 30 s every Android Management call has. It had none, so a
 * Google token endpoint that accepted the connection and never answered held the Super Admin's
 * request open with no end, while every call made WITH the token was already bounded.
 */
export const GOOGLE_TOKEN_TIMEOUT_MS = 30_000;

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

function base64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Exchange a service-account key for an access token (the standard JWT bearer flow).
 * `nowSeconds` is injectable so the assertion can be checked without freezing the clock globally.
 */
export async function mintAndroidManagementToken(
  key: ServiceAccountKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      aud: TOKEN_ENDPOINT,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      iss: key.client_email,
      scope: ANDROID_MANAGEMENT_SCOPE,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64Url(signer.sign(key.private_key))}`;

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    body: new URLSearchParams({
      assertion,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Google token exchange returned no access_token");
  return payload.access_token;
}

/**
 * The provider Phoenix uses at runtime.
 *
 * `ANDROID_MANAGEMENT_ACCESS_TOKEN` wins when set — the impersonated/local path, which lets the
 * iframe be developed and verified against the real enterprise with no key existing anywhere.
 * 🔴 Never set it on Railway: it outranks the key, and a `gcloud` token dies within the hour.
 * `ANDROID_MANAGEMENT_KEY` holds the service-account JSON, base64-encoded, for the same two reasons
 * the Master Map key is: the key is multi-line and Railway's variable paste has silently eaten the
 * following KEY=VALUE when given raw newlines, and `railway variables --stdin` prepends a BOM that
 * makes the JSON unparseable.
 */
// The bag is `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv` so a test can
// hand it a literal: Next makes `NODE_ENV` required on `ProcessEnv`, and the resulting error is
// invisible to `pnpm run test` (it strips types) — see docs/agents-session-traps.md.
export function androidManagementTokenProvider(
  env: Record<string, string | undefined> = process.env,
): GoogleTokenProvider {
  return async () => {
    const direct = env["ANDROID_MANAGEMENT_ACCESS_TOKEN"]?.trim();
    if (direct) return direct;

    const encoded = env["ANDROID_MANAGEMENT_KEY"]?.trim();
    if (!encoded) {
      throw new Error(
        "No Google credential for the Android Management API: set ANDROID_MANAGEMENT_KEY (base64 " +
          "service-account JSON) or ANDROID_MANAGEMENT_ACCESS_TOKEN.",
      );
    }
    const raw = encoded.startsWith("{")
      ? encoded
      : Buffer.from(encoded, "base64").toString("utf8");
    // A leading BOM survives several copy paths and makes JSON.parse fail with a message that
    // points at character 0 and explains nothing. Strip it rather than debug it again.
    const key = JSON.parse(raw.replace(/^﻿/, "")) as ServiceAccountKey;
    return mintAndroidManagementToken(key);
  };
}

/** Whether a credential is present at all — lets a page say "set this up" instead of throwing. */
export function hasAndroidManagementCredential(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    env["ANDROID_MANAGEMENT_ACCESS_TOKEN"]?.trim() || env["ANDROID_MANAGEMENT_KEY"]?.trim(),
  );
}
