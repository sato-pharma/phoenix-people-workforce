import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { systemIdentity } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listEditableProfiles, PROFILE_FIELDS } from "@/lib/sales/normalizer/distributor-profile-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only export of the editable distributor mapping (one row per distributor; cells = "/"-joined raw
// columns). The same shape is accepted back by the import route. Persists nothing.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");
    const profiles = await listEditableProfiles();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = systemIdentity.appName;
    const sheet = workbook.addWorksheet("Distributor mapping");
    const headers = ["Distributor Code", "Distributor Name", ...PROFILE_FIELDS.map((f) => f.label), "Value mode", "Region only"];
    const header = sheet.addRow(headers);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell) => { cell.fill = { fgColor: { argb: "FF0B0B0B" }, pattern: "solid", type: "pattern" }; });
    for (const p of profiles) {
      sheet.addRow([
        p.distributorCode,
        p.distributorName,
        ...PROFILE_FIELDS.map((f) => (p.fields[f.key] ?? []).join(" / ")),
        p.valueSource,
        p.regionOnly ? "yes" : "no",
      ]);
    }
    headers.forEach((_, i) => { sheet.getColumn(i + 1).width = i < 2 ? 18 : 26; });

    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-distributor-mapping.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Export failed." }, { status: 500 });
  }
}
