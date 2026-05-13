import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getLeaveAccrualPreview, runMonthlyLeaveAccrual } from "@/lib/leave/service";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const params = new URL(request.url).searchParams;
    const result = await getLeaveAccrualPreview(access, {
      month: params.get("month") ? Number(params.get("month")) : undefined,
      year: params.get("year") ? Number(params.get("year")) : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to preview leave accrual." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}));
    if (body.dryRun) {
      const result = await getLeaveAccrualPreview(access, {
        month: body.month ? Number(body.month) : undefined,
        year: body.year ? Number(body.year) : undefined,
      });
      return NextResponse.json(result);
    }
    const result = await runMonthlyLeaveAccrual(access, {
      month: body.month ? Number(body.month) : undefined,
      year: body.year ? Number(body.year) : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to run leave accrual." }, { status: 400 });
  }
}
