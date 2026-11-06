/**
 * GET /api/admin/outstation/[id]/pdf — the trip review, as a house document.
 *
 * Owner request 2026-09-28: "extract this page as it is as a PDF". A second RENDERING of the review
 * panel, never a second reading of the rules: the same gate as the detail view, the same request
 * loader, the same live CRM read and the same freshness check the panel runs. The document builder
 * (`review-document.ts`) is pure; this route only gathers what it needs and prints it.
 *
 * Everything the document shows is fetched HERE, server-side, and handed in as data URIs — the map,
 * both photos and the mark. So the printed file carries no signed storage URL (a signed URL is a
 * key to the image) and no Google API key, and Chromium needs no network to lay it out.
 */

import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { systemDeployment } from "@/config/system-settings";
import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { classifyPhotoFrame, photoFrameMeasurementScript } from "@/lib/outstation/photo-frame";
import { parseOutstationRequestId } from "@/lib/outstation/request-id";
import {
  buildOutstationReviewDocument,
  outstationReviewFooter,
  type ReviewDocumentPhoto,
  type ReviewDocumentWorkload,
} from "@/lib/outstation/review-document";
import {
  buildRouteStaticMapUrl,
  fetchRouteStaticMap,
  renderRouteDiagram,
} from "@/lib/outstation/review-map-image";
import { renderRouteStreetMap } from "@/lib/outstation/review-map-render";
import { getOutstationRequestById } from "@/lib/outstation/service";
import { approverTripPhotos } from "@/lib/outstation/trip-evidence-photos";
import { resolveWorkloadFreshness } from "@/lib/outstation/workload-freshness";
import { type ChromiumPage, ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two photo fetches, one map fetch, one CRM read and a Chromium render.
export const maxDuration = 90;

/** A photo larger than this is left out with a sentence rather than bloating the file. */
const PHOTO_BYTE_LIMIT = 8 * 1024 * 1024;


async function imageDataUri(url: string | null): Promise<{ image: string | null; problem: string | null }> {
  if (!url) return { image: null, problem: null };
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return { image: null, problem: "The photo is on file but could not be opened for printing." };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > PHOTO_BYTE_LIMIT) {
      return { image: null, problem: "The photo is too large to print; open it on the review screen." };
    }
    const type = response.headers.get("content-type") || "image/jpeg";
    return { image: `data:${type};base64,${bytes.toString("base64")}`, problem: null };
  } catch {
    return { image: null, problem: "The photo is on file but could not be opened for printing." };
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Employee";
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    // The same gate as GET /api/admin/outstation/[id]: whoever may open the review may print it,
    // and nobody else. Named here, in the handler, because that is where a reviewer looks for it.
    await assertOutstationAdminAccess(access, "approve");

    const { id: rawId } = await params;
    const id = parseOutstationRequestId(rawId);
    if (id === null) {
      return NextResponse.json({ error: "invalid_outstation_id", message: "Request id is invalid." }, { status: 400 });
    }

    const outstation = await getOutstationRequestById(id, { includeCarEvidenceSignedUrl: true });
    if (!outstation) {
      return NextResponse.json({ error: "not_found", message: "That outstation request was not found." }, { status: 404 });
    }

    // ── The route map ──────────────────────────────────────────────────────────────────────────
    const mapPlan = buildRouteStaticMapUrl({
      apiKey: process.env.GOOGLE_MAPS_SERVER_KEY ?? null,
      destination: { lat: outstation.capturedLatitude, lng: outstation.capturedLongitude },
      polyline: outstation.routePolyline,
      residence: { lat: outstation.residenceLatitude, lng: outstation.residenceLongitude },
    });
    // THE REAL STREET MAP FIRST, drawn by the Maps JavaScript API inside this same Chromium — the
    // API the review screen itself uses. Measured 2026-09-29: the Maps STATIC API answers 403 "not
    // activated on your API project" for both keys, so the URL route below can only ever be a
    // fallback until that product is enabled; the JS API is enabled and draws today.
    //
    // `mapPlan` still decides WHAT may be plotted: it is where the unresolved-home guard lives, and
    // every renderer takes its answer rather than re-deciding. A placeholder is never a place.
    const streetMap = await renderRouteStreetMap({
      apiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? process.env.GOOGLE_MAPS_SERVER_KEY ?? null,
      destination: mapPlan.destination,
      home: mapPlan.home,
      // The referrer the browser key is restricted to — the app is asking its own origin.
      origin: systemDeployment.productionUrl,
      polyline: mapPlan.home ? outstation.routePolyline : null,
    });
    const staticMap = streetMap ? null : await fetchRouteStaticMap(mapPlan);
    const diagram =
      streetMap || staticMap
        ? null
        : renderRouteDiagram({
            destination: { lat: outstation.capturedLatitude, lng: outstation.capturedLongitude },
            polyline: outstation.routePolyline,
            residence: { lat: outstation.residenceLatitude, lng: outstation.residenceLongitude },
          });
    const map = streetMap
      ? { caption: mapPlan.caption, image: streetMap.image }
      : staticMap
        ? { caption: mapPlan.caption, image: staticMap }
        : diagram ?? { caption: mapPlan.caption, image: null };

    // ── The two photos, exactly as the panel lists them ────────────────────────────────────────
    const photos: ReviewDocumentPhoto[] = [];
    for (const photo of approverTripPhotos(outstation)) {
      const { image, problem } = await imageDataUri(photo.url);
      const note = [problem ?? photo.missingNote, photo.sourceNote, photo.review, photo.gpsMissingReason]
        .filter((line): line is string => Boolean(line && line.trim()))
        .join(" ");
      photos.push({
        capturedAtLabel: photo.capturedAt ? cairoDateTime(photo.capturedAt) : null,
        // Filled after Chromium has decoded the picture — see the second pass below.
        frameNote: null,
        image,
        label: photo.label,
        locationLabel: photo.locationLabel,
        note: note || null,
      });
    }

    // ── The live CRM read — the same one the panel makes ───────────────────────────────────────
    let workload: ReviewDocumentWorkload = { available: false };
    if (outstation.employeeHrId) {
      try {
        const live = await getRepTripVisitWorkload({
          hrId: outstation.employeeHrId,
          tripEndDate: outstation.tripEndDate,
          tripStartDate: outstation.tripStartDate,
        });
        const freshness = resolveWorkloadFreshness({
          liveAmWorkload: live.amWorkload,
          liveMatchStatus: live.matchStatus,
          liveMeetingDays: live.meetingDays ?? 0,
          livePharmacyWorkload: live.pharmacyWorkload ?? 0,
          livePmWorkload: live.pmWorkload,
          storedAmWorkload: outstation.amWorkload ?? 0,
          storedMatchedAt: outstation.workloadMatchedAt ?? null,
          storedMatchStatus: outstation.workloadMatchStatus ?? null,
          storedPharmacyWorkload: outstation.pharmacyWorkload ?? null,
          storedPmWorkload: outstation.pmWorkload ?? 0,
        });
        workload = {
          available: true,
          days: live.dateBreakdown.map((day) => ({
            am: day.am,
            campaign: day.campaign,
            date: day.date,
            pharmacies: day.pharmacies,
            // Display only: a Phoenix CRM day logs no pharmacy visit, so the document words it.
            ...(day.phoenix ? { phoenix: day.phoenix } : {}),
            pm: day.pm,
            regular: day.regular,
          })),
          freshnessHeadline: freshness.verdict === "stale" ? freshness.headline : null,
          matchStatus: live.matchStatus,
          live: {
            am: live.amWorkload,
            campaign: live.campaignVisits,
            pharmacies: live.pharmacyWorkload ?? 0,
            ...(live.phoenixWorkload ? { phoenix: live.phoenixWorkload } : {}),
            pm: live.pmWorkload,
            regular: live.regularVisits,
          },
        };
      } catch (error) {
        // An unanswered question, printed as one — never a zero.
        console.warn("[outstation-review-pdf] live workload read failed", error);
      }
    }

    const generatedOn = cairoDateTime(new Date().toISOString());
    const html = buildOutstationReviewDocument({
      generatedOn,
      map,
      photos,
      request: outstation,
      workload,
    });

    const pdf = await withChromiumPage(async (page) => {
      // Every image is already inline, so there is nothing to wait for on the network.
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });

      // ── Is any evidence photo actually BLANK? ────────────────────────────────────────────────
      //
      // The review card flags a black frame, and this document's whole contract is to be that card
      // on paper — so a note the screen carries and the PDF drops would make the PDF the less
      // honest of the two, which is the opposite of the point.
      //
      // It has to happen HERE because nothing on the server can read a JPEG's pixels: Chromium is
      // the only decoder in the runtime. So the document is rendered once, measured in the page it
      // just became, and rendered again with the readings in. One extra parse of already-inline
      // images, no second browser, and — on the ordinary trip where both photos are fine — no
      // second render at all.
      //
      // It NEVER fails the document: an unreadable measurement classifies as "unknown", says
      // nothing, and the PDF is produced exactly as it would have been.
      const notes = await readBlankFrameNotes(page, photos.length);
      if (notes.size > 0) {
        await page.setContent(
          buildOutstationReviewDocument({
            generatedOn,
            map,
            photos: photos.map((photo, index) => ({ ...photo, frameNote: notes.get(index) ?? null })),
            request: outstation,
            workload,
          }),
          { timeout: 30_000, waitUntil: "domcontentloaded" },
        );
      }

      // Chromium applies `@media screen` by default even when producing a PDF.
      await page.emulateMediaType("print");
      const bytes = await page.pdf({
        displayHeaderFooter: true,
        footerTemplate: outstationReviewFooter({ generatedOn, requestId: outstation.id }),
        format: "A4",
        // An empty header: Chromium prints its own date and URL there unless told otherwise.
        headerTemplate: "<span></span>",
        margin: { bottom: "18mm", left: "12mm", right: "12mm", top: "12mm" },
        // The zebra row and the brand rule are CSS backgrounds — without this the house look is lost.
        printBackground: true,
        timeout: 60_000,
      });
      return Buffer.from(bytes);
    });

    const filename = `${slug(outstation.employeeName ?? "")}-OUTSTATION-${outstation.id}-Trip-Review.pdf`;
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
        { error: "pdf_unavailable", message: "The PDF renderer is not available right now. Try again shortly." },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "outstation_pdf_failed", message: clientSafeErrorMessage(error, "Unable to produce the PDF.") },
      { status: 500 },
    );
  }
}

