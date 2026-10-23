import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { type MilestoneCardVariant } from "@/lib/milestones/card";
import { buildMilestonePrintRow, recordMilestonePrint } from "@/lib/milestones/ledger";
import { MilestoneSpecError, milestoneCardFileName, parsePlainDate, todayInCairo, formatPlainDateIso } from "@/lib/milestones/periods";
import { MILESTONE_BATCH_MAX, renderMilestoneCardsPdf } from "@/lib/milestones/render";
import { buildMilestoneCardInput, type BuiltMilestoneCard } from "@/lib/milestones/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VARIANTS = new Set<MilestoneCardVariant>(["trim", "safe", "bleed"]);

/**
 * A whole window of milestone cards in ONE PDF, one card per page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `milestones:export` — Super Admin only, the same publishing right as the single
 * card. A POST, so nothing about a person travels in a URL.
 *
 * 🔴 IT PRINTS FROM THE RECORD ONLY. No handed-in photograph and no framing travel with a batch:
 * one person's face on another person's card is the one mistake on this page that cannot be taken
 * back once it is printed and given to somebody. A picture that is not on the record is the single
 * card's business, one name at a time.
 *
 * 🔴 ONE RATE-LIMIT CHECK, ONE CHROMIUM LAUNCH. The limiter bounds Chromium launches, and a batch
 * is one launch however many cards it holds; the weight is bounded by `MILESTONE_BATCH_MAX` instead.
 *
 * One bad record cannot kill the batch: each card is built inside its own try/catch, the failures
 * are named back in a header, and the PDF carries every card that did build. A batch where NOTHING
 * builds is the only failure.
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
    } | null;
    const rawItems = Array.isArray(body?.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) {
      return Response.json({ error: "Name at least one milestone to print." }, { status: 400 });
    }
    if (rawItems.length > MILESTONE_BATCH_MAX) {
      return Response.json(
        { error: `A batch prints at most ${MILESTONE_BATCH_MAX} cards at once. Narrow the window.` },
        { status: 400 },
      );
    }

    const requested = typeof body?.variant === "string" ? (body.variant as MilestoneCardVariant) : "trim";
    const variant: MilestoneCardVariant = VARIANTS.has(requested) ? requested : "trim";

    // One launch, so one allowance — the same scope the single card spends against.
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:milestones:card",
    });

    // Build every card first, sequentially, so a decode failure on one is skipped rather than
    // sinking the batch. No photograph travels here — the record is the only source.
    const built: BuiltMilestoneCard[] = [];
    const skipped: string[] = [];
    for (const raw of rawItems) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const hrId = typeof item.hrId === "string" ? item.hrId.trim() : "";
      const period = typeof item.period === "string" ? item.period : "1m";
      if (!hrId) {
        skipped.push("(an item with no employee)");
        continue;
      }
      try {
        built.push(
          await buildMilestoneCardInput({
            hrId,
            spec: period,
            on: typeof item.on === "string" ? parsePlainDate(item.on) : null,
            displayName: typeof item.displayName === "string" ? item.displayName : null,
            citation: typeof item.citation === "string" ? item.citation : null,
            withoutPhoto: item.withoutPhoto === true,
          }),
        );
      } catch (cause) {
        skipped.push(clientSafeErrorMessage(cause, `Could not build a card for ${hrId}.`));
      }
    }

    if (built.length === 0) {
      return Response.json(
        { error: "None of those cards could be built.", skipped },
        { status: 422 },
      );
    }

    const rendered = await renderMilestoneCardsPdf(built.map((one) => one.input), variant);

    // Record one print per card that was produced. Never throws (see the ledger); a batch that
    // printed reaches the owner's hands whatever the log does.
    await Promise.all(
      built.map((one) =>
        recordMilestonePrint(
          buildMilestonePrintRow({
            subjectHrId: one.employee.hrId,
            printedName: one.input.displayName,
            hireDate: one.input.hireDate,
            periodSpec: one.periodSpec,
            derivedOn: one.derivedOn,
            milestoneOn: one.on,
            format: "pdf",
            variant,
            fileName: milestoneCardFileName(one.input.displayName, one.periodSpec, one.on),
            photoSource: one.input.photoDataUri ? "record" : "none",
            actorLoginId: access.loginId ?? null,
            actorHrId: access.hrId ?? null,
            actorName: null,
          }),
        ),
      ),
    );

    const name = `milestones-${built.length}-${formatPlainDateIso(todayInCairo())}.pdf`;
    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": "application/pdf",
        // Stated, not promised: how many cards are in the file, and how many were skipped.
        "X-Milestone-Cards": String(built.length),
        "X-Milestone-Skipped": String(skipped.length),
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Milestone cards are available to the system administrator only." },
        { status: 403 },
      );
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof MilestoneSpecError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render PDFs right now." },
        { status: 503 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The milestone cards could not be produced.") },
      { status: 500 },
    );
  }
}
