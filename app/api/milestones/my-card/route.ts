import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseEmployeePortalMilestones } from "@/lib/employee-portal/navigation";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { milestoneCardHtml, type MilestoneCardVariant } from "@/lib/milestones/card";
import {
  MilestoneSpecError,
  formatPlainDateIso,
  milestoneCardFileName,
  parsePlainDate,
  type PlainDate,
} from "@/lib/milestones/periods";
import { issueShareCardToken, shareCardPublicUrl } from "@/lib/share/share-card-token";
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

/**
 * The rep's OWN milestone card, with the same photo control the admin has — but only ever for
 * himself.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY IS THAT THE SUBJECT IS ALWAYS THE CALLER. The company-wide card route
 * (/api/milestones/card) is Super-Admin-only because it prints ANY named employee's photograph. This
 * route reads `access.hrId` and builds the card for THAT id and no other — a `hrId` in the body is
 * ignored, so a rep can never point it at a colleague. It needs no `milestones` grant; the audience
 * is the one the sidebar offers (canUseEmployeePortalMilestones), and it never writes the shared
 * print ledger (a rep's own keepsake is not the company congratulating him).
 *
 * Four shapes, exactly like the admin route but self-scoped:
 *   `format: "pdf"`   — the sheet, ready to print.
 *   `format: "png"`   — the same sheet as a picture, for sending rather than printing.
 *   `format: "html"`  — the on-screen preview (NOT the print path).
 *   `format: "focus"` — where the portrait window sits, so the drag box opens on the right framing.
 * `photoFocus` moves the picture inside its fixed frame; `photoUpload` hands in a different picture
 * for this one card (never written back to the record); `withoutPhoto` prints the monogram plate.
 */
const VARIANTS = new Set<MilestoneCardVariant>(["trim", "safe", "bleed"]);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** A framing off the wire, clamped; anything malformed is `null` ("you decide" — the default crop). */
function readFocus(value: unknown): { x: number; y: number; zoom: number } | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, zoom } = value as { x?: unknown; y?: unknown; zoom?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    zoom: typeof zoom === "number" && Number.isFinite(zoom) ? Math.min(4, Math.max(1, zoom)) : 1,
  };
}

/** A `data:image/...;base64,` upload off the wire, or null. The cap is the point, not the validation. */
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
    const withoutPhoto = body?.withoutPhoto === true;
    const requested = body && typeof body.variant === "string" ? (body.variant as MilestoneCardVariant) : "trim";
    const variant: MilestoneCardVariant = VARIANTS.has(requested) ? requested : "trim";
    const format =
      body?.format === "html"
        ? "html"
        : body?.format === "png"
          ? "png"
          : body?.format === "focus"
            ? "focus"
            : body?.format === "share-link"
              ? "share-link"
              : "pdf";
    const photoUpload = readUpload(body?.photoUpload);

    // The subject is the caller, always — never a hrId off the wire.
    const hrId = access.hrId;

    if (format === "focus") {
      const focus = await milestonePhotoFocus(hrId, photoUpload);
      return Response.json({ focus }, { headers: { "Cache-Control": "no-store" } });
    }

    const built = await buildMilestoneCardInput({
      hrId,
      spec,
      on,
      withoutPhoto,
      photoFocus: readFocus(body?.photoFocus),
      photoUpload,
    });

    // A public, expiring link to THIS card, so LinkedIn and Facebook can scrape the actual picture.
    // Minted from the caller's own resolved spec + date — never an hr id off the wire. No Chromium
    // runs here; the picture is rendered only when the link itself is opened.
    if (format === "share-link") {
      const token = issueShareCardToken({
        kind: "milestone",
        hrId,
        spec: built.periodSpec,
        on: formatPlainDateIso(built.on),
      });
      return Response.json({ shareUrl: shareCardPublicUrl(token) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (format === "html") {
      const html = milestoneCardHtml(built.input, { variant, autoLayout: true });
      return new Response(html, {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Rate-limited on both rendered paths: Chromium is not cheap, and the picture is the pricier one.
    await assertExportRateLimit({
      actor: access.loginId ?? hrId,
      request,
      scope: "export:milestones:my-card",
    });

    if (format === "png") {
      const picture = await renderMilestoneCardImage(built.input, variant);
      const pictureName = milestoneCardFileName(built.input.displayName, built.periodSpec, built.on, "png");
      return new Response(new Uint8Array(picture.png), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${pictureName}"`,
          "Content-Type": "image/png",
        },
      });
    }

    const rendered = await renderMilestoneCard(built.input, variant);
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
        { error: "This server cannot render PDFs right now. The preview is unaffected." },
        { status: 503 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "Your milestone card could not be produced.") },
      { status: 500 },
    );
  }
}
