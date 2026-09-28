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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
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
import { getOutstationRequestById } from "@/lib/outstation/service";
import { approverTripPhotos } from "@/lib/outstation/trip-evidence-photos";
import { resolveWorkloadFreshness } from "@/lib/outstation/workload-freshness";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two photo fetches, one map fetch, one CRM read and a Chromium render.
export const maxDuration = 90;

/** A photo larger than this is left out with a sentence rather than bloating the file. */
const PHOTO_BYTE_LIMIT = 8 * 1024 * 1024;

function houseMarkDataUri(): string {
  try {
    const svg = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-light.svg"), "utf8");
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  } catch {
    // The mark is the letterhead, not the content. A document without it is still a true document.
    return "";
  }
}

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
    // Google's street map when it answers; otherwise the route Phoenix already stored, drawn here.
    // Measured 2026-09-29: the Maps Static API is not enabled on the project behind the local key,
    // so the fallback is not an edge case — it is what prints until that API is switched on.
    const streetMap = await fetchRouteStaticMap(mapPlan);
    const diagram = streetMap
      ? null
      : renderRouteDiagram({
          destination: { lat: outstation.capturedLatitude, lng: outstation.capturedLongitude },
          polyline: outstation.routePolyline,
          residence: { lat: outstation.residenceLatitude, lng: outstation.residenceLongitude },
        });
    const map = streetMap
      ? { caption: mapPlan.caption, image: streetMap }
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
            pm: day.pm,
            regular: day.regular,
          })),
          freshnessHeadline: freshness.verdict === "stale" ? freshness.headline : null,
          live: {
            am: live.amWorkload,
            campaign: live.campaignVisits,
            pharmacies: live.pharmacyWorkload ?? 0,
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
      mark: houseMarkDataUri(),
      photos,
      request: outstation,
      workload,
    });

    const pdf = await withChromiumPage(async (page) => {
      // Every image is already inline, so there is nothing to wait for on the network.
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
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
