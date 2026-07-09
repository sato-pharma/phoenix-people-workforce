import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSalesDashboard } from "@/lib/sales/service";
import type { SalesDashboardFilters } from "@/lib/sales/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const { searchParams } = new URL(request.url);
    const filters: SalesDashboardFilters = {
      line: firstValue(searchParams.get("line")),
      salesType: firstValue(searchParams.get("salesType")),
      manager: firstValue(searchParams.get("manager")),
      territory: firstValue(searchParams.get("territory")),
      family: firstValue(searchParams.get("family")),
      periods: splitList(searchParams.get("periods")),
      products: splitList(searchParams.get("products")),
    };

    const data = await getSalesDashboard(filters, access);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();

    // -- Summary Sheet --
    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.columns = [
      { header: "Metric", key: "metric", width: 30 },
      { header: "Value", key: "value", width: 25 }
    ];
    
    const summaryRowData = [
      { metric: "Total Approved Sales (EGP)", value: data.summary.totalApprovedSales },
      { metric: "Total Approved Target (EGP)", value: data.summary.totalApprovedTarget },
      { metric: "Achievement Rate", value: data.summary.achievementRate },
      { metric: "Units Sold", value: data.summary.unitsSold },
      { metric: "Average Factory Price (EGP)", value: data.summary.averageFactoryPrice },
      { metric: "Active Products", value: data.summary.activeProducts },
      { metric: "Linked Employees", value: data.summary.linkedEmployees },
      { metric: "Data Quality Rate", value: data.summary.dataQualityRate },
      { metric: "Top Manager", value: data.summary.topManager }
    ];
    
    summarySheet.addRows(summaryRowData);
    
    // Format Achievement/Data Quality as percentage
    summarySheet.getCell("B4").numFmt = "0.00%";
    summarySheet.getCell("B9").numFmt = "0.00%";
    // Format Currency
    summarySheet.getCell("B2").numFmt = "#,##0.00";
    summarySheet.getCell("B3").numFmt = "#,##0.00";
    summarySheet.getCell("B6").numFmt = "#,##0.00";

    // Style header
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

    // -- Managers Sheet --
    const mgrSheet = workbook.addWorksheet("Managers");
    mgrSheet.columns = [
      { header: "Manager", key: "manager", width: 30 },
      { header: "Line", key: "line", width: 25 },
      { header: "Top Product", key: "topProduct", width: 30 },
      { header: "Sales", key: "sales", width: 20 },
      { header: "Target", key: "target", width: 20 },
      { header: "Achievement Rate", key: "achievementRate", width: 20 }
    ];
    mgrSheet.addRows(data.managerPerformance);
    mgrSheet.getRow(1).font = { bold: true };
    mgrSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    mgrSheet.getColumn("sales").numFmt = "#,##0.00";
    mgrSheet.getColumn("target").numFmt = "#,##0.00";
    mgrSheet.getColumn("achievementRate").numFmt = "0.00%";

    // -- Products Sheet --
    const prodSheet = workbook.addWorksheet("Products");
    prodSheet.columns = [
      { header: "Product", key: "product", width: 30 },
      { header: "Family", key: "family", width: 25 },
      { header: "Sales", key: "sales", width: 20 },
      { header: "Target", key: "target", width: 20 },
      { header: "Achievement Rate", key: "achievementRate", width: 20 }
    ];
    prodSheet.addRows(data.productPerformance);
    prodSheet.getRow(1).font = { bold: true };
    prodSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    prodSheet.getColumn("sales").numFmt = "#,##0.00";
    prodSheet.getColumn("target").numFmt = "#,##0.00";
    prodSheet.getColumn("achievementRate").numFmt = "0.00%";

    // -- Lines Sheet --
    const lineSheet = workbook.addWorksheet("Lines");
    lineSheet.columns = [
      { header: "Line", key: "line", width: 30 },
      { header: "Sales", key: "sales", width: 20 },
      { header: "Target", key: "target", width: 20 },
      { header: "Achievement Rate", key: "achievementRate", width: 20 },
      { header: "Linked Employees", key: "linkedEmployees", width: 20 }
    ];
    lineSheet.addRows(data.linePerformance);
    lineSheet.getRow(1).font = { bold: true };
    lineSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    lineSheet.getColumn("sales").numFmt = "#,##0.00";
    lineSheet.getColumn("target").numFmt = "#,##0.00";
    lineSheet.getColumn("achievementRate").numFmt = "0.00%";

    // -- Territories Sheet --
    const terrSheet = workbook.addWorksheet("Territories");
    terrSheet.columns = [
      { header: "Territory", key: "name", width: 30 },
      { header: "Sales", key: "sales", width: 20 },
      { header: "Target", key: "target", width: 20 },
      { header: "Achievement Rate", key: "achievementRate", width: 20 }
    ];
    terrSheet.addRows(data.territories);
    terrSheet.getRow(1).font = { bold: true };
    terrSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    terrSheet.getColumn("sales").numFmt = "#,##0.00";
    terrSheet.getColumn("target").numFmt = "#,##0.00";
    terrSheet.getColumn("achievementRate").numFmt = "0.00%";

    // -- Trend Sheet --
    const trendSheet = workbook.addWorksheet("Trend");
    trendSheet.columns = [
      { header: "Period", key: "period", width: 20 },
      { header: "Sales", key: "sales", width: 20 },
      { header: "Target", key: "target", width: 20 },
      { header: "Achievement Rate", key: "achievementRate", width: 20 }
    ];
    trendSheet.addRows(data.trend);
    trendSheet.getRow(1).font = { bold: true };
    trendSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    trendSheet.getColumn("sales").numFmt = "#,##0.00";
    trendSheet.getColumn("target").numFmt = "#,##0.00";
    trendSheet.getColumn("achievementRate").numFmt = "0.00%";

    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="Monthly-Sales-Dashboard-Export.xlsx"',
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export monthly sales data." },
      { status: 500 }
    );
  }
}
