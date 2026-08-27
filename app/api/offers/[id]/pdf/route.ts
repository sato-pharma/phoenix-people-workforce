import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { defaultOfferTemplate, getOffer, getOfferTemplate } from "@/lib/offers/service";
import { offerJsonError } from "@/lib/offers/http";
import { offerPdfFilename, renderOfferPdf } from "@/lib/offers/pdf";
import { resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Download the offer as a PDF.
 *
 * A SENT offer renders from its own snapshot, never from the live template. That is the whole
 * reason the snapshot exists: HR downloading a copy of an offer issued last month must get the
 * document that was actually sent, not today's design applied to last month's numbers.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");

    const { id } = await context.params;
    const offer = await getOffer(id);

    const template = offer.templateSnapshot
      ? offer.templateSnapshot
      : offer.templateId
        ? await getOfferTemplate(offer.templateId)
        : await defaultOfferTemplate();

    const pdf = await renderOfferPdf(
      {
        blocks: template.blocks,
        fontFamily: template.fontFamily,
        fontSizePt: template.fontSizePt,
        theme: template.theme,
        variant: template.variant,
      },
      offer,
    );

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${offerPdfFilename(offer)}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    return offerJsonError(error, "Failed to render this offer as a PDF.");
  }
}
