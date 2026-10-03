// Server-side Google reCAPTCHA verification for public, unauthenticated endpoints.
//
// The careers-site application form (POST /api/public/apply) is reachable by anyone, so it cannot
// rely on a session or a shared secret the way every other cross-origin POST does. reCAPTCHA plus a
// per-IP rate limit is the anti-abuse story: the browser solves the challenge, sends the token as a
// form field, and this verifies it against Google before the CV is ingested.
//
// TWO DELIBERATE FAIL DIRECTIONS. When the secret is UNSET the check is SKIPPED (ok, skipped) so the
// feature works the moment the form ships and hardens when the owner adds the key — the rate limit
// still guards it meanwhile. When the secret IS set, an explicit `success:false` from Google is a
// hard REJECT (a forged, replayed or absent token), but a NETWORK failure reaching Google fails OPEN
// (logged): a genuine applicant must not be lost to a Google outage, and abuse at that moment is
// still rate-limited. So the only thing that turns applicants away is Google itself saying "no".
//
// 🔴 THE SKIP IS NOW LOGGED (2026-09-30). It used to return { ok: true, skipped: true } with no log
// and no metric, and the sole caller (app/api/public/apply/route.ts) reads only `ok` — so with the
// secret absent from production the public form's bot protection was OFF and nothing anywhere said
// so. Still fails OPEN, deliberately: making it fail closed would take the live careers form down
// the moment it shipped. The change is only that the state is now visible.

import { logError } from "@/lib/observability/log";

const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const DEFAULT_MIN_SCORE = 0.5;
// A Google hang must not hold the applicant's submission open. A timeout lands in the catch below
// and fails OPEN, exactly like any other network failure — the policy in the header.
const RECAPTCHA_TIMEOUT_MS = 5000;

export type RecaptchaResult = { ok: boolean; skipped?: boolean; reason?: string };

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
      logError("reCAPTCHA is not configured — the public apply endpoint is accepting submissions with no bot check", {
        labels: { event: "recaptcha_secret_unset" },
      });
    }
    return { ok: true, skipped: true };
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
      // Google reachable but unhappy at the transport level — treat like an outage, fail open.
      logError("reCAPTCHA siteverify returned a non-200", {
        labels: { event: "recaptcha_verify_http_error", status: String(res.status) },
      });
      return { ok: true, reason: "verify_unavailable", skipped: true };
    }

    const data = (await res.json()) as { success?: boolean; score?: number };
    if (data.success !== true) return { ok: false, reason: "challenge_failed" };
    // v3 tokens carry a score; v2 tokens do not. Enforce the threshold only when a score is present.
    if (typeof data.score === "number" && data.score < minScore()) {
      return { ok: false, reason: "low_score" };
    }
    return { ok: true };
  } catch (error) {
    // Network failure reaching Google — never lose a real applicant to it.
    logError("reCAPTCHA siteverify request failed", {
      error,
      labels: { event: "recaptcha_verify_request_failed" },
    });
    return { ok: true, reason: "verify_unavailable", skipped: true };
  }
}
