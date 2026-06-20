import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { buildWeeklyExportWorkbook } from "@/lib/sales/weekly/export-workbook";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");

    const params = new URL(request.url).searchParams;
    const parseList = (key: string) =>
      params
        .getAll(key)
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean);
    const str = (key: string) => {
      const v = params.get(key);
      return v && v.trim() ? v.trim() : null;
    };
    const mode = (key: string): "include" | "exclude" =>
      (params.get(key) ?? "").toLowerCase() === "exclude" ? "exclude" : "include";
    const allWeeks = ["1", "true", "yes", "all"].includes((params.get("allWeeks") ?? "").toLowerCase());

    const accessScope = await resolveWeeklyAccessScope(access);
    const data = await loadWeeklyDashboard({
      weekStarts: parseList("week"),
      allWeeks,
      weekStart: str("week"),
      lineCodes: parseList("line"),
      lineFilterMode: mode("lineMode"),
      distributorCodes: parseList("distributor"),
      distributorFilterMode: mode("distributorMode"),
      regionCodes: parseList("region"),
      regionFilterMode: mode("regionMode"),
      productCodes: parseList("product"),
      productFilterMode: mode("productMode"),
      accessScope,
    });

    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const buffer = await buildWeeklyExportWorkbook(data, generatedAt);

    // Build a meaningful filename from filters
    const parts: string[] = ["phoenix-weekly-sales"];
    const weekLabel = data.appliedFilters.allWeeks
      ? "all-weeks"
      : data.appliedFilters.weekStarts.length === 1
        ? data.appliedFilters.weekStarts[0]
        : data.appliedFilters.weekStarts.length > 1
          ? `${data.appliedFilters.weekStarts.length}-weeks`
          : "latest";
    parts.push(weekLabel);
    // Summarize each multi filter: single include -> the code; multi include -> "N-noun";
    // exclude -> "excl-N-noun". Empty selections add nothing.
    const seg = (codes: string[], filterMode: "include" | "exclude", noun: string): string | null => {
      if (codes.length === 0) return null;
      if (filterMode === "exclude") return `excl-${codes.length}-${noun}`;
      if (codes.length === 1) return codes[0].toLowerCase().replace(/\s+/g, "-");
      return `${codes.length}-${noun}`;
    };
    const f = data.appliedFilters;
    for (const part of [
      seg(f.distributorCodes, f.distributorFilterMode, "distributors"),
      seg(f.regionCodes, f.regionFilterMode, "regions"),
      seg(f.productCodes, f.productFilterMode, "products"),
      seg(f.lineCodes, f.lineFilterMode, "lines"),
    ]) {
      if (part) parts.push(part);
    }
    const filename = parts.join("_") + ".xlsx";

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
      JSON.stringify({ error: error instanceof Error ? error.message : "Export failed." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
