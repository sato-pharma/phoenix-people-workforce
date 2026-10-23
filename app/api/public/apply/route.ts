// The public careers-site application endpoint.
//
// www.satopharma.com/careers renders a form from GET (the live question schema for a position) and
// POSTs the applicant's CV plus their answers here. This is the ONE route in the app a browser on a
// DIFFERENT origin is allowed to POST to — see the CSRF exemption in proxy.ts, which is safe here
// because this route stands on reCAPTCHA + a per-IP rate limit, not on a same-origin session. The
// work itself lives in src/lib/recruitment/inbound/website-apply.ts; this handler only marshals the
// request, sets CORS, and shapes the JSON reply.

import { NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/observability/log";
import {
  resolveWebsiteApplyRole,
  submitWebsiteApplication,
  validateWebsiteApplication,
  websiteApplyFormFor,
  type WebsiteApplyForm,
  type WebsiteApplyRawAnswers,
} from "@/lib/recruitment/inbound/website-apply";
import {
  ApiRateLimitError,
  assertApiRateLimit,
  rateLimitIdentity,
} from "@/lib/security/api-rate-limit";
import { isRecaptchaUnavailable, verifyRecaptcha } from "@/lib/security/recaptcha";
import { clientAddress } from "@/lib/security/client-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_ALLOWED_ORIGINS = ["https://www.satopharma.com", "https://satopharma.com"];

function allowedOrigins(): string[] {
  const configured = process.env.RECRUITMENT_APPLY_ALLOWED_ORIGINS?.trim();
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** CORS headers echoing the request Origin only when it is on the allowlist — never a blanket "*",
 *  which would let any site read this endpoint's replies. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(request: Request, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { headers: corsHeaders(request), status });
}

export function OPTIONS(request: Request): NextResponse {
  return new NextResponse(null, { headers: corsHeaders(request), status: 204 });
}

/** GET /api/public/apply?role=<key> — the live form schema the website renders. */
export async function GET(request: Request): Promise<NextResponse> {
  const roleKey = new URL(request.url).searchParams.get("role");
  const role = resolveWebsiteApplyRole(roleKey);
  if (!role) return json(request, { error: "unknown_role" }, 404);

  try {
    const form = await websiteApplyFormFor(role);
    return json(request, { form });
  } catch (error) {
    logError("Website apply form schema failed to build", {
      error,
      labels: { event: "website_apply_form_failed", role: role.key },
    });
    return json(request, { error: "form_unavailable" }, 500);
  }
}

function readAttachment(cv: unknown): { fileName: string; mimeType: string } | null {
  if (typeof File !== "undefined" && cv instanceof File && cv.size > 0) {
    return { fileName: cv.name || "cv", mimeType: cv.type || "application/octet-stream" };
  }
  return null;
}

/** POST /api/public/apply — a CV plus the answers, as multipart/form-data. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: 10,
      scope: "public_apply",
      windowMs: 60 * 60 * 1000,
    });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return json(request, { error: "rate_limited" }, 429);
    }
    throw error;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(request, { error: "invalid_body" }, 400);
  }

  const role = resolveWebsiteApplyRole(String(form.get("role") ?? ""));
  if (!role) return json(request, { error: "unknown_role" }, 404);

  const captcha = await verifyRecaptcha(
    String(form.get("recaptchaToken") ?? "") || null,
    clientAddress(request),
  );
  // Fails closed (P5-02): our side not able to check is "try again shortly", never a pass.
  if (isRecaptchaUnavailable(captcha)) return json(request, { error: "captcha_unavailable" }, 503);
  if (!captcha.ok) return json(request, { error: "captcha_failed" }, 400);

  const cv = form.get("cv");
  const attachmentMeta = readAttachment(cv);
  if (!attachmentMeta) return json(request, { errors: ["Please attach your CV."] }, 400);

  // Everything that is not the file or the reCAPTCHA token, keyed exactly as the schema posts it.
  const answers: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === "cv" || key === "recaptchaToken" || key === "role") continue;
    if (typeof value === "string") answers[key] = value;
  }

  const raw: WebsiteApplyRawAnswers = {
    answers,
    email: String(form.get("email") ?? ""),
    fullName: String(form.get("full_name") ?? ""),
    phone: String(form.get("phone") ?? ""),
  };

  let schema: WebsiteApplyForm;
  try {
    schema = await websiteApplyFormFor(role);
  } catch (error) {
    logError("Website apply form schema failed to build on submit", {
      error,
      labels: { event: "website_apply_form_failed", role: role.key },
    });
    return json(request, { error: "form_unavailable" }, 500);
  }

  const validation = validateWebsiteApplication(role, schema, raw);
  if (!validation.ok) return json(request, { errors: validation.errors }, 400);

  const bytes = Buffer.from(await (cv as File).arrayBuffer());
  const outcome = await submitWebsiteApplication({
    attachment: { bytes, fileName: attachmentMeta.fileName, mimeType: attachmentMeta.mimeType },
    classification: validation.classification,
    email: raw.email.trim(),
    fullName: raw.fullName.trim(),
    phone: raw.phone.trim(),
    role,
  });

  if (outcome.ok) {
    logInfo("Website application received", {
      labels: { candidate_id: outcome.candidateId, event: "website_apply_received", role: role.key },
    });
    // `message` is present only when an answer ended the application (the Cairo question): the page
    // shows it in place of the usual "thank you for applying" screen.
    return json(request, outcome.endedMessage ? { message: outcome.endedMessage, ok: true } : { ok: true });
  }

  if (outcome.reason === "duplicate") return json(request, { ok: true });
  const status = outcome.reason === "unreadable_cv" ? 400 : 500;
  return json(request, { errors: [outcome.message] }, status);
}
