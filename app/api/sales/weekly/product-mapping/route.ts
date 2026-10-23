import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  deleteProductAlias,
  importProductAliasWorkbook,
  loadWeeklyProductAliasAdmin,
  upsertProductAlias,
  type WeeklyAliasKind,
} from "@/lib/sales/weekly/product-aliases";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const distributor = new URL(request.url).searchParams.get("distributor")?.trim() || undefined;
    const data = await loadWeeklyProductAliasAdmin(distributor);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return mapError(error, "Failed to load product mapping.");
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
      const result = await importProductAliasWorkbook({ distributorCode, file, actorId });
      const data = await loadWeeklyProductAliasAdmin(distributorCode);
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
      alias?: string;
      aliasKind?: string;
      productCode?: string;
    };
    if (body?.action === "delete") {
      await deleteProductAlias(String(body.id ?? ""));
    } else {
      await upsertProductAlias({
        distributorCode: String(body?.distributorCode ?? ""),
        alias: String(body?.alias ?? ""),
        aliasKind: (body?.aliasKind === "name" ? "name" : "code") as WeeklyAliasKind,
        productCode: String(body?.productCode ?? ""),
        actorId,
      });
    }
    const data = await loadWeeklyProductAliasAdmin(body?.distributorCode ? String(body.distributorCode) : undefined);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return mapError(error, "Failed to update product mapping.");
  }
}
