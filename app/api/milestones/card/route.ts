import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { milestoneCardHtml, type MilestoneCardVariant } from "@/lib/milestones/card";
import {
  MilestoneSpecError,
  milestoneCardFileName,
  parsePlainDate,
  type PlainDate,
} from "@/lib/milestones/periods";
import { buildMilestonePrintRow, recordMilestonePrint } from "@/lib/milestones/ledger";
import { renderMilestoneCard, renderMilestoneCardImage } from "@/lib/milestones/render";
import {
  MilestoneBirthDateMissingError,
  MilestoneEmployeeNotFoundError,
  MilestoneHireDateMissingError,
  buildMilestoneCardInput,
  milestonePhotoFocus,
} from "@/lib/milestones/service";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VARIANTS = new Set<MilestoneCardVariant>(["trim", "safe", "bleed"]);

/**
 * The framing, off the wire.
 *
 * Anything that is not a pair of real numbers is `null`, which means "you decide" — a malformed
 * focus must fall back to the crop the card has always printed, never to a corner. The clamp is
 * here as well as in the portrait module because this is the edge the value arrives at.
 */
function readFocus(value: unknown): { x: number; y: number; zoom: number } | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, zoom } = value as { x?: unknown; y?: unknown; zoom?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    // A missing or nonsense zoom is 1 — exactly cover, the crop this card has always printed.
    zoom: typeof zoom === "number" && Number.isFinite(zoom) ? Math.min(4, Math.max(1, zoom)) : 1,
  };
}

/**
 * A photograph handed in for one card, off the wire.
 *
 * It arrives as a `data:image/...;base64,` URI, because that is what a browser's FileReader hands
 * back and it carries its own type. Anything else is `null` — the card then uses the HR record's
 * photograph, or the monogram plate.
 *
 * 🔴 THE CAP IS THE POINT, NOT THE VALIDATION. A phone photograph is a few megabytes; the limit is
 * generous enough that nobody meets it by accident and small enough that a POST cannot be used to
 * push arbitrary weight through Chromium. sharp decides whether the bytes are really an image —
 * this only refuses to carry something that is obviously not worth handing it.
 */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function readUpload(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return null;
  const comma = value.indexOf(",");
  if (comma < 0 || !value.slice(0, comma).includes(";base64")) return null;
  try {
    const bytes = Buffer.from(value.slice(comma + 1), "base64");
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

/**
 * One milestone card.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `milestones:export` — Super Admin only. The gate is here and not in the
 * sidebar. It matters more than usual on this route: the card carries a named employee's
 * PHOTOGRAPH, fetched out of the private `employee-photos` bucket, onto a sheet built to be
 * printed and handed around. That is a publishing right.
 *
 * A POST, so nothing about a person travels in a URL somebody can forward (and nothing lands in an
 * access log) — and so a handed-in photograph has somewhere to travel at all. Four shapes come
 * back:
 *
 *   `format: "pdf"`   — the sheet, ready to print. `variant` picks trim, safe or bleed.
 *   `format: "png"`   — the same sheet as a picture, at print resolution, for sending rather than
 *                       printing. Chromium renders it, so it is a print-path output like the PDF.
 *   `format: "html"`  — the same artwork for an on-screen preview, laid out by the browser it is
 *                       shown in. It is NOT the print path: never save one and call it the card.
 *   `format: "focus"` — where the portrait window sits, and nothing else. It answers one question
 *                       for the box somebody drags the photograph in: what framing is the card
 *                       printing right now, so the box can open on it instead of jumping the
 *                       moment it is touched. It renders NOTHING, so it is deliberately outside
 *                       the export rate limit — it is read while picking a name, not while
 *                       exporting — but it is behind the same permission, because knowing a
 *                       person has a usable photograph is still knowing something about them.
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
    const format =
      body.format === "html"
        ? "html"
        : body.format === "png"
          ? "png"
          : body.format === "focus"
            ? "focus"
            : "pdf";

    // Answered before the card is assembled, because assembling one would run the whole portrait
    // treatment to arrive at a pair of numbers the crop alone already knows.
    const photoUpload = readUpload(body.photoUpload);

    if (format === "focus") {
      const focus = await milestonePhotoFocus(body.hrId, photoUpload);
      return Response.json({ focus }, { headers: { "Cache-Control": "no-store" } });
    }

    const built = await buildMilestoneCardInput({
      hrId: body.hrId,
      spec,
      on,
      displayName,
      citation,
      withoutPhoto,
      photoFocus: readFocus(body.photoFocus),
      photoUpload,
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

    // Logged AFTER the render succeeds — the log records a card that was actually produced, so a
    // Chromium failure below leaves no phantom row. Never throws (see the ledger); a card that
    // printed reaches the owner's hands whatever the log does.
    //
    // 🔴 `derivedOn` is the ARITHMETIC date, not `built.on`. When the owner typed a date over the
    // card, `built.on` is that typed date and rides in `milestoneOn`; identity stays the arithmetic,
    // so one keystroke cannot mint a second occasion the reminder starts over.
    const recordPrint = (recordedFormat: "pdf" | "png", fileName: string) =>
      recordMilestonePrint(
        buildMilestonePrintRow({
          subjectHrId: built.employee.hrId,
          printedName: built.input.displayName,
          hireDate: built.input.hireDate,
          periodSpec: built.periodSpec,
          derivedOn: built.derivedOn,
          milestoneOn: built.on,
          format: recordedFormat,
          variant,
          fileName,
          photoSource: photoUpload ? "upload" : built.input.photoDataUri ? "record" : "none",
          actorLoginId: access.loginId ?? null,
          actorHrId: access.hrId ?? null,
          actorName: null,
        }),
      );

    if (format === "png") {
      const picture = await renderMilestoneCardImage(built.input, variant);
      const pictureName = milestoneCardFileName(built.input.displayName, built.periodSpec, built.on, "png");
      await recordPrint("png", pictureName);
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
    const name = milestoneCardFileName(built.input.displayName, built.periodSpec, built.on);
    await recordPrint("pdf", name);

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
        { error: "Milestone cards are available to the system administrator only." },
        { status: 403 },
      );
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
