/**
 * GET /api/admin/field-activity/pdf?hrId=&from=&to= — the same report, as a premium-identity document.
 *
 * Same scope gate, same loader, same model as the screen — the PDF is a second RENDERING of one
 * report, never a second query. That is what keeps the paper and the page saying the same thing
 * when a rule changes.
 */

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canOpenSubject, resolveFieldActivityAccess } from "@/lib/field-activity/access";
import { buildFieldActivityDocument, type FieldActivityDayMap } from "@/lib/field-activity/document";
import { fetchBasemap, fitZoom, renderRouteSvg, stopsToMapPoints } from "@/lib/field-activity/map";
import { resolvePeriod } from "@/lib/field-activity/period";
import { phoenixDetailViewer } from "@/lib/crm/phoenix-visit-detail";
import { loadFieldActivityReport } from "@/lib/field-activity/report";
import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { stampPremiumPageNumbers } from "@/lib/hiring-pack/paper-pdf";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A quarter of field days is a few dozen pages, each with a basemap fetch behind it.
export const maxDuration = 120;

const MAP_WIDTH = 1500;
const MAP_HEIGHT = 640;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // The coarse gate, stated where a reviewer looks for it. `resolveFieldActivityAccess` checks
    // the same grant itself and then narrows to the viewer's org-tree scope — but server-side
    // access control is THE security boundary in this repo, and a boundary a route handler does
    // not name is one the next edit can quietly move.
    await assertPermission(access, "double_visit_analytics", "read");
    const resolved = await resolveFieldActivityAccess(access);
    if (!resolved) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }

    const url = new URL(request.url);
    const subjectHrId = (url.searchParams.get("hrId") ?? "").trim();
    if (!subjectHrId || !canOpenSubject(resolved, subjectHrId)) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }
    const period = resolvePeriod(url.searchParams.get("from"), url.searchParams.get("to"));
    if (!period.ok) {
      return NextResponse.json({ error: "bad_period", message: period.reason, success: false }, { status: 400 });
    }

    const report = await loadFieldActivityReport({
      fromIso: period.fromIso,
      panels: resolved.panels,
      subjectHrId,
      toIso: period.toIso,
      // The same tier the screen gives this reader. A PDF is a document somebody keeps and forwards, so
      // it is the LAST place to widen a sight — it must print exactly what its reader could see.
      viewer: phoenixDetailViewer(resolved.role, resolved.viewerHrId),
    });
    if (!report) {
      return NextResponse.json({ error: "not_found", success: false }, { status: 404 });
    }

    const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY ?? null;
    const maps: FieldActivityDayMap[] = [];
    for (const day of report.days) {
      if (day.stops.length === 0) continue;
      // Pulled out of the optional chain deliberately: three separate narrowings inside one
      // condition is exactly where a null reaches `toFixed` later and nobody notices.
      const trip = day.trip;
      const captureLat = trip?.capturedLat ?? null;
      const captureLon = trip?.capturedLon ?? null;
      const captureAt = trip?.capturedAt ?? null;
      const capture =
        captureLat != null && captureLon != null && captureAt
          ? { lat: captureLat, lon: captureLon, label: `Own GPS ${captureAt.slice(11, 16)}` }
          : null;
      const points = stopsToMapPoints(day.stops, capture);
      const zoom = fitZoom(points, MAP_WIDTH, MAP_HEIGHT);
      const centreLat = (Math.max(...points.map((p) => p.lat)) + Math.min(...points.map((p) => p.lat))) / 2;
      const centreLon = (Math.max(...points.map((p) => p.lon)) + Math.min(...points.map((p) => p.lon))) / 2;
      const basemap = await fetchBasemap({
        apiKey,
        centre: { lat: centreLat, lon: centreLon },
        height: MAP_HEIGHT,
        width: MAP_WIDTH,
        zoom,
      });
      maps.push({
        caption:
          `The ${day.stops.length} stop${day.stops.length === 1 ? "" : "s"} they were tagged on, numbered in check-in order.` +
          (capture ? " The crosshair is their own phone fix when they opened the outstation claim." : "") +
          " Stops sharing a building are fanned out on leader lines back to the exact fix.",
        dateIso: day.dateIso,
        svg: renderRouteSvg({ basemap, height: MAP_HEIGHT, points, width: MAP_WIDTH, zoom }),
      });
    }

    const generatedOn = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      timeZone: "Africa/Cairo",
      year: "numeric",
    }).format(new Date());

    // `setContent` gives the page no origin, so the premium chrome's `/brand/...` images are inlined
    // first. A file that cannot be read is not fatal: this report is read and forwarded, not filed, and
    // the mark falls back to its alt text.
    const { html } = inlineLocalAssets(buildFieldActivityDocument({ generatedOn, maps, report }));

    const pdf = await withChromiumPage(async (page) => {
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
      // Chromium applies `@media screen` by default even when producing a PDF; the paper rules live
      // under print.
      await page.emulateMediaType("print");
      // The "N / M" is written into the premium foot after layout, once Chromium has counted the
      // pages, and the foot's diamond steps aside for it (the same two steps as `renderHiringPaperPdf`).
      // The old in-page footer counted its own pages by hand and got a day that spills onto a second
      // page wrong.
      await page.evaluate("document.documentElement.setAttribute('data-pm-numbered', '')");
      const bytes = await page.pdf({
        format: "A4",
        landscape: true,
        margin: { bottom: "0", left: "0", right: "0", top: "0" },
        preferCSSPageSize: true,
        // The premium frame, watermark and zebra row are CSS backgrounds — without this the look is
        // lost on paper.
        printBackground: true,
        timeout: 60_000,
      });
      return Buffer.from(await stampPremiumPageNumbers(bytes));
    });

    const slug = report.subject.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const filename = `${slug}-Field-Activity-${period.fromIso}-to-${period.toIso}.pdf`;
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", success: false }, { status: 403 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        { error: "pdf_unavailable", message: "This runtime cannot produce a PDF. The report is still on screen.", success: false },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "field_activity_pdf_failed", message: clientSafeErrorMessage(error, "Unknown error"), success: false },
      { status: 500 },
    );
  }
}
