import { NextResponse } from "next/server";

import { printableLine, signatureLinesFor } from "@/lib/email-signature/signature-content";
import { signatureImageResponse } from "@/lib/email-signature/signature-image";
import { getSignatureCardForHrId } from "@/lib/email-signature/service";
import { openSignatureToken } from "@/lib/email-signature/signature-token";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/email-signature/<sealed address>/signature.png → one employee's signature picture.
//
// Public on purpose: a mail app fetches a signature picture with no Phoenix session, so the sealed
// address is the credential (see signature-token.ts). It carries only what a signature says to every
// recipient anyway — name, title, work mobile, work email — and takes nothing from the request but the
// address: no HR id, no query string, no body. A bad address and an unknown person both answer 404.
//
// Metered per network address BEFORE the address is opened (REC-055, F-RCT-016): far above what any
// one inbox asks, so a mail app never meets it, while a flood of requests cannot keep the server drawing.
// A drawn picture is kept for the hour (signature-image.ts), so an opened email costs no drawing.

const HOUR = 60 * 60 * 1000;
const LIMIT_PER_ADDRESS = 600;

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: LIMIT_PER_ADDRESS,
      scope: "email_signature_image_ip",
      windowMs: HOUR,
    });
    const { token } = await context.params;
    const hrId = openSignatureToken(token);
    if (!hrId) return new NextResponse("Not found", { status: 404 });

    const card = await getSignatureCardForHrId(hrId);
    if (!card || !printableLine(card.name).text) return new NextResponse("Not found", { status: 404 });

    return await signatureImageResponse(signatureLinesFor(card).lines);
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return new NextResponse("Too many requests.", {
        headers: { "Retry-After": String(error.retryAfterSeconds) },
        status: 429,
      });
    }
    console.error("[email-signature] picture failed", error);
    return new NextResponse("The signature picture could not be drawn.", { status: 500 });
  }
}
