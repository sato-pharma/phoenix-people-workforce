import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getScopedVacancyReport } from "@/lib/reports/organogram";
import {
  errorMessage,
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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "vacancies", "read");

    const report = await getScopedVacancyReport(access);

    if (report.diagnostic?.code === "vacancy_scope_denied") {
      return NextResponse.json(
        { error: "forbidden", message: report.diagnostic.message },
        { status: 403 },
      );
    }

    if (report.diagnostic?.code === "line_unresolved" || report.diagnostic?.code === "team_unresolved") {
      return NextResponse.json(
        { error: "vacancy_scope_missing", message: report.diagnostic.message },
        { status: 409 },
      );
    }

    return NextResponse.json(report);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to vacancy reports." }, { status: 403 });
    }

    const { message, status } = reportError(error);
    return NextResponse.json({ error: "vacancy_report_failed", message }, { status });
  }
}
