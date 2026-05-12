import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { runMonthlyLeaveAccrual } from "@/lib/leave/service";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}));
    const result = await runMonthlyLeaveAccrual(access, {
      month: body.month ? Number(body.month) : undefined,
      year: body.year ? Number(body.year) : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to run leave accrual." }, { status: 400 });
  }
}
