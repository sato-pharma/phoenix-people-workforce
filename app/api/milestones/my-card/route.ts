import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseEmployeePortalMilestones } from "@/lib/employee-portal/navigation";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import {
  MilestoneSpecError,
  milestoneCardFileName,
  parsePlainDate,
  type PlainDate,
} from "@/lib/milestones/periods";
import { renderMilestoneCard } from "@/lib/milestones/render";
import {
  MilestoneBirthDateMissingError,
  MilestoneEmployeeNotFoundError,
  MilestoneHireDateMissingError,
  buildMilestoneCardInput,
} from "@/lib/milestones/service";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The rep's OWN milestone card.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY IS THAT THE SUBJECT IS ALWAYS THE CALLER. The company-wide card route
 * (/api/milestones/card) is Super-Admin-only because it prints ANY named employee's photograph onto
 * a shareable sheet — a publishing right. This route hands a person only their own keepsake, so it
 * needs no `milestones` grant: it reads `access.hrId` and builds the card for THAT id and no other.
 * A `hrId` in the body is ignored entirely, so a rep can never point it at a colleague. The audience
 * is the same one the sidebar offers (canUseEmployeePortalMilestones); anyone else gets 403.
 *
 * It never touches the shared print ledger (milestone_card_prints). That log means "this person was
 * congratulated", and its marks drive the Super Admin's "already congratulated" tick — a rep printing
 * his own keepsake is not the company congratulating him, so recording it would put a false tick on
 * the admin due list. The photograph is the record's own (no upload, no name override): a rep prints
 * himself as the directory holds him.
 *
 * A POST so nothing about the person travels in a URL or lands in an access log; the response is the
 * PDF, ready to print.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.hrId) {
      return Response.json({ error: "Sign in to download your milestone card." }, { status: 401 });
    }
    if (!canUseEmployeePortalMilestones(access.role)) {
      return Response.json({ error: "Milestone cards are available to medical reps only." }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const rawPeriod = body && typeof body.period === "string" ? body.period.trim() : "";
    const spec = rawPeriod || "1m";
    const on: PlainDate | null = body && typeof body.on === "string" ? parsePlainDate(body.on) : null;

    // The subject is the caller, always — never a hrId off the wire.
    const built = await buildMilestoneCardInput({ hrId: access.hrId, spec, on });

    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:milestones:my-card",
    });

    const rendered = await renderMilestoneCard(built.input);
    const name = milestoneCardFileName(built.input.displayName, built.periodSpec, built.on);

    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "Milestone cards are available to medical reps only." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    if (
      error instanceof MilestoneEmployeeNotFoundError ||
      error instanceof MilestoneHireDateMissingError ||
      error instanceof MilestoneBirthDateMissingError
    ) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof MilestoneSpecError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render PDFs right now. Please try again shortly." },
        { status: 503 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "Your milestone card could not be produced.") },
      { status: 500 },
    );
  }
}
