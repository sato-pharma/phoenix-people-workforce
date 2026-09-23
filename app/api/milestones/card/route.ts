import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { milestoneCardHtml, type MilestoneCardVariant } from "@/lib/milestones/card";
import {
  MilestoneSpecError,
  milestoneFileName,
  parsePlainDate,
  type PlainDate,
} from "@/lib/milestones/periods";
import { renderMilestoneCard, renderMilestoneCardImage } from "@/lib/milestones/render";
import {
  MilestoneEmployeeNotFoundError,
  MilestoneHireDateMissingError,
  buildMilestoneCardInput,
} from "@/lib/milestones/service";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VARIANTS = new Set<MilestoneCardVariant>(["trim", "safe", "bleed"]);

/**
 * One milestone card.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `milestones:export` — Super Admin and CEO only. The gate is here and not in the
 * sidebar. It matters more than usual on this route: the card carries a named employee's
 * PHOTOGRAPH, fetched out of the private `employee-photos` bucket, onto a sheet built to be
 * printed and handed around. That is a publishing right.
 *
 * A POST, so nothing about a person travels in a URL somebody can forward (and nothing lands in an
 * access log). Three shapes come back:
 *
 *   `format: "pdf"`  — the sheet, ready to print. `variant` picks trim, safe or bleed.
 *   `format: "png"`  — the same sheet as a picture, at print resolution, for sending rather than
 *                      printing. Chromium renders it, so it is a print-path output like the PDF.
 *   `format: "html"` — the same artwork for an on-screen preview, laid out by the browser it is
 *                      shown in. It is NOT the print path: never save one and call it the card.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "milestones", "export");

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.hrId !== "string" || !body.hrId.trim()) {
      return Response.json({ error: "Name the employee the card is for." }, { status: 400 });
    }
    const spec = typeof body.period === "string" ? body.period : "1m";
    const on: PlainDate | null = typeof body.on === "string" ? parsePlainDate(body.on) : null;
    const displayName = typeof body.displayName === "string" ? body.displayName : null;
    const citation = typeof body.citation === "string" ? body.citation : null;
    const withoutPhoto = body.withoutPhoto === true;
    const requested = typeof body.variant === "string" ? (body.variant as MilestoneCardVariant) : "trim";
    const variant: MilestoneCardVariant = VARIANTS.has(requested) ? requested : "trim";
    const format = body.format === "html" ? "html" : body.format === "png" ? "png" : "pdf";

    const built = await buildMilestoneCardInput({
      hrId: body.hrId,
      spec,
      on,
      displayName,
      citation,
      withoutPhoto,
    });

    if (format === "html") {
      // The preview lays itself out, because nothing is standing by to evaluate the layout pass
      // for it the way the PDF path does.
      const html = milestoneCardHtml(built.input, { variant, autoLayout: true });
      return new Response(html, {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Rate-limited on both rendered paths: a preview is cheap, and Chromium is not. The picture is
    // the more expensive of the two, so it certainly does not get a cheaper allowance than the PDF.
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:milestones:card",
    });

    if (format === "png") {
      const picture = await renderMilestoneCardImage(built.input, variant);
      const pictureName = milestoneFileName(built.input.displayName, built.spec, built.on, "png");
      return new Response(new Uint8Array(picture.png), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${pictureName}"`,
          "Content-Type": "image/png",
          // Stated, not promised: the real pixel count of the file that was just sent.
          "X-Milestone-Pixels": `${picture.pixels.width}x${picture.pixels.height}`,
        },
      });
    }

    const rendered = await renderMilestoneCard(built.input, variant);
    const name = milestoneFileName(built.input.displayName, built.spec, built.on);

    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": "application/pdf",
        // The layout the browser settled on, so a support question about a squeezed name can be
        // answered from the response instead of by re-rendering it.
        "X-Milestone-Layout": `name=${rendered.layout.nameSize}pt lines=${rendered.layout.citationLines}`,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Milestone cards are available to the system administrator and the CEO only." },
        { status: 403 },
      );
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof MilestoneEmployeeNotFoundError || error instanceof MilestoneHireDateMissingError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof MilestoneSpecError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render PDFs right now. The preview is unaffected." },
        { status: 503 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The milestone card could not be produced.") },
      { status: 500 },
    );
  }
}
