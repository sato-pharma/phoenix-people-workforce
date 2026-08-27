import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { createOfferTemplate, listOfferTemplates } from "@/lib/offers/service";
import { isOfferTemplateVariant } from "@/lib/offers/builtin-templates";
import { offerJsonError } from "@/lib/offers/http";
import { resolveAccessContext } from "@/lib/auth/server";
import type { OfferBlock } from "@/lib/offers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "read");
    return NextResponse.json({ success: true, templates: await listOfferTemplates() });
  } catch (error) {
    return offerJsonError(error, "Failed to load the offer templates.");
  }
}

/**
 * Create a template — either blank ("build from scratch") or as a copy of an existing one.
 *
 * The owner asked for both: the uploaded SATO design as the default that can be edited, and an
 * empty canvas to start over on. Duplicating is the third path, and it re-ids every block on the
 * way through `sanitizeTemplateBlocks`' collision guard — block ids address the click and edit
 * targets, so a copy sharing them would mean editing one template edited the other.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "offers", "create");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ message: "A template name is required.", success: false }, { status: 400 });
    }

    // A duplicate must not share block ids with its source. Re-id here rather than trusting the
    // client, which is where the standalone builder's own copy bug lived.
    const blocks = Array.isArray(body.blocks)
      ? (body.blocks as OfferBlock[]).map((block, index) => ({
          ...block,
          id: `${String((block as { type?: string }).type ?? "block")}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        }))
      : [];

    const template = await createOfferTemplate(
      {
        blocks,
        fontFamily: typeof body.fontFamily === "string" ? body.fontFamily : undefined,
        fontSizePt: body.fontSizePt === undefined ? undefined : Number(body.fontSizePt),
        name,
        theme: body.theme as never,
        // A duplicate keeps the skin it was copied from, so "Duplicate" on the executive design
        // gives an executive-looking copy rather than the same blocks silently drawn as classic.
        variant: isOfferTemplateVariant(body.variant) ? body.variant : undefined,
      },
      access.hrId ?? null,
    );

    return NextResponse.json({ success: true, template });
  } catch (error) {
    return offerJsonError(error, "Failed to create this template.");
  }
}
