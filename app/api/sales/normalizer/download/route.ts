import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { formFiles, recognizeWorkbookFiles } from "@/lib/sales/normalizer/multi-file";
import { buildCodedWorkbook, recognitionErrorMessage } from "@/lib/sales/normalizer/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slug(value: string | null | undefined) {
  return (value ?? "coded").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "coded";
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "export");

    const form = await request.formData();
    // One raw sheet, or several of the same distributor chosen together (multi-file.ts).
    const files = formFiles(form);
    const distributorCode = String(form.get("distributorCode") ?? "");
    if (files.length === 0) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const normalized = await recognizeWorkbookFiles(distributorCode, files);
    if (normalized.status !== "ok") {
      return NextResponse.json({ success: false, error: recognitionErrorMessage(normalized) }, { status: 422 });
    }
    const { fileNames, parts } = normalized;
    // Several distributors come down as ONE coded sheet, not one file each: every coded row carries
    // its own "Distrub ID", so the sheet is complete and readable either way, and this is the file a
    // person re-uploads by hand. The IMPORT is still one batch per distributor.
    const buffer = await buildCodedWorkbook({
      coded: parts.flatMap((part) => part.result.coded),
      exceptions: parts.flatMap((part) => part.result.exceptions),
    }, fileNames);
    const period = parts[0].period;
    const distributors = new Set(parts.map((part) => part.distributorCode)).size;
    // Named for the RESOLVED distributor — a Phoenix-template upload would otherwise download as
    // "phoenix-coded-phx-template-2026-09.xlsx" and tell nobody whose month it is. One distributor's
    // sheets of several months are named for every month they hold.
    const fileName = distributors === 1
      ? `phoenix-coded-${slug(parts[0].distributorCode)}-${slug(parts.map((part) => part.period ?? "coded").join("-"))}.xlsx`
      : `phoenix-coded-${distributors}-distributors-${slug(period)}.xlsx`;

    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    // A refusal written for the user (too many files, the same sheet twice). clientSafeErrorMessage
    // would hide it behind a generic failure.
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to build coded sheet.") }, { status: 500 });
  }
}
