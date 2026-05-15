import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getLeaveTitleWeekendRules, updateLeaveTitleWeekendRules } from "@/lib/leave/service";

export async function GET() {
  try {
    const rules = await getLeaveTitleWeekendRules();
    return NextResponse.json({ rules });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load title weekend rules." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const rules = await updateLeaveTitleWeekendRules(access, {
      rules: Array.isArray(body?.rules) ? body.rules : [],
    });
    return NextResponse.json({ rules });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save title weekend rules." },
      { status: 400 },
    );
  }
}
