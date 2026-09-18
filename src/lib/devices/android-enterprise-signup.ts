/**
 * Binding Phoenix to an Android Enterprise — the one prerequisite everything else waits on.
 *
 * `ANDROID_MANAGEMENT_ENTERPRISE_NAME` is set nowhere, so today every call in `android-web-app.ts`
 * and `managed-play-iframe.ts` raises `AndroidManagementNotConfiguredError` before it reaches
 * Google. This module is how that binding comes into existence, and it exists because the
 * alternative was a note telling the owner to run two curl commands by hand.
 *
 * THE FLOW, AND THE TRAP IN THE MIDDLE OF IT.
 *
 *   1. `signupUrls.create` returns `{ name, url }`. The `url` is a Google-hosted page.
 *   2. The owner opens it, signs in with the Google account that will OWN the enterprise, and
 *      completes managed Google Play enrolment. Google then redirects to our callback with an
 *      `enterpriseToken` query parameter appended.
 *   3. `enterprises.create` takes BOTH the `enterpriseToken` from step 2 AND the `signupUrlName`
 *      from step 1, and returns the binding — `enterprises/LC…`.
 *
 * 🔴 STEP 3 NEEDS STEP 1'S NAME, AND THE REDIRECT DOES NOT CARRY IT. The callback URL has to be
 * fixed before the signup URL exists, so the name cannot be embedded in it — and losing it means
 * the enrolment the owner just completed cannot be turned into an enterprise at all. He would have
 * to start over. It is therefore parked in an httpOnly cookie between the two steps, which is also
 * why that cookie is short-lived and `sameSite: "lax"` rather than `"strict"`: a `strict` cookie is
 * NOT sent on a top-level navigation that originates on Google's domain, so the callback would
 * arrive without it and the flow would fail at the last step, every time.
 *
 * 🔴 WHICH GOOGLE ACCOUNT SIGNS IN IS THE IRREVERSIBLE DECISION. The enterprise binds to that
 * account, the free Play developer account the iframe later creates hangs off it, and that account
 * is non-transferable. A personal Gmail used "just to test" becomes the permanent owner of the
 * company's device fleet. Nothing in code can undo it, which is why the page says so before the
 * button rather than after.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never writes the binding anywhere itself. The result is
 * shown to the owner to put into `ANDROID_MANAGEMENT_ENTERPRISE_NAME`, because that is the contract
 * `androidManagementConfig()` already reads and another session's work is built on it. Persisting
 * it somewhere else as well would create a second source of truth for the same fact.
 */

import {
  ANDROID_MANAGEMENT_API,
  AndroidManagementRequestError,
} from "@/lib/devices/android-web-app";

/** Where the signup name is parked between Google's redirect and `enterprises.create`. */
export const SIGNUP_URL_NAME_COOKIE = "phx_amapi_signup";

/**
 * Ten minutes. Long enough to read Google's enrolment screens without hurrying, short enough that a
 * cookie naming a half-finished signup does not outlive the attempt.
 */
export const SIGNUP_URL_NAME_COOKIE_MAX_AGE_SECONDS = 600;

/**
 * How the finished binding reaches the page that displays it.
 *
 * A cookie rather than a query parameter because the callback is a redirect and the binding would
 * otherwise sit in the address bar, in browser history and in any referrer the page then sends. It
 * is an identifier rather than a credential, so this is tidiness rather than a breach — but the
 * tidy version costs nothing here.
 *
 * 🔴 NOT httpOnly, unlike the signup cookie: a Next.js Server Component can READ a cookie but
 * cannot clear one, so the page shows the binding and then lets it expire on its own. Ten minutes
 * is the whole lifetime.
 */
export const ENTERPRISE_RESULT_COOKIE = "phx_amapi_enterprise";
export const ENTERPRISE_RESULT_COOKIE_MAX_AGE_SECONDS = 600;

export type AndroidEnterpriseSignupUrl = {
  /** `signupUrls/C…` — required by `enterprises.create`, and the reason for the cookie. */
  name: string;
  /** The Google-hosted page the owner opens. */
  url: string;
};

/** Long enough for Google, short enough that a wedged call frees the request. */
const SIGNUP_TIMEOUT_MS = 20_000;

