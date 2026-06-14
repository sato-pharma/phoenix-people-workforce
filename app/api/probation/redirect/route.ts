import { NextResponse } from "next/server";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);

  if (!access.loginId && !access.hrId) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (!(await canAccess(access, "probation", "read"))) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const { searchParams } = new URL(request.url);
  const employeeHrId = searchParams.get("employeeHrId");

  if (resolveNavigationMode(access) === "employee-portal") {
    const dest = new URL("/employee-portals/probation", request.url);
    if (employeeHrId) dest.searchParams.set("employeeHrId", employeeHrId);
    return NextResponse.redirect(dest);
  }

  return NextResponse.redirect(new URL("/probation", request.url));
}
