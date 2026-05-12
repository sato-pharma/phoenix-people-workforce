import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getPublicHolidays, upsertPublicHoliday } from "@/lib/leave/service";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const holidays = await getPublicHolidays(
      params.get("year") ? Number(params.get("year")) : new Date().getUTCFullYear(),
      params.get("country") || "EG",
    );
    return NextResponse.json({ holidays });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load public holidays." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const holiday = await upsertPublicHoliday(access, body);
    return NextResponse.json({ holiday });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save public holiday." }, { status: 400 });
  }
}
