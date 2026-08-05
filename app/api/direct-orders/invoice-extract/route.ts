import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { extractDirectOrderInvoice, InvoiceExtractionError } from "@/lib/direct-orders/invoice-extraction";
import { PhoenixOpenAiError } from "@/lib/ai/openai-client";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading a photographed invoice runs well past the default budget on a slow connection.
export const maxDuration = 60;

/**
 * Read a photographed distributor invoice and return resolved prefill data (spec B5).
 *
 * A mutation-shaped POST that writes nothing: it exists as POST because the payload is a
 * multi-megabyte image, which has no business in a URL, and it carries CSRF for the same reason
 * every other POST here does.
 *
 * The reader runs ONLY on the server (spec D4 — nothing in the browser may betray a model), and
 * every message returned below is written for a medical rep looking at their phone, never
 * mentioning a model, a provider, or a confidence score.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { imageBase64?: string; mimeType?: string };
    const result = await extractDirectOrderInvoice(access, {
      imageBase64: String(body.imageBase64 ?? ""),
      mimeType: String(body.mimeType ?? ""),
    });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    // A bad photo is the submitter's problem to fix and gets a 400 with a sentence they can act on.
    if (error instanceof InvoiceExtractionError) {
      return NextResponse.json(
        { error: error.code, message: error.message, success: false },
        { status: error.code === "not_configured" ? 503 : 400 },
      );
    }
    // An upstream failure is OURS, and must not be dressed up as a bad invoice — otherwise the rep
    // retakes the photo five times to fix an outage they cannot see.
    if (error instanceof PhoenixOpenAiError) {
      return NextResponse.json(
        {
          error: "invoice_read_unavailable",
          message: "The invoice could not be read just now. Try again in a moment, or fill the order in by hand.",
          success: false,
        },
        { status: 503 },
      );
    }
    const apiError = toApiError(error, "Could not read the invoice.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
