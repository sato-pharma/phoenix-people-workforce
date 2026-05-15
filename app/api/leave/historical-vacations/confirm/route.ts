import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { confirmHistoricalVacationImport } from "@/lib/leave/service";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload the same historical vacation XLSX file to confirm import." }, { status: 400 });
    }
    const result = await confirmHistoricalVacationImport(access, file);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to confirm historical vacation import." }, { status: 400 });
  }
}
