import { cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  buildWeeklySalesDepotDetailFilename,
  buildWeeklySalesDepotDetailWorkbook,
} from "@/lib/sales/weekly/depot-detail-workbook";
import type { WeeklySalesDepotDetailPayload } from "@/lib/sales/weekly/sales-depot-detail";

/** The XLSX response both Weekly Sales Depot Detail export routes (managers' and a rep's) return. */
export async function respondWithWeeklySalesDepotDetailWorkbook(
  payload: WeeklySalesDepotDetailPayload,
  fileMonths: readonly string[],
): Promise<Response> {
  const workbook = buildWeeklySalesDepotDetailWorkbook(payload, {
    generatedAtCairo: cairoDateTime(new Date().toISOString()),
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${buildWeeklySalesDepotDetailFilename(payload.view.audience, fileMonths)}"`,
      "Cache-Control": "no-store",
    },
  });
}
