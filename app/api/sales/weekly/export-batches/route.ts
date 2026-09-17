import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { buildCombinedReportExport } from "@/lib/sales/weekly/combined-report";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");

    const body = (await request.json()) as { batchIds?: unknown };
    const rawIds = body?.batchIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return new Response(JSON.stringify({ error: "batchIds must be a non-empty array." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (rawIds.length > 20) {
      return new Response(JSON.stringify({ error: "Cannot export more than 20 batches at once." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const batchIds = rawIds.filter((id): id is string => typeof id === "string");
    if (batchIds.length === 0) {
      return new Response(JSON.stringify({ error: "No valid batch IDs provided." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const buffer = await buildCombinedReportExport(getSupabaseAdmin(), batchIds);
    if (!buffer) {
      return new Response(JSON.stringify({ error: "No batches found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const filename = `phoenix-weekly-combined_${batchIds.length}-batches.xlsx`;

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    if (error instanceof SalesWorkflowError) {
      return new Response(JSON.stringify({ error: error.message }), { status: error.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify({ error: clientSafeErrorMessage(error, "Export failed.") }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
