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
import { readsLiveBusinessReview } from "@/lib/sales/unpublished-sales-access";
import { concentrationForAreas, type ReviewSalesDetail } from "@/lib/business-review/concentration";
import { figureWindowLabel, figureWindowPeriods, hasFigures } from "@/lib/business-review/coverage";
import type { FieldLinkFacts } from "@/lib/business-review/field-link";
import {
  defaultSelectionFor,
  narrowSelection,
  needsClosingDetail,
  needsCrmKpis,
  needsFieldLink,
  type PackLevel,
} from "@/lib/business-review/pack/metrics";
import { buildSalesReviewPack, type PackArea, type PackDm } from "@/lib/business-review/pack/model";
import { renderPackPdf } from "@/lib/business-review/pack/pdf";
import { renderPackPptx } from "@/lib/business-review/pack/pptx";
import { renderPackWorkbook } from "@/lib/business-review/pack/workbook";
import { packContentDisposition, packFileName } from "@/lib/business-review/pack/filename";
import { peopleForReviewFilter } from "@/lib/business-review/people-view";
import { applyRepScope, applySeatScope, loadReviewPortalScope } from "@/lib/business-review/portal-scope";
import {
  lineLabelOf,
  resolveReviewFilter,
  REVIEW_LINE_ORDER,
  territoriesInScope,
} from "@/lib/business-review/scope-filter";
import { loadReviewKpiMonths, type ReviewKpiMonth } from "@/lib/business-review/sources/crm-kpis";
import { loadFieldLinkFacts } from "@/lib/business-review/sources/field-link";
import type { ReviewPersonRow } from "@/lib/business-review/sources/roles";
import type { AreaSummary } from "@/lib/business-review/types";
import { OFFICIAL_LINE, type ReviewLine } from "@/lib/business-review/canonical";
import {
  getReviewCompany,
  getReviewDataset,
  loadBusinessReview,
  NoPublishedReviewMonthError,
  loadReviewConcentration,
  REVIEW_LINE_CODES,
} from "@/lib/business-review/service";
import { reviewRepName } from "@/lib/business-review/rep-name";
import { logError } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The three formats, and nothing else.
 *
 * An UNKNOWN format falls back to the workbook rather than refusing: the parameter comes from a
 * link a manager may have been sent, and handing him the spreadsheet is a better answer than an
 * error page. Written as a closed map so a fourth format cannot be added in one place and forgotten
 * in the other.
 */
const CONTENT_TYPE = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

type PackFormat = keyof typeof CONTENT_TYPE;

function packFormat(value: string | null): PackFormat {
  return value === "pdf" || value === "pptx" ? value : "xlsx";
}


