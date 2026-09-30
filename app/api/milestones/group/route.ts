import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { MilestoneGroupOccasionError, milestoneGroupFileName } from "@/lib/milestones/group";
import { milestoneGroupCardHtml, type MilestoneGroupCardVariant } from "@/lib/milestones/group-card";
import { buildMilestonePrintRow, recordMilestonePrint } from "@/lib/milestones/ledger";
import { MilestoneSpecError, parsePlainDate } from "@/lib/milestones/periods";
import { renderMilestoneGroupCard, renderMilestoneGroupCardImage } from "@/lib/milestones/render";
import {
  buildMilestoneGroupCardInput,
  type MilestoneGroupCardItem,
} from "@/lib/milestones/service";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VARIANTS = new Set<MilestoneGroupCardVariant>(["trim", "safe", "bleed"]);

/**
 * ONE picture with everybody on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT THE BATCH. `/api/milestones/batch` prints a window as one PDF, one card per page —
 * a thing to print and hand out, and useless as something to send. The owner asked for the other
 * thing (2026-09-30): "I have five employees that have the same milestone in one day … I want to
 * make a photo that has them all." So this route renders a SINGLE landscape sheet carrying every
 * face, and its first-class output is the PNG.
 *
 * WHO MAY CALL IT. `milestones:export` — Super Admin only, the same publishing right as the single
 * card and the batch. It carries several named employees' PHOTOGRAPHS out of the private
 * `employee-photos` bucket onto one sheet built to be shared, which is a publishing act several
 * times over. A POST, so nothing about anybody travels in a URL or lands in an access log.
 *
 * 🔴 IT PRINTS FROM THE RECORD ONLY. No handed-in photograph and no framing travel here, exactly as
 * with the batch: one person's face beside another person's name is the one mistake on this page
 * that cannot be taken back once the picture has been sent. A better photograph for one person is
 * the single card's business, one name at a time.
 *
 * 🔴 ONE BAD ROW FAILS THE WHOLE PICTURE, DELIBERATELY. The batch skips a record it cannot build and
 * prints the rest — a missing page is obvious. A group picture is asked for so that everybody is ON
 * it, so a silently dropped person would be a picture that looks complete and is not. The service
 * refuses and names who; that message is returned as-is.
 *
 * Three shapes come back:
 *   `format: "png"`  — the picture. What this route exists for.
 *   `format: "pdf"`  — the same artwork as a one-page sheet, for a printer.
 *   `format: "html"` — the same artwork for an on-screen preview, laid out by the browser showing
 *                      it. NOT the print path, and outside the export rate limit because it is read
 *                      while choosing names rather than while exporting.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "milestones", "export");

    const body = (await request.json().catch(() => null)) as {
      items?: unknown;
      variant?: unknown;
      format?: unknown;
      citation?: unknown;
    } | null;

    const rawItems = Array.isArray(body?.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) {
      return Response.json({ error: "Tick the people the picture is for." }, { status: 400 });
    }

    const items: MilestoneGroupCardItem[] = [];
    for (const raw of rawItems) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const hrId = typeof item.hrId === "string" ? item.hrId.trim() : "";
      if (!hrId) {
        return Response.json(
          { error: "One of the ticked rows names no employee, so the picture would be short a face." },
          { status: 400 },
        );
      }
      items.push({
        hrId,
        spec: typeof item.period === "string" ? item.period : "1m",
        on: typeof item.on === "string" ? parsePlainDate(item.on) : null,
        displayName: typeof item.displayName === "string" ? item.displayName : null,
        withoutPhoto: item.withoutPhoto === true,
      });
    }

    const requested = typeof body?.variant === "string" ? (body.variant as MilestoneGroupCardVariant) : "trim";
    const variant: MilestoneGroupCardVariant = VARIANTS.has(requested) ? requested : "trim";
    const format = body?.format === "pdf" ? "pdf" : body?.format === "html" ? "html" : "png";

    const built = await buildMilestoneGroupCardInput({
      items,
      citation: typeof body?.citation === "string" ? body.citation : null,
    });

    if (format === "html") {
      // The preview lays itself out, because nothing is standing by to evaluate the layout pass for
      // it the way the print paths do.
      const html = milestoneGroupCardHtml(built.input, { variant, autoLayout: true });
      return new Response(html, {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // One picture, one Chromium launch, one allowance — the same scope the single card spends
    // against, because it is the same engine doing the same work.
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:milestones:card",
    });

    const name = milestoneGroupFileName(
      built.occasion,
      built.dates,
      built.members.length,
      format === "pdf" ? "pdf" : "png",
    );

    const rendered =
      format === "pdf"
        ? await renderMilestoneGroupCard(built.input, variant)
        : await renderMilestoneGroupCardImage(built.input, variant);

    // Logged AFTER the render succeeds, one row per face — so the due list's "Printed" mark appears
    // on every row that is really on the picture, and a Chromium failure above leaves no phantom
    // rows. `derivedOn` is the ARITHMETIC date, never a date typed over a row (see the ledger).
    // Never throws; a picture that rendered reaches the owner's hands whatever the log does.
    await Promise.all(
      built.members.map((member) =>
        recordMilestonePrint(
          buildMilestonePrintRow({
            subjectHrId: member.employee.hrId,
            printedName: member.input.displayName,
            hireDate: member.input.hireDate,
            periodSpec: member.periodSpec,
            derivedOn: member.derivedOn,
            milestoneOn: member.on,
            format: format === "pdf" ? "pdf" : "png",
            variant,
            fileName: name,
            photoSource: member.input.photoDataUri ? "record" : "none",
            actorLoginId: access.loginId ?? null,
            actorHrId: access.hrId ?? null,
            actorName: null,
          }),
        ),
      ),
    );

    if ("png" in rendered) {
      return new Response(new Uint8Array(rendered.png), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Content-Type": "image/png",
          // Stated, not promised: what is really in the file that was just sent.
          "X-Milestone-Faces": String(built.members.length),
          "X-Milestone-Pixels": `${rendered.pixels.width}x${rendered.pixels.height}`,
        },
      });
    }

    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": "application/pdf",
        "X-Milestone-Faces": String(built.members.length),
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Milestone pictures are available to the system administrator only." },
        { status: 403 },
      );
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    // A mixed tick list, too few or too many faces, or a record that cannot be built: every one of
    // these is something the person choosing the names can fix, and the message says what to do.
    if (error instanceof MilestoneGroupOccasionError || error instanceof MilestoneSpecError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render pictures right now. The preview is unaffected." },
        { status: 503 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The group picture could not be produced.") },
      { status: 500 },
    );
  }
}
