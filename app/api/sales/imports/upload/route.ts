import { NextResponse } from "next/server";
import { runSalesImportWorkflow } from "@/lib/sales/import-workflow";
import { SalesWorkflowError } from "@/lib/sales/contracts";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const line = String(formData.get("line") ?? "");
    const uploadedBy = String(formData.get("uploadedBy") ?? "admin");

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "Sales workbook file is required." }, { status: 400 });
    }

    const result = await runSalesImportWorkflow({ file, line, uploadedBy });
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Upload failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