export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.role) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const format = packFormat(params.get("format"));

    // The scope, from the session. Never from the request.
    const { scope } = await loadReviewPortalScope({
      hrId: access.hrId ?? null,
      sessionRole: access.role,
    });
    if (scope.kind === "none") {
      return NextResponse.json({ error: scope.reason }, { status: 403 });
    }

    const { review, resolution } = await loadBusinessReview({
      from: params.get("from"),
      to: params.get("to"),
      publishedOnly: !readsLiveBusinessReview(access),
    });
    const coverage = review.coverage;

    // Every line this VIEWER may see: all three for a company scope, exactly one for everyone else.
    const scopeLines: ReviewLine[] = scope.kind === "company" ? [...REVIEW_LINE_ORDER] : [scope.line];

    // Per line, the dataset and the areas the SCOPE allows. The request is still unread at this
    // point, deliberately — see the header of scope-filter.ts.
    const dsByLine = new Map<ReviewLine, ReturnType<typeof getReviewDataset>>();
    const areasByLine: Partial<Record<ReviewLine, AreaSummary[]>> = {};
    for (const line of scopeLines) {
      const ds = getReviewDataset(review, line);
      dsByLine.set(line, ds);
      areasByLine[line] =
        scope.kind === "rep"
          ? applyRepScope(ds, scope.hrId).areas
          : scope.kind === "seats"
            ? applySeatScope(ds, scope.dmSeatIds).areas
            : ds.areas;
    }

    // A rep's pack must read as HIS — his name and his territory, not "Medical Rep · own territory"
    // (owner, 2026-09-30). His display name is not on the session (AccessContext carries no name), so
    // it is taken from the review's own people rows — or, when they hold no row for him, from
    // `employees` (`reviewRepName`) — and set onto the scope the label is built from.
    const labelScope =
      scope.kind === "rep"
        ? {
            ...scope,
            viewerName: await reviewRepName({
              fallback: scope.viewerName,
              hrId: scope.hrId,
              people: dsByLine.get(scope.line)?.people ?? [],
            }),
          }
        : scope;

    // NOW the request is read, and only to REMOVE. Owner, 2026-09-26: "I want everyone to be able to
    // export as he is filtered or as his scope."
    const filter = resolveReviewFilter(labelScope, territoriesInScope(scope, areasByLine), {
      // region and area are read with getAll — the owner exports several regions or areas at once
      // (2026-09-27). resolveReviewFilter still only ever narrows, so a list cannot widen a scope.
      area: params.getAll("area"),
      dm: params.get("dm"),
      line: params.get("line"),
      region: params.getAll("region"),
    });
    if (filter.territories.length === 0) {
      return NextResponse.json(
        { error: "Nothing in your scope matches that filter, so there is no pack to build." },
        { status: 400 },
      );
    }

    const level: PackLevel = filter.level;
    const requested = params.getAll("m");
    const selection = requested.length > 0 ? narrowSelection(requested, level) : defaultSelectionFor(level);

    // Reassemble what survived into what the pack model reads.
    const multiLine = filter.lines.length > 1;
    const keptAreas = new Set(filter.territories.map((t) => `${t.line}:${t.areaCode ?? ""}`));
    const keptSeats = new Set(filter.dmSeatIds);
    const areas: PackArea[] = [];
    const dms: PackDm[] = [];

    for (const line of filter.lines) {
      const ds = dsByLine.get(line);
      if (!ds) continue;
      // The line is named on the row only when the pack spans more than one; a column repeating one
      // value is noise.
      const lineLabel = multiLine ? lineLabelOf(line) : null;

      for (const area of areasByLine[line] ?? []) {
        if (keptAreas.has(`${line}:${area.areaCode ?? ""}`)) areas.push({ ...area, lineLabel });
      }
      // 🔴 A MEDICAL REP'S PACK HOLDS NO DISTRICT ROW. His territory carries his manager's seat, so
      // `keptSeats` names the whole district — and the district row is the WHOLE district's list,
      // marketing and outstation. "Own territory and nothing else" (owner, 2026-09-26) means the rep
      // reads his own AREA, which carries its own figures; the model reads cost off the area when no
      // district row is present. The same rule as the people below, which hold him alone.
      if (scope.kind !== "rep") {
        for (const dm of ds.dms) {
          if (dm.dmSeatId != null && keptSeats.has(dm.dmSeatId)) dms.push({ ...dm, lineLabel });
        }
      }
    }

    // The people, through the one rule the page uses too — a manager who rode in these districts is
    // in them, whether or not he logged a visit of his own (owner, 2026-10-20). See people-view.ts.
    const peopleByLine: Partial<Record<ReviewLine, readonly ReviewPersonRow[]>> = {};
    for (const [line, ds] of dsByLine) peopleByLine[line] = ds.people;
    const people: ReviewPersonRow[] = peopleForReviewFilter({
      companyPeople: getReviewCompany(review).people,
      filter,
      peopleByLine,
      scope,
    });

    // The work beside the money (owner, 2026-10-01). Everything the linked read is told comes from
    // what SURVIVED the scope and the filter above — the reps standing in these areas, these district
    // seats, these areas and lines — never from the request. A medical rep's read names him alone; his
    // marketing requests are every request for his line in his area, whoever raised it (owner,
    // 2026-10-01: "all on his patch") — area AND line, never the area alone.
    const wantsLink = needsFieldLink(selection);
    const has = (id: (typeof selection)[number]) => selection.includes(id);
    const packRepHrIds =
      scope.kind === "rep"
        ? [scope.hrId]
        : [
            ...areas.flatMap((area) => area.repHrIds ?? []),
            ...people.filter((person) => person.role === "Medical Rep").map((person) => person.hrId),
          ];
    const linkRead: Promise<FieldLinkFacts | null> = wantsLink
      ? loadFieldLinkFacts({
          areaCodes: [...new Set(areas.map((area) => area.areaCode).filter((code): code is string => !!code))],
          include: {
            awareness: has("awareness") || has("cost-to-serve") || has("review-summary"),
            directOrders: has("direct-orders") || has("review-summary"),
            marketing: has("requests-return") || has("review-summary"),
          },
          lineNames: filter.lines.map((line) => OFFICIAL_LINE[line]),
          managerSeatIds:
            scope.kind === "rep"
              ? [...new Set(areas.map((area) => area.dmSeatId).filter((seat): seat is string => !!seat))]
              : filter.dmSeatIds,
          months: figureWindowPeriods(coverage),
          repHrIds: packRepHrIds,
        }).catch((error: unknown) => {
          // The rest of the pack is still correct; the linked sections are dropped, never zeroed.
          logError("business-review.pack field link failed", { error });
          return null;
        })
      : Promise.resolve(null);

    // The CRM's own KPIs (owner, 2026-10-01: "add all three"), from the CRM KPIs board itself — one
    // board per month of the figure window, for THIS viewer, cut to the reps the pack survived to.
    const kpiRead: Promise<ReviewKpiMonth[] | null> = needsCrmKpis(selection)
      ? loadReviewKpiMonths({ access, months: figureWindowPeriods(coverage), repHrIds: packRepHrIds }).catch(
          (error: unknown) => {
            // The rest of the pack is still correct; the section is dropped, never zeroed.
            logError("business-review.pack crm kpis failed", { error });
            return null;
          },
        )
      : Promise.resolve(null);

    let concentration = null;
    let brickSales: ReviewSalesDetail[] | null = null;
    if (needsClosingDetail(selection)) {
      try {
        const detail = await loadReviewConcentration({ coverage, viewer: access });
        // Across every surviving line, narrowed to the surviving areas. El Qema is already masked
        // out inside the loader, on the raw rows — never here.
        const rows = filter.lines.flatMap((line) => detail.byLine[REVIEW_LINE_CODES[line]] ?? []);
        concentration = concentrationForAreas(rows, [...new Set(areas.map((area) => area.areaCode))]);
        // The brick table's own cut: each line's rows at THAT line's areas only. An area code is shared
        // by every line's reps, so a code alone would pull another line's sales into this brick.
        brickSales = filter.lines.flatMap((line) =>
          (detail.byLine[REVIEW_LINE_CODES[line]] ?? []).filter((row) =>
            keptAreas.has(`${line}:${row.areaCode.toUpperCase()}`) || keptAreas.has(`${line}:${row.areaCode}`),
          ),
        );
      } catch (error) {
        // The rest of the pack is still correct, so it ships without these sections rather than
        // failing the whole export. The model drops a section with nothing in it.
        logError("business-review.pack concentration failed", { error });
      }
    }
    const fieldLink = await linkRead;
    const crmKpis = await kpiRead;

    const windowLabel = figureWindowLabel(coverage);
    const pack = buildSalesReviewPack({
      areas,
      concentration,
      brickSales,
      coverageNote: coverage.notUploaded?.note ?? `Every figure covers ${windowLabel}.`,
      crmKpis,
      dms,
      fieldLink,
      // The FIGURE window's months, never the requested one's — see figureWindowPeriods.
      months: figureWindowPeriods(coverage),
      people,
      selection,
      subject: {
        level,
        line: filter.lines.length === 1 ? filter.lines[0] : null,
        // The label comes from what was APPLIED, so a pack never names a scope it does not hold.
        title: filter.label,
        windowLabel,
      },
      visitsAvailable: hasFigures(coverage, "visits"),
    });

    const buffer =
      format === "pdf"
        ? await renderPackPdf(pack)
        : format === "pptx"
          ? await renderPackPptx(pack)
          : await renderPackWorkbook(pack);

    // Who pulled which territory over which window, and what was in it — reconstructable, because
    // this hands somebody a performance document about named people.
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${scope.kind}:${level}:${resolution.window.from}:${resolution.window.to}:${format}`,
      entityType: "business_review_pack",
      newValues: {
        // The FILTER as applied, and anything dropped: an audit row has to say which territory was
        // handed over, not merely that somebody exported something.
        dropped: filter.dropped,
        filter: filter.applied,
        format,
        from: resolution.window.from,
        level,
        metrics: selection,
        scope: scope.kind,
        subject: filter.label,
        to: resolution.window.to,
      },
      summary: `Sales Review pack exported (${filter.label}, ${windowLabel}, ${format}).`,
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": packContentDisposition(packFileName(filter.label, windowLabel, format)),
        "Content-Type": CONTENT_TYPE[format],
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof NoPublishedReviewMonthError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    logError("business-review.pack failed", { error });
    return NextResponse.json({ error: "Failed to build the pack" }, { status: 500 });
  }
}
