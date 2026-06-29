import { NextResponse } from "next/server";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);

  if (!access.loginId && !access.hrId) {
    const loginUrl = new URL("/login", request.url);
    const { pathname, search } = new URL(request.url);
    loginUrl.searchParams.set("returnUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  if (!(await canAccess(access, "probation", "read"))) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const { searchParams } = new URL(request.url);
  const employeeHrId = searchParams.get("employeeHrId");
  const action = searchParams.get("action"); // "feedback" = open feedback panel
  const cycle = searchParams.get("cycle");

  if (resolveNavigationMode(access) === "employee-portal") {
    const dest = new URL("/employee-portals/probation", request.url);
    if (employeeHrId) dest.searchParams.set("employeeHrId", employeeHrId);
    if (action === "feedback" && employeeHrId) {
      dest.searchParams.set("feedbackEmployeeHrId", employeeHrId);
    }
    if (cycle) dest.searchParams.set("cycle", cycle);
    return NextResponse.redirect(dest);
  }

  const dest = new URL("/probation", request.url);
  if (employeeHrId) dest.searchParams.set("employeeHrId", employeeHrId);
  if (action === "feedback" && employeeHrId) {
    dest.searchParams.set("feedbackEmployeeHrId", employeeHrId);
  }
  if (cycle) dest.searchParams.set("cycle", cycle);
  return NextResponse.redirect(dest);
}
