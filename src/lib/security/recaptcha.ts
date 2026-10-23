// Server-side Google reCAPTCHA verification for public, unauthenticated endpoints.
//
// The careers-site application form (POST /api/public/apply) is reachable by anyone, so it cannot
// rely on a session or a shared secret the way every other cross-origin POST does. reCAPTCHA plus a
// per-IP rate limit is the anti-abuse story: the browser solves the challenge, sends the token as a
// form field, and this verifies it against Google before the CV is ingested.
//
// 🔴 IT FAILS CLOSED (23 Oct 2026 audit, P5-02). It used to fail OPEN twice over: with the secret unset
// the check was skipped, and when Google could not be reached (a network failure, a timeout, a non-200)
// the application was let through. Either way the public form then ran its paid AI CV read for
// whoever was posting. Now:
//   - secret unset          → refused, reason "not_configured" (logged once per process);
//   - Google unreachable    → refused, reason "verify_unavailable" (logged);
//   - Google says no / low  → refused, as before.
// The route answers a refusal the applicant can act on: 503 "captcha_unavailable" for the first two
// (try again shortly), 400 "captcha_failed" for the last. The secret is set on production (named in the
// 10 Oct 2026 variable read, docs/deployment.md, and declared in .railway/railway.ts), so the unset
// branch changes nothing there; a host without it now refuses public applications instead of taking them
// unchecked.

import { logError } from "@/lib/observability/log";

const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const DEFAULT_MIN_SCORE = 0.5;
// A Google hang must not hold the applicant's submission open. A timeout lands in the catch below
// and is refused, exactly like any other network failure — the policy in the header.
const RECAPTCHA_TIMEOUT_MS = 5000;

export type RecaptchaReason = "challenge_failed" | "low_score" | "missing_token" | "not_configured" | "verify_unavailable";
export type RecaptchaResult = { ok: boolean; reason?: RecaptchaReason };

/** A refusal that is OUR side failing (no key, Google unreachable), not the applicant failing the check. */
export function isRecaptchaUnavailable(result: RecaptchaResult): boolean {
  return !result.ok && (result.reason === "not_configured" || result.reason === "verify_unavailable");
}

function minScore(): number {
  const raw = Number(process.env.RECRUITMENT_APPLY_RECAPTCHA_MIN_SCORE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_MIN_SCORE;
}

// Logged ONCE per process, not once per applicant: an unset secret is a standing CONFIGURATION
// state, not an event, so a line per submission would be noise that buries it — while one line per
// container start is enough for `railway logs | grep recaptcha_secret_unset` to answer "is the
// public form protected right now?", which is the question that had no answer at all before.
let loggedMissingSecret = false;

export async function verifyRecaptcha(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<RecaptchaResult> {
  const secret = process.env.RECRUITMENT_APPLY_RECAPTCHA_SECRET?.trim();
  if (!secret) {
    if (!loggedMissingSecret) {
      loggedMissingSecret = true;
      logError("reCAPTCHA is not configured — the public apply endpoint is REFUSING every submission until RECRUITMENT_APPLY_RECAPTCHA_SECRET is set", {
        labels: { event: "recaptcha_secret_unset" },
      });
    }
    return { ok: false, reason: "not_configured" };
  }

  const response = String(token ?? "").trim();
  if (!response) return { ok: false, reason: "missing_token" };

  try {
    const body = new URLSearchParams({ response, secret });
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetch(SITEVERIFY_URL, {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      signal: AbortSignal.timeout(RECAPTCHA_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Google reachable but unhappy at the transport level — treat like an outage: refused.
      logError("reCAPTCHA siteverify returned a non-200", {
        labels: { event: "recaptcha_verify_http_error", status: String(res.status) },
      });
      return { ok: false, reason: "verify_unavailable" };
    }

    const data = (await res.json()) as { success?: boolean; score?: number };
    if (data.success !== true) return { ok: false, reason: "challenge_failed" };
    // v3 tokens carry a score; v2 tokens do not. Enforce the threshold only when a score is present.
    if (typeof data.score === "number" && data.score < minScore()) {
      return { ok: false, reason: "low_score" };
    }
    return { ok: true };
  } catch (error) {
    // Network failure or timeout reaching Google — refused; the applicant is told to try again shortly.
    logError("reCAPTCHA siteverify request failed", {
      error,
      labels: { event: "recaptcha_verify_request_failed" },
    });
    return { ok: false, reason: "verify_unavailable" };
  }
}
