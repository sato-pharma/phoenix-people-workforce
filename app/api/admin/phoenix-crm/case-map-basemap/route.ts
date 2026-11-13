import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseCaseMapBasemapQuery } from "@/lib/crm-integrity/integrity-case-map";
import { fetchBasemapPng } from "@/lib/field-activity/map";
import { notFoundError, validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canDecideFarVisitHolds } from "@/lib/phoenix-crm/server/far-visit-safeguards";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { canReadRefusedReadings } from "@/lib/phoenix-crm/server/refused-readings-board";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A reader's own ceiling: far above a working day of cases, far below a page asking without end. */
const PICTURES_PER_HOUR = 600;

/**
 * GET = the streets behind one Location Integrity map (owner, 13 Nov 2026: "Move it to Google Maps").
 *
 * The integrity board, the one-by-one review, the refused-readings board, the held visits and the places to
 * re-check all draw their readings over one picture, and each asks this route for it. The route asks
 * Google's Maps Static API with the server key, so the key never reaches a browser and no browser asks a
 * map host anything.
 *
 * 🔴 EVERY PICTURE IS COUNTED AGAINST THE COMPANY'S GOOGLE ACCOUNT, so it is drawn only for the people who
 * read those boards (the Super Admin and the SFE Manager, each board's own predicate), only for a frame
 * `buildCaseMap` could have asked for (`parseCaseMapBasemapQuery`), and at most 600 times an hour for one
 * person. The answer is kept by the reader's own browser for a day, the time Google's own answer allows, so
 * the same case opened twice is one picture. What the account may spend is set on Google's own Quotas
 * screen, never here.
 *
 * Anybody else gets the boards' own 404, never a 403 that names what it guards. A picture Google would not
 * draw is a 503 that is not kept, and the page's markers and metres stand without it.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    if (!canReadIntegrityBoard(viewer) && !canReadRefusedReadings(viewer) && !canDecideFarVisitHolds(viewer)) {
      throw notFoundError("Not found.");
    }
    const frame = parseCaseMapBasemapQuery(new URL(request.url).searchParams);
    if (!frame) throw validationError("That is not a map this page draws.");

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: PICTURES_PER_HOUR,
      scope: "phoenix-crm:case-map-basemap",
      windowMs: 60 * 60_000,
    });

    const png = await fetchBasemapPng({
      ...frame,
      apiKey: process.env.GOOGLE_MAPS_SERVER_KEY ?? null,
      caller: "case-map basemap",
    });
    if (!png) {
      return new Response(null, { headers: { "Cache-Control": "no-store" }, status: 503 });
    }
    return new Response(new Uint8Array(png), {
      headers: { "Cache-Control": "private, max-age=86400", "Content-Type": "image/png" },
      status: 200,
    });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not draw the map.");
  }
}
