import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildUnmappedWorkbook, distinctUnknowns } from "@/lib/sales/normalizer/mapping";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { formFiles, recognizeWorkbookFiles } from "@/lib/sales/normalizer/multi-file";
import { recognitionErrorMessage } from "@/lib/sales/normalizer/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Build the "unmapped list" XLSX for an uploaded raw file: one row per DISTINCT unknown code, with
// a suggestion + a blank "Phoenix Code" column the user fills, then uploads back to /learn.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
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
    // The unmapped list is PER DISTRIBUTOR: the Phoenix Code written beside a raw customer code is
    // learned under ONE distributor, and that same code is a different customer under another. So
    // this answers for the distributor the screen is showing — the only file that can hold more
    // than one is a Phoenix template, and every other upload has exactly one part to pick from.
    // Several sheets of that distributor can make one part per month: the list covers them all, since
    // a code mapped once is mapped for every month.
    const wanted = String(form.get("partDistributorCode") ?? "");
    const part = normalized.parts.find((p) => p.distributorCode === wanted) ?? normalized.parts[0];
    const exceptions = normalized.parts.filter((p) => p.distributorCode === part.distributorCode).flatMap((p) => p.result.exceptions);
    const buffer = await buildUnmappedWorkbook(distinctUnknowns(exceptions, normalized.products));
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-unmapped-${part.distributorCode}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    // A refusal written for the user (too many files, the same sheet twice). clientSafeErrorMessage
    // would hide it behind a generic failure.
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to build unmapped list.") }, { status: 500 });
  }
}
