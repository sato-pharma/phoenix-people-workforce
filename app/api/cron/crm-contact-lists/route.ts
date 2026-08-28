import { NextResponse } from "next/server";

import { bearerSecretMatches } from "@/lib/security/constant-time";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isIReports360Configured } from "@/lib/crm/config";
import { loadCrmContactSyncTargets, syncCrmContactLists } from "@/lib/crm/contacts-sync";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { writeAuditLog } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 82 agents x 3 lists ran in a few minutes on 2026-08-28, sequentially and against someone else's
// production web app. The ceiling is generous because the cost of a half-finished sweep is a
// mirror that disagrees with the CRM until tomorrow.
export const maxDuration = 800;

const JOB_NAME = "crm-contact-lists";

// Refreshes each rep's assigned doctor list from the CRM web app, daily.
//
// This is the ONLY writer of ireports360_contacts, and the only path by which Phoenix learns about
// a doctor who has been assigned to a rep but never planned and never visited — 448 of them on the
// first sweep. Everything else in the CRM mirror is built from activity and is blind to them.
//
// SAFE TO RUN TWICE, AND SAFE TO FAIL HALFWAY. Each agent is replaced independently and an agent
// whose lists all come back empty while the mirror holds rows is refused rather than emptied, so a
// vendor outage or an expired session degrades to "yesterday's list" instead of "no doctors". See
// the rule at the top of contacts-sync.ts.

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET may ONLY be bypassed on a real developer machine. `NODE_ENV` is inlined at
  // build, so every deployed build resolves this closed regardless of how the environment is
  // labelled — the hardened form, not the `!isProductionRuntime()` one it replaced across 18 routes.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized(`cron/${JOB_NAME}`, request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isIReports360Configured()) {
    return NextResponse.json(
      { error: "The iReports360 connection is not configured in this environment.", skipped: true },
      { status: 503 },
    );
  }

  try {
    const { targets, unresolved } = await loadCrmContactSyncTargets();
    const result = await syncCrmContactLists({ targets });

    // Refusals and failures are the two outcomes that mean "the mirror is older than it looks", so
    // they are named in the audit row rather than buried in a count nobody reads.
    const summary =
      `CRM contact lists refreshed — ${result.upserted} rows across ${result.agents} agents ` +
      `(${result.contacts} distinct contacts), ${result.deleted} removed` +
      (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
      (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
      (unresolved.length ? `, ${unresolved.length} with no CRM account yet` : "");

    await writeAuditLog({
      actorLoginId: null,
      entityType: "crm_contact_list_sync",
      entityId: new Date().toISOString().slice(0, 10),
      newValues: {
        agents: result.agents,
        agentsFailed: result.agentsFailed,
        agentsRefusedEmpty: result.agentsRefusedEmpty,
        contacts: result.contacts,
        deleted: result.deleted,
        failures: result.outcomes.filter((outcome) => outcome.error).map((outcome) => ({
          agentCrmId: outcome.agentCrmId,
          error: outcome.error,
          hrId: outcome.hrId,
        })),
        refused: result.outcomes.filter((outcome) => outcome.refusedEmpty).map((outcome) => outcome.hrId),
        unresolved,
        upserted: result.upserted,
      },
      summary,
    });

    return NextResponse.json(
      {
        agents: result.agents,
        agentsFailed: result.agentsFailed,
        agentsRefusedEmpty: result.agentsRefusedEmpty,
        contacts: result.contacts,
        deleted: result.deleted,
        unresolved: unresolved.length,
        upserted: result.upserted,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logError("CRM contact list sync failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "The CRM contact list sync failed.") },
      { status: 500 },
    );
  }
}
