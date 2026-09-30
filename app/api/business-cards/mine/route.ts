import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { CARD_FIELD_MAX_LENGTH } from "@/lib/business-cards/card-content";
import type { BusinessCardFields } from "@/lib/business-cards/card-content";
import { getOwnBusinessCard } from "@/lib/business-cards/request-service";
import {
  BusinessCardCharacterError,
  cardFileName,
  renderBusinessCardsPdf,
} from "@/lib/business-cards/render-pdf";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { cardName?, cardMobile? } → the caller's OWN business card as the print-ready PDF
// (front and back, the real Sato Pharma design — the same renderBusinessCardsPdf the HR generator
// uses, so the employee sees exactly the admin card). The card is built from the employee's own
// record; only the name and mobile they typed are overlaid, and the title/line·area/email/website/
// address come from the register — never from the body. Scoped to the caller alone: there is no
// hrId in the request, so it can only ever render the signed-in person's card.

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, CARD_FIELD_MAX_LENGTH) : "";
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_profile", "read");

    const body = (await request.json().catch(() => ({}))) as { cardMobile?: unknown; cardName?: unknown };

    const own = await getOwnBusinessCard(access);
    if (!own) {
      return NextResponse.json(
        { error: "no_card", message: "Your card details could not be found. Please try again in a moment." },
        { status: 404 },
      );
    }

    const name = clean(body.cardName) || own.name;
    if (!name) {
      return NextResponse.json({ error: "name_missing", message: "A name is required on the card." }, { status: 400 });
    }
    // Only the name and mobile are the employee's; everything else is the record's.
    const fields: BusinessCardFields = { ...own, mobile: clean(body.cardMobile), name };

    const pdf = await renderBusinessCardsPdf([fields], { title: `${name} — business card` });
    const pdfBytes = Buffer.from(pdf);
    // A fixed Content-Length keeps the ~2.7 MB card a single, known-length body rather than a
    // chunked stream, so the browser (and any proxy) reads to a definite end instead of guessing.
    return new Response(pdfBytes, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Disposition": `inline; filename="${cardFileName(name, "card")}"`,
        "Content-Length": String(pdfBytes.byteLength),
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You cannot generate this card." }, { status: 403 });
    }
    if (error instanceof BusinessCardCharacterError) {
      return NextResponse.json(
        {
          error: "unprintable_characters",
          message: "Your name has characters the card font cannot print — type it in English letters.",
        },
        { status: 422 },
      );
    }
    console.error("[business-cards/mine] render failed", error);
    return NextResponse.json(
      { error: "business_card_failed", message: "Your card could not be generated. Try again." },
      { status: 400 },
    );
  }
}
