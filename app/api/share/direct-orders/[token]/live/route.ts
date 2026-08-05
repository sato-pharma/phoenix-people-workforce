import { NextResponse } from "next/server";

import {
  buildDirectOrderReportCsv,
  resolveDirectOrderReportShareLink,
} from "@/lib/direct-orders/report-share-links";
import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The human live link (owner request, 2026-08-05): read-only, no Phoenix account, always current
 * because every open re-queries the database.
 *
 * POST, not GET, and the passcode travels in the BODY — a passcode in a query string ends up in
 * browser history, referrer headers and any proxy log between here and the reader, which would
 * make the passcode weaker than no passcode at all (it would look protected while leaking).
 *
 * Returns JSON; the page renders it. `format: "csv"` returns the same rows as a file, so the
 * recipient can take the spreadsheet without a Phoenix login.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = (await request.json().catch(() => ({}))) as { passcode?: string; format?: string };
    const resolved = await resolveDirectOrderReportShareLink({
      token,
      passcode: body.passcode ?? null,
      surface: "live",
    });

    if (String(body.format ?? "") === "csv") {
      return new NextResponse(buildDirectOrderReportCsv(resolved.rows), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Cache-Control": "no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Content-Disposition": 'attachment; filename="direct-orders.csv"',
        },
      });
    }

    return NextResponse.json(
      {
        success: true,
        label: resolved.label,
        generatedAt: resolved.generatedAt,
        rowCount: resolved.rows.length,
        rows: resolved.rows,
      },
      { headers: { "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow, noarchive" } },
    );
  } catch (error) {
    const apiError = toApiError(error, "This link is not available.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { success: false, message: apiError.message },
      { status, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }
}