function projectId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ANDROID_MANAGEMENT_PROJECT_ID?.trim();
  if (!value) {
    throw new Error(
      "ANDROID_MANAGEMENT_PROJECT_ID is not set. It is the Google Cloud project the Android " +
        "Management API is enabled on — the quota is 2 projects for the whole company, so this is " +
        "Phoenix's own, not a new one.",
    );
  }
  return value;
}

/**
 * The address Google sends the owner back to.
 *
 * Required to be https and free of a query string: Google appends `?enterpriseToken=…` itself, and
 * a callback that already carries one arrives with two query parts that do not merge cleanly.
 */
export function assertCallbackUrl(callbackUrl: string): string {
  const trimmed = callbackUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`The callback URL must be absolute — got '${trimmed}'.`);
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error(
      `The callback URL must be https (http is permitted only for localhost) — got '${trimmed}'.`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `The callback URL must carry no query string or fragment — got '${trimmed}'. Google appends ` +
        "enterpriseToken to it, and an existing query makes the result ambiguous.",
    );
  }
  return trimmed;
}

async function callGoogle(
  token: string,
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    body: JSON.stringify(body ?? {}),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(SIGNUP_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AndroidManagementRequestError(
      `Android Management API POST ${new URL(url).pathname} failed (${response.status}): ${text}`,
      response.status,
    );
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

/** Step 1 — ask Google for the enrolment page the owner will open. */
export async function createEnterpriseSignupUrl(
  options: { token: string; callbackUrl: string; env?: NodeJS.ProcessEnv },
  fetchImpl: typeof fetch = fetch,
): Promise<AndroidEnterpriseSignupUrl> {
  const callbackUrl = assertCallbackUrl(options.callbackUrl);
  const url = new URL(`${ANDROID_MANAGEMENT_API}/signupUrls`);
  url.searchParams.set("projectId", projectId(options.env));
  url.searchParams.set("callbackUrl", callbackUrl);

  const payload = (await callGoogle(options.token, url.toString(), {}, fetchImpl)) as {
    name?: string;
    url?: string;
  };
  const name = payload.name?.trim();
  const signupUrl = payload.url?.trim();
  if (!name || !signupUrl) {
    throw new AndroidManagementRequestError(
      "Google returned a signup URL without both a name and a url — the enrolment cannot be " +
        "completed without the name, so this is a failure rather than a partial success.",
      200,
    );
  }
  return { name, url: signupUrl };
}

/**
 * Step 3 — turn the completed enrolment into the binding.
 *
 * `enterpriseToken` is single-use: Google rejects a second attempt with the same one, so a caller
 * that retries on a network blip gets a confusing error rather than a duplicate enterprise. That is
 * the safe direction to fail in and is why nothing here retries.
 */
export async function createEnterprise(
  options: {
    token: string;
    signupUrlName: string;
    enterpriseToken: string;
    /** Shown to admins in Google's own surfaces. Defaults to the Phoenix brand. */
    displayName?: string;
    env?: NodeJS.ProcessEnv;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ enterpriseName: string }> {
  const signupUrlName = options.signupUrlName.trim();
  const enterpriseToken = options.enterpriseToken.trim();
  if (!signupUrlName) {
    throw new Error(
      "The signup URL name is missing. It is parked in a short-lived cookie between Google's " +
        "enrolment page and this callback — if the enrolment took more than ten minutes, or the " +
        "callback was opened in a different browser, start the signup again.",
    );
  }
  if (!enterpriseToken) {
    throw new Error("Google's callback carried no enterpriseToken — the enrolment did not complete.");
  }

  const url = new URL(`${ANDROID_MANAGEMENT_API}/enterprises`);
  url.searchParams.set("projectId", projectId(options.env));
  url.searchParams.set("signupUrlName", signupUrlName);
  url.searchParams.set("enterpriseToken", enterpriseToken);

  const payload = (await callGoogle(
    options.token,
    url.toString(),
    { enterpriseDisplayName: options.displayName?.trim() || "Phoenix" },
    fetchImpl,
  )) as { name?: string };

  const enterpriseName = payload.name?.trim();
  if (!enterpriseName?.startsWith("enterprises/")) {
    throw new AndroidManagementRequestError(
      `Google created the enterprise but returned '${enterpriseName ?? ""}' rather than an ` +
        "'enterprises/…' binding. Nothing can be configured from that.",
      200,
    );
  }
  return { enterpriseName };
}
