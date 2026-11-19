import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { getSalaryFlags, resolveSalaryFlag } from "@/lib/admin/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Resolve button sends `{ id, showResolved }`. `salary_flags.id` is a bigint, so PostgREST hands the
 * screen a NUMBER and the screen sends it back as one; a string id is accepted too. A missing or empty
 * id still reaches the route's own "Missing flag id." answer.
 */
const SalaryFlagResolveBodySchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  showResolved: z.boolean().nullish(),
});

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!await canAccess(access, "admin", "read")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }
    const url = new URL(request.url);
    const showResolved = url.searchParams.get("showResolved") === "true";
    const result = await getSalaryFlags(showResolved, { withNames: true });
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load salary flags.") },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!await canAccess(access, "admin", "update")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const parsed = await parseJsonBody(request, SalaryFlagResolveBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
    if (!body.id) {
      return NextResponse.json({ message: "Missing flag id." }, { status: 400 });
    }

    const resolvedBy = access.loginId ?? "system";
    await resolveSalaryFlag(String(body.id), resolvedBy);

    await writeAuditLog({
      actorLoginId: access.loginId,
      entityId: String(body.id),
      entityType: "salary_flag",
      summary: `Salary flag #${body.id} resolved by ${resolvedBy}`,
    }).catch(() => undefined);

    // Re-read the list the screen is SHOWING. This used to re-read the unresolved list whatever the
    // "Show resolved" toggle said, so resolving one flag silently switched the toggle's list back.
    const updated = await getSalaryFlags(body.showResolved === true, { withNames: true });
    return NextResponse.json(updated);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to resolve salary flag.") },
      { status: 500 },
    );
  }
}
