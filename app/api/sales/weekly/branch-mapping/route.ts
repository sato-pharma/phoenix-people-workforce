import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  deleteBranchRegionRow,
  importBranchRegionWorkbook,
  loadWeeklyBranchRegionAdmin,
  upsertBranchRegionRow,
  type WeeklyBranchFileType,
} from "@/lib/sales/weekly/branch-region-map";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fileType(value: string | null | undefined): WeeklyBranchFileType {
  const key = String(value ?? "").trim().toLowerCase();
  return key === "sales" || key === "stock" ? key : "any";
}

function mapError(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    const params = new URL(request.url).searchParams;
    const distributor = params.get("distributor")?.trim();
    if (!distributor) {
      return NextResponse.json({ success: false, error: "A distributor is required." }, { status: 400 });
    }
    const data = await loadWeeklyBranchRegionAdmin(distributor, fileType(params.get("fileType")));
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return mapError(error, "Failed to load branch mapping.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "update");
    const actorId = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const distributorCode = String(formData.get("distributorCode") ?? "").trim();
      const ft = fileType(String(formData.get("fileType") ?? ""));
      if (!(file instanceof File)) {
        return NextResponse.json({ success: false, error: "An XLSX file is required." }, { status: 400 });
      }
      const validation = validateSpreadsheetFile(file, {
        ...xlsxSpreadsheetValidation,
        emptyError: "invalid_mapping_file",
        tooLargeMessage: spreadsheetTooLargeMessage("Mapping workbook"),
      });
      if (!validation.ok) {
        return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
      }
      const result = await importBranchRegionWorkbook({ distributorCode, fileType: ft, file, actorId });
      const data = await loadWeeklyBranchRegionAdmin(distributorCode, ft);
      const blocked = result.blockedRows.length > 0;
      return NextResponse.json(
        {
          success: !blocked,
          data,
          result,
          error: blocked ? "Some rows could not be imported. Fix them and upload again." : undefined,
          message: blocked ? "Import blocked." : `${result.inserted} added, ${result.updated} updated, ${result.skipped} skipped.`,
        },
        { status: blocked ? 400 : 200 },
      );
    }

    const body = (await request.json()) as {
      action?: string;
      id?: string;
      distributorCode?: string;
      rawBranch?: string;
      branchName?: string;
      regionCode?: string;
      areaCode?: string | null;
      sourceFileType?: string;
      branchColumnIndex?: number | string | null;
      excluded?: boolean;
    };
    if (body?.action === "delete") {
      await deleteBranchRegionRow(String(body.id ?? ""));
    } else {
      await upsertBranchRegionRow({
        distributorCode: String(body?.distributorCode ?? ""),
        rawBranch: String(body?.rawBranch ?? ""),
        branchName: body?.branchName == null ? null : String(body.branchName),
        regionCode: String(body?.regionCode ?? ""),
        // Optional: blank keeps the branch region-only (the default).
        areaCode: body?.areaCode == null ? null : String(body.areaCode),
        sourceFileType: fileType(body?.sourceFileType),
        branchColumnIndex:
          body?.branchColumnIndex == null || body.branchColumnIndex === "" ? null : Number(body.branchColumnIndex),
        excluded: Boolean(body?.excluded),
        actorId,
      });
    }
    const data = await loadWeeklyBranchRegionAdmin(
      String(body?.distributorCode ?? ""),
      fileType(body?.sourceFileType),
    );
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return mapError(error, "Failed to update branch mapping.");
  }
}
