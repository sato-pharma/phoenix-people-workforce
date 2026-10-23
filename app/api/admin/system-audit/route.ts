import { NextResponse, type NextRequest } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { listAuditModuleLabels, lookupAuditPeople } from "@/lib/system-audit/incidents-lookup";
import { isSystemAuditQueryError, parseSystemAuditQuery } from "@/lib/system-audit/page-query";
import { loadSystemAuditPage } from "@/lib/system-audit/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Incidents tab's refetch — Super Admin only (the System Audit page is his alone).
 *
 *   ?view=page (default) + the filters  → one screen page (50 rows) of system_audit_page
 *   ?view=people&q=<name or HR ID>       → the people the ledger has recorded, for the person filter
 *   ?view=modules&from&to&test           → the distinct sidebar modules in the period
 *
 * A filter value it does not recognise is a 400 with a plain sentence. A read that fails is a 500
 * that says "Unavailable — <reason>": the page shows that, never an empty table that would read as
 * "no errors".
 */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit");

    const params = new URL(request.url).searchParams;
    const view = params.get("view") ?? "page";

    if (view === "people") {
      const people = await lookupAuditPeople(params.get("q") ?? "");
      return NextResponse.json({ people }, { headers: { "cache-control": "no-store" } });
    }

    const query = parseSystemAuditQuery(params);

    if (view === "modules") {
      const modules = await listAuditModuleLabels({
        from: query.filters.from,
        to: query.filters.to,
        includeTest: query.filters.includeTest,
      });
      return NextResponse.json({ labels: modules.labels }, { headers: { "cache-control": "no-store" } });
    }

    if (view !== "page") {
      return NextResponse.json(
        { error: "invalid_query", message: `"${view}" is not a view this route serves.` },
        { status: 400 },
      );
    }

    const page = await loadSystemAuditPage({
      filters: query.filters,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
    return NextResponse.json({ page, query }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isSystemAuditQueryError(error)) {
      return NextResponse.json({ error: "invalid_query", message: error.message }, { status: 400 });
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const reason = clientSafeErrorMessage(error, "the ledger did not answer");
    return NextResponse.json({ error: "unavailable", message: `Unavailable — ${reason}` }, { status: 500 });
  }
}
