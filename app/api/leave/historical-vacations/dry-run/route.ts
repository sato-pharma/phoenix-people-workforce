import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { dryRunHistoricalVacationImport } from "@/lib/leave/service";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload a historical vacation XLSX file." }, { status: 400 });
    }
    const result = await dryRunHistoricalVacationImport(access, file);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to dry-run historical vacation import." }, { status: 400 });
  }
}
