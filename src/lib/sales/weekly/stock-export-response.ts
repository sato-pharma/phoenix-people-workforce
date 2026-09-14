import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { WeeklyStockPayload } from "@/lib/sales/weekly/stock-dashboard-service";
import { buildWeeklyStockExportFilename, buildWeeklyStockWorkbook } from "@/lib/sales/weekly/stock-workbook";

/** The XLSX response both Weekly Stock export routes (admin shell and portal) return. */
export async function respondWithWeeklyStockWorkbook(payload: WeeklyStockPayload): Promise<Response> {
  const workbook = buildWeeklyStockWorkbook(payload.view, {
    scopeSummary: payload.scope.summary,
    generatedAtCairo: cairoDateTime(new Date().toISOString()),
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${buildWeeklyStockExportFilename(payload.view)}"`,
      "Cache-Control": "no-store",
    },
  });
}
