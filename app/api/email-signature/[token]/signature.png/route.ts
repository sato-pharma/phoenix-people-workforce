import { NextResponse } from "next/server";

import { printableLine, signatureLinesFor } from "@/lib/email-signature/signature-content";
import { signatureImageResponse } from "@/lib/email-signature/signature-image";
import { getSignatureCardForHrId } from "@/lib/email-signature/service";
import { openSignatureToken } from "@/lib/email-signature/signature-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/email-signature/<sealed address>/signature.png → one employee's signature picture.
//
// Public on purpose: a mail app fetches a signature picture with no Phoenix session, so the sealed
// address is the credential (see signature-token.ts). It carries only what a signature says to every
// recipient anyway — name, title, work mobile, work email — and takes nothing from the request but the
// address: no HR id, no query string, no body. A bad address and an unknown person both answer 404.

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const hrId = openSignatureToken(token);
    if (!hrId) return new NextResponse("Not found", { status: 404 });

    const card = await getSignatureCardForHrId(hrId);
    if (!card || !printableLine(card.name).text) return new NextResponse("Not found", { status: 404 });

    return signatureImageResponse(signatureLinesFor(card).lines);
  } catch (error) {
    console.error("[email-signature] picture failed", error);
    return new NextResponse("The signature picture could not be drawn.", { status: 500 });
  }
}
