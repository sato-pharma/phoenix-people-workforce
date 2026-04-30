import { NextResponse } from "next/server";

import {
  errorMessage,
  getVacancyReport,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reportError(error: unknown) {
  if (isSupabaseTimeout(error)) {
    return {
      message: "Supabase request timed out. Check your connection and try again.",
      status: 504,
    };
  }

  if (isSupabaseEnvMissing(error)) {
    return {
      message: "Supabase environment variables are missing.",
      status: 409,
    };
  }

  if (isDatabaseSchemaMissing(error)) {
    return {
      message: "Supabase schema is not ready.",
      status: 409,
    };
  }

  return {
    message: errorMessage(error),
    status: 500,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await getVacancyReport());
  } catch (error) {
    const { message, status } = reportError(error);
    return NextResponse.json({ error: "vacancy_report_failed", message }, { status });
  }
}
