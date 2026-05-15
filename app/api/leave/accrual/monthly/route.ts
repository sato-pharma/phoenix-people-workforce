import { NextResponse } from "next/server";

import { runAutomaticMonthlyLeaveAccrual } from "@/lib/leave/service";

export const dynamic = "force-dynamic";

function authorizeCron(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return {
      error: NextResponse.json(
        { error: "cron_secret_missing", message: "CRON_SECRET is required for automatic leave accrual." },
        { status: 500 },
      ),
      ok: false,
    } as const;
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return {
      error: NextResponse.json(
        { error: "unauthorized", message: "Automatic leave accrual is restricted to the scheduled cron job." },
        { status: 401 },
      ),
      ok: false,
    } as const;
  }

  return { ok: true } as const;
}

function optionalNumber(value: string | null) {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export async function GET(request: Request) {
  const authorization = authorizeCron(request);
  if (!authorization.ok) return authorization.error;

  try {
    const params = new URL(request.url).searchParams;
    const result = await runAutomaticMonthlyLeaveAccrual({
      notifyEmployees: true,
      throughMonth: optionalNumber(params.get("throughMonth")),
      year: optionalNumber(params.get("year")),
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "automatic_leave_accrual_failed",
        message: error instanceof Error ? error.message : "Automatic leave accrual failed.",
      },
      { status: 500 },
    );
  }
}
