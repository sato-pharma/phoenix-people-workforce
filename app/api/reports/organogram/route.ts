import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  canAccessCompanyOrganogram,
  getOrganogramReport,
  isPortalOrganogramRole,
  resolveOrganogramLineForEmployee,
} from "@/lib/reports/organogram";
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
    await assertPermission(access, "organogram", "read");

    if (canAccessCompanyOrganogram(access)) {
      return NextResponse.json(await getOrganogramReport(access, { mode: "company" }));
    }

    if (!isPortalOrganogramRole(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "Organogram portal access is currently limited to National Sales Managers." },
        { status: 403 },
      );
    }

    const lineName = await resolveOrganogramLineForEmployee(access);
    if (!lineName) {
      return NextResponse.json(
        { error: "organogram_scope_missing", message: "Unable to resolve your Organogram line scope." },
        { status: 409 },
      );
    }

    return NextResponse.json(await getOrganogramReport(access, { lineName, mode: "line" }));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to organogram reports." },
        { status: 403 },
      );
    }

    const { message, status } = reportError(error);
    return NextResponse.json({ error: "organogram_report_failed", message }, { status });
  }
}
