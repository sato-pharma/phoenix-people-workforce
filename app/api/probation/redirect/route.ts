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

  // `action=feedback` and `cycle` were read here until 2026-09-01. They deep-linked into the legacy
  // per-cycle feedback panel, which was retired because employee_probation — the table behind it —
  // has held zero rows since the Case model took over provisioning, so the panel could only ever
  // answer "not eligible". Older notification rows may still carry both params; they are ignored
  // rather than rejected, so an existing link still lands the recipient on their probation view.
  // That view is the correct destination now: it lists their open DV feedback tasks.

  if (resolveNavigationMode(access) === "employee-portal") {
    const dest = new URL("/employee-portals/probation", request.url);
    if (employeeHrId) dest.searchParams.set("employeeHrId", employeeHrId);
    return NextResponse.redirect(dest);
  }

  const dest = new URL("/probation", request.url);
  if (employeeHrId) dest.searchParams.set("employeeHrId", employeeHrId);
  return NextResponse.redirect(dest);
}
