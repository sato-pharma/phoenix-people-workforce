import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import {
  ConsolidatedClosingSelectionError,
  canExportConsolidatedClosing,
  resolveConsolidatedPeriods,
} from "@/lib/sales/closing-consolidated";
import { buildConsolidatedPremiumClosing } from "@/lib/sales/closing-consolidated-premium-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CONSOLIDATED premium workbook — several months of one line added together, filled into the
 * owner's premium engine. Owner, 2026-09-14: Super Admin and the CEO only.
 *
 * BESIDE /api/sales/monthly-closing/premium-export, which keeps serving the single month. See
 * closing-consolidated-premium-export.ts.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    if (!canExportConsolidatedClosing(access.role)) {
      return Response.json(
        { error: "The consolidated closing is available to the Super Admin and the CEO only." },
        { status: 403 },
      );
    }
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:closing-premium-consolidated",
    });

    const body = (await request.json().catch(() => ({}))) as {
      areaCodes?: string[];
      line?: string | null;
      /** False asks for the button-less plain .xlsx. Default is the .xlsm, as for the single month. */
      macros?: boolean;
      periods?: unknown;
      productCodes?: string[];
      regionCodes?: string[];
      search?: string;
    };
    const line = typeof body.line === "string" ? body.line.trim() : "";
    if (!line) {
      return Response.json({ error: "Pick a line to download a consolidated closing." }, { status: 400 });
    }
    const periods = resolveConsolidatedPeriods(body.periods);
    const macros = body.macros !== false;

    const result = await buildConsolidatedPremiumClosing({
      access,
      filter: {
        areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
        productCodes: Array.isArray(body.productCodes) ? body.productCodes : [],
        regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
        search: typeof body.search === "string" ? body.search : "",
      },
      line,
      macros,
      periods,
    });
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "Content-Type": macros
          ? "application/vnd.ms-excel.sheet.macroEnabled.12"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (error instanceof ConsolidatedClosingSelectionError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (isForbiddenError(error)) {
      return Response.json({ error: "You do not have permission to export this report." }, { status: 403 });
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    return Response.json({ error: clientSafeErrorMessage(error, "Export failed.") }, { status: 500 });
  }
}
