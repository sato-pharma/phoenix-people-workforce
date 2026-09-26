// The Sales Review pack — PDF or XLSX, for whatever scope the CALLER ACTUALLY HOLDS.
//
// Owner, 2026-09-26: any manager ticks his metrics, presses export, and gets a corporate pack
// instead of building slides by hand.
//
// 🔴 THE SCOPE IS RESOLVED HERE, FROM THE SESSION, AND NEVER READ FROM THE REQUEST. The page hiding
// a button is UX and never the security boundary, and a `?line=` or `?seat=` parameter would let
// anyone export any district by editing a URL. The only things this route takes from the caller are
// the window, the format and the ticked metrics — and the metrics are narrowed to what the resolved
// level can answer, so a link built at company level exports a district's pack when a district
// manager opens it, rather than the company's.
//
// The file is built from the SAME data the page renders, through the same pack model both renderers
// read. There is no second opinion about a figure anywhere in this path.

import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { concentrationForAreas } from "@/lib/business-review/concentration";
import { figureWindowLabel, hasFigures } from "@/lib/business-review/coverage";
import {
  defaultSelectionFor,
  narrowSelection,
  needsClosingDetail,
  type PackLevel,
} from "@/lib/business-review/pack/metrics";
import { buildSalesReviewPack } from "@/lib/business-review/pack/model";
import { renderPackPdf } from "@/lib/business-review/pack/pdf";
import { renderPackWorkbook } from "@/lib/business-review/pack/workbook";
import { applyRepScope, applySeatScope, loadReviewPortalScope } from "@/lib/business-review/portal-scope";
import {
  getReviewDataset,
  loadBusinessReview,
  loadReviewConcentration,
  REVIEW_LINE_CODES,
} from "@/lib/business-review/service";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A filename a human can find again in a downloads folder, with no characters Windows refuses. */
function fileName(subject: string, windowLabel: string, extension: string): string {
  const safe = `${subject} ${windowLabel}`.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return `Sales Review — ${safe}.${extension}`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.role) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const format = params.get("format") === "pdf" ? "pdf" : "xlsx";

    // The scope, from the session. Never from the request.
    const { scope } = await loadReviewPortalScope({
      hrId: access.hrId ?? null,
      sessionRole: access.role,
    });
    if (scope.kind === "none") {
      return NextResponse.json({ error: scope.reason }, { status: 403 });
    }
    // Company and whole-line packs are not built yet: the page renders those views but the pack
    // model's sections are written for a territory. Refusing in words beats exporting a file whose
    // sections are silently empty.
    if (scope.kind !== "seats" && scope.kind !== "rep") {
      return NextResponse.json(
        { error: "A company-wide or whole-line pack is not available yet. Open a district to export one." },
        { status: 400 },
      );
    }

    const { review, resolution } = await loadBusinessReview({
      from: params.get("from"),
      to: params.get("to"),
    });
    const coverage = review.coverage;
    const ds = getReviewDataset(review, scope.line);
    const level: PackLevel = scope.kind === "rep" ? "rep" : "district";

    const requested = params.getAll("m");
    const selection = requested.length > 0 ? narrowSelection(requested, level) : defaultSelectionFor(level);

    const scoped =
      scope.kind === "rep"
        ? { areas: applyRepScope(ds, scope.hrId).areas, dms: [] }
        : applySeatScope(ds, scope.dmSeatIds);

    let concentration = null;
    if (needsClosingDetail(selection)) {
      try {
        const detail = await loadReviewConcentration({ coverage, viewer: access });
        concentration = concentrationForAreas(
          detail.byLine[REVIEW_LINE_CODES[scope.line]] ?? [],
          scoped.areas.map((area) => area.areaCode),
        );
      } catch (error) {
        // The rest of the pack is still correct, so it ships without these sections rather than
        // failing the whole export. The model drops a section with nothing in it.
        logError("business-review.pack concentration failed", { error });
      }
    }

    const people =
      scope.kind === "rep"
        ? ds.people.filter((person) => person.hrId.toUpperCase() === scope.hrId)
        : ds.people.filter((person) => person.dmSeatId != null && new Set(scope.dmSeatIds).has(person.dmSeatId));

    const windowLabel = figureWindowLabel(coverage);
    const pack = buildSalesReviewPack({
      areas: scoped.areas,
      concentration,
      coverageNote: coverage.notUploaded?.note ?? `Every figure covers ${windowLabel}.`,
      dms: scoped.dms,
      months: ds.meta.months,
      people,
      selection,
      subject: { level, line: scope.line, title: scope.label, windowLabel },
      visitsAvailable: hasFigures(coverage, "visits"),
    });

    const buffer = format === "pdf" ? await renderPackPdf(pack) : await renderPackWorkbook(pack);

    // Who pulled which territory over which window, and what was in it — reconstructable, because
    // this hands somebody a performance document about named people.
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${scope.kind}:${scope.line}:${resolution.window.from}:${resolution.window.to}:${format}`,
      entityType: "business_review_pack",
      newValues: {
        format,
        from: resolution.window.from,
        metrics: selection,
        scope: scope.kind,
        to: resolution.window.to,
      },
      summary: `Sales Review pack exported (${scope.label}, ${windowLabel}, ${format}).`,
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName(scope.label, windowLabel, format)}"`,
        "Content-Type":
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      status: 200,
    });
  } catch (error) {
    logError("business-review.pack failed", { error });
    return NextResponse.json({ error: "Failed to build the pack" }, { status: 500 });
  }
}
