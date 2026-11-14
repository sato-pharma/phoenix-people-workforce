import { NextResponse } from "next/server";

import { logError } from "@/lib/observability/log";
import type { JoiningFormUploadField } from "@/lib/offers/joining-form";
import { submitJoiningForm, type JoiningFormPhoto } from "@/lib/offers/joining-form-service";
import { recordHireFromOfferLetter } from "@/lib/recruitment/offer-outcome-sync";
import { runHandoffStep, syncOutcomeFailure } from "@/lib/employees/hire-handoff";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { clientAddress } from "@/lib/security/client-address";
import { errorMessageOf } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const PROXY_BODY_LIMIT = 10 * 1024 * 1024;

/** A photo part, or null when it is missing or empty — the service names which one is needed. */
async function readPhoto(entry: FormDataEntryValue | null): Promise<JoiningFormPhoto | null> {
  if (!(entry instanceof File) || entry.size <= 0) return null;
  return { bytes: Buffer.from(await entry.arrayBuffer()), contentType: (entry.type || "application/octet-stream").toLowerCase() };
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    status,
  });
}

/**
 * POST /api/public/offer-acceptance/[token] — the joining form's Submit, which IS the candidate's
 * acceptance of the offer (owner, 2026-10-08). No session: the signed token is the credential, and
 * `submitJoiningForm` re-reads the offer, validates every answer server-side and claims the offer
 * row before it writes anything, so a replay or a double click cannot create a second employee.
 *
 * Rate-limited twice — per link and per address — so a leaked link cannot be hammered.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await params;

  try {
    await assertApiRateLimit({ identifier: rateLimitIdentity({ request, token }), limit: 10, scope: "offer_joining_form_link", windowMs: HOUR });
    await assertApiRateLimit({ identifier: rateLimitIdentity({ request }), limit: 30, scope: "offer_joining_form_ip", windowMs: HOUR });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return json({ message: "Too many attempts. Please wait a few minutes and try again.", ok: false }, 429);
    }
    throw error;
  }

  // Multipart: the answers as one JSON field, the national ID photos as `idFront` and `idBack`, and the
  // optional photo as `photo`.
  // The proxy cuts any body at 10 MB (proxy.ts), so a bigger one is refused here by its declared size
  // rather than arriving truncated and failing as an unreadable form.
  if (Number(request.headers.get("content-length") ?? 0) > PROXY_BODY_LIMIT) {
    return json({ message: "Your photos are too large to send. Please take them again, or choose smaller ones.", ok: false }, 413);
  }
  let answers: Record<string, unknown>;
  let photos: Record<JoiningFormUploadField, JoiningFormPhoto | null>;
  try {
    const form = await request.formData();
    const raw = form.get("answers");
    const body = JSON.parse(typeof raw === "string" ? raw : "") as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    answers = body as Record<string, unknown>;
    photos = {
      idBack: await readPhoto(form.get("idBack")),
      idFront: await readPhoto(form.get("idFront")),
      photo: await readPhoto(form.get("photo")),
    };
  } catch {
    return json({ message: "The form could not be read. Please try again.", ok: false }, 400);
  }

  try {
    const result = await submitJoiningForm(token, answers, photos, {
      ip: clientAddress(request),
      userAgent: request.headers.get("user-agent"),
    });
    if (result.ok) {
      // The candidate behind this letter, if there is one, joined. The recruitment module is reached
      // from HERE and not from the service because the offers module never imports recruitment
      // (tests/candidate-offer-pointer.test.ts). Best effort: the employee is already written. The
      // offer id stays on the server; the candidate is shown only what the form always returned.
      // Recorded in the hire hand-off ledger (REC-027), so a link that fails is retried hourly.
      const { offerId, ...visible } = result;
      await runHandoffStep(result.hrId, "joining_form", "offer_link", { offerId }, () =>
        recordHireFromOfferLetter({ actorHrId: null, hrId: result.hrId, offerId }), { failureOf: syncOutcomeFailure });
      return json(visible);
    }
    if ("errors" in result) {
      return json({ errors: result.errors, message: "Please check the highlighted fields and try again.", ok: false }, result.status);
    }
    return json({ message: result.message, ok: false }, result.status);
  } catch (error) {
    logError("The joining form submit failed unexpectedly", {
      error: error instanceof Error ? error : new Error(errorMessageOf(error)),
      labels: { event: "offer_joining_form_unexpected" },
    });
    return json({ message: "We could not complete your joining form right now. Please try again shortly, or reply to the offer email.", ok: false }, 500);
  }
}
