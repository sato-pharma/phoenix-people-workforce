import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getLeavePolicies, upsertLeavePolicy } from "@/lib/leave/service";

export async function GET() {
  try {
    const policies = await getLeavePolicies(true);
    return NextResponse.json({ policies });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load leave policies." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const policy = await upsertLeavePolicy(access, body);
    return NextResponse.json({ policy });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save leave policy." }, { status: 400 });
  }
}
