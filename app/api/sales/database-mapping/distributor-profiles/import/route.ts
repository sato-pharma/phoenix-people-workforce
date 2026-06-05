import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { PROFILE_FIELDS, saveDistributorProfile, type ProfileFieldKey } from "@/lib/sales/normalizer/distributor-profile-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accept the edited distributor-mapping XLSX (same shape as the export) and save every row.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return NextResponse.json({ success: false, error: "Empty workbook." }, { status: 400 });

    const idx: Record<string, number> = {};
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { idx[String(cell.text ?? "").trim().toLowerCase()] = col; });
    const codeCol = idx["distributor code"];
    if (!codeCol) return NextResponse.json({ success: false, error: "Not a valid distributor-mapping workbook (missing 'Distributor Code' column)." }, { status: 400 });

    const splitCols = (text: string) => text.split("/").map((s) => s.trim()).filter(Boolean);
    let saved = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const code = String(row.getCell(codeCol)?.text ?? "").trim();
      if (!code) { skipped += 1; continue; }
      const fields = {} as Record<ProfileFieldKey, string[]>;
      for (const f of PROFILE_FIELDS) {
        const col = idx[f.label.toLowerCase()];
        fields[f.key] = col ? splitCols(String(row.getCell(col)?.text ?? "")) : [];
      }
      const vmCol = idx["value mode"];
      const roCol = idx["region only"];
      const valueSource = vmCol && String(row.getCell(vmCol)?.text ?? "").trim().toLowerCase() === "sheet" ? "sheet" : "recompute";
      const regionOnly = Boolean(roCol && String(row.getCell(roCol)?.text ?? "").trim().toLowerCase() === "yes");
      try {
        await saveDistributorProfile(code, { fields, regionOnly, valueSource }, access.hrId || "admin");
        saved += 1;
      } catch (e) {
        skipped += 1;
        errors.push(`${code}: ${e instanceof Error ? e.message : "save failed"}`);
      }
    }
    return NextResponse.json({ success: true, data: { errors: errors.slice(0, 20), saved, skipped } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Import failed." }, { status: 400 });
  }
}