/**
 * Ask the rendered page which of its evidence photos carry no picture at all.
 *
 * The measurement is `measureImageFrame` itself, shipped into the page by
 * `photoFrameMeasurementScript` — the same function the review card runs on the approver's screen,
 * not a second copy of it. The verdict is then taken on THIS side, by the same pure classifier, so
 * the sentence the PDF prints is the sentence the card shows, to the character.
 *
 * 🔴 It returns an EMPTY map on any trouble, and the document is produced unchanged. A photo that
 * could not be measured is not a photo that is empty, and a PDF is not worth failing over a note.
 */
async function readBlankFrameNotes(page: ChromiumPage, photoCount: number): Promise<Map<number, string>> {
  const notes = new Map<number, string>();
  if (photoCount === 0) return notes;
  try {
    const readings = await page.evaluate(photoFrameMeasurementScript());
    if (!Array.isArray(readings)) return notes;
    for (const entry of readings) {
      if (!entry || typeof entry !== "object") continue;
      const { index, reading } = entry as { index?: unknown; reading?: unknown };
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= photoCount) continue;
      if (!reading || typeof reading !== "object") continue;
      // Anything that is not a finite number arrives as undefined, which classifies as "unknown".
      const { maxLuminance, meanLuminance } = reading as Record<string, unknown>;
      const frame = classifyPhotoFrame({
        maxLuminance: typeof maxLuminance === "number" ? maxLuminance : null,
        meanLuminance: typeof meanLuminance === "number" ? meanLuminance : null,
      });
      if (frame.verdict === "no-image" && frame.headline) notes.set(index, frame.headline);
    }
  } catch {
    // A page that cannot be evaluated says nothing about the photographs in it.
    return new Map();
  }
  return notes;
}
