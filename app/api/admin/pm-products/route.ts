import { NextResponse } from "next/server";

import type { PhoenixRole } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import {
  listPmProductAssignments,
  listPmProductOptions,
  setPmProductCodes,
} from "@/lib/employee-360/pm-products";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read: Super Admin, CEO, SFE Manager. Write: Super Admin only (owner decision).
const READ_ROLES = new Set<PhoenixRole>(["Super Admin", "CEO", "SFE Manager"]);

export async function GET(request: Request) {
  let role: PhoenixRole | null = null;
  try {
    role = (await resolveAccessContext(request)).role;
  } catch {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (!role || !READ_ROLES.has(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const [rows, options, assignments] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: false }),
    listPmProductOptions(),
    listPmProductAssignments(),
  ]);
  const pms = rows
    .filter((r) => resolveEmployee360RoleCategory(r.jobTitle ?? r.positionTitle) === "product-manager")
    .map((r) => ({
      hrId: r.hrId,
      name: r.displayName || r.fullName,
      jobTitle: r.jobTitle,
      line: r.lineName,
      codes: assignments.get(canonicalHrIdKey(r.hrId) ?? "") ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ canEdit: role === "Super Admin", pms, options });
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await resolveAccessContext(request);
  } catch {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (ctx.role !== "Super Admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { hrId?: string; productCodes?: string[] } | null;
  if (!body?.hrId || !Array.isArray(body.productCodes)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    await setPmProductCodes(body.hrId, body.productCodes, ctx.hrId ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : "save_failed";
    // Surface the "table not migrated yet" case clearly.
    return NextResponse.json({ error: "save_failed", message }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
