import { NextResponse } from "next/server";

import { deleteSalaryBatch } from "@/lib/payroll/service";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteSalaryBatch(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll upload delete failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
