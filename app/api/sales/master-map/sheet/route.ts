import { NextResponse } from "next/server";

import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";
import { readMasterMapStamp } from "@/lib/sales/master-map/fingerprint";
import { getMasterMapPlan, getMasterMapSlice } from "@/lib/sales/master-map/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Read-only feed for the Master Map Google Sheet.
 *
 * The sheet drives itself: a Google Apps Script inside the workbook polls this endpoint and paints
 * what it gets back. That is why the credential here is a shared bearer token rather than a Google
 * service-account key — Google's org policy blocks key creation on this account, and the script
 * already runs as the sheet's owner, so it needs no Google credential of its own. See
 * google-apps-script/master-map/README.md.
 *
 * THREE MODES, cheapest first:
 *
 *   ?probe=1   the change stamp and nothing else. Five aggregate queries, no rows. This is what
 *              runs every five minutes, and on an unchanged database it is the whole cost.
 *   ?plan=1    one line per tab with a content hash, so the script repaints only what moved.
 *              Loads the crosswalk, so it runs only when the stamp says something happened.
 *   ?tab=...   one slice of one tab, served from the snapshot the plan was cut from.
 *
 * Everything is a GET and nothing here mutates Phoenix. The only thing this endpoint can do to the
 * business is disclose the customer master, which is why it is still behind a token.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.MASTER_MAP_SYNC_TOKEN;
  // Unset in production means misconfigured, not open. An unset MASTER_MAP_SYNC_TOKEN may ONLY
  // be bypassed on a real developer machine — anything less would leave the customer master
  // disclosable wherever the token is unset, including staging.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

function positiveInt(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("sales/master-map/sheet", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);

  try {
    if (url.searchParams.get("probe") === "1") {
      return NextResponse.json({ stamp: await readMasterMapStamp() });
    }

    if (url.searchParams.get("plan") === "1") {
      return NextResponse.json(await getMasterMapPlan());
    }

    const title = url.searchParams.get("tab");
    if (!title) {
      return NextResponse.json(
        { error: "bad_request", message: "Pass probe=1, plan=1, or tab=<title>." },
        { status: 400 },
      );
    }

    const requestedPart = url.searchParams.get("part");
    const part =
      requestedPart === "clear" || requestedPart === "requests" ? requestedPart : "values";
    const slice = await getMasterMapSlice({
      chunk: positiveInt(url.searchParams.get("chunk"), 0),
      part,
      sheetId: positiveInt(url.searchParams.get("sheetId"), 0),
      stamp: url.searchParams.get("stamp") ?? "",
      title,
    });

    if (!slice) {
      return NextResponse.json(
        { error: "unknown_tab", message: `No such tab: ${title}` },
        { status: 404 },
      );
    }

    return NextResponse.json(slice);
  } catch (error) {
    logError("Master Map sheet feed failed — the live Google Sheet will stop refreshing", {
      labels: { event: "master_map_feed_failed", route: "sales/master-map/sheet" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Master Map feed failed.");
    return NextResponse.json({ error: "master_map_feed_failed", message }, { status: 500 });
  }
}
