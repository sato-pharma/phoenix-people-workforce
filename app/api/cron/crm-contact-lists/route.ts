import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isIReports360Configured } from "@/lib/crm/config";
import {
  CONTACT_SYNC_SLICE_COUNT,
  contactSyncSliceForDate,
  loadCrmContactSyncTargets,
  selectContactSyncSlice,
  syncCrmContactLists,
} from "@/lib/crm/contacts-sync";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { writeAuditLog } from "@/lib/admin/audit";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full sweep is 82 agents x 3 vendor pages, ~156 seconds. One slice is a twelfth of that. The
// ceiling stays generous for the `?all=1` backfill, which is run by hand and not by the scheduler.
export const maxDuration = 800;

const JOB_NAME = "crm-contact-lists";
const JOB_SLUG = "phoenix-crm-contact-lists";

/**
 * WHAT THE DEAD-MAN'S SWITCH TREATS AS A FAILURE HERE, and why it is not everything it could be.
 *
 * Pinged directly rather than through `withDeadMansSwitch` because this route catches its error
 * and answers 500 without throwing — the wrapper would report a false success on the one outcome
 * worth catching.
 *
 * It pings /fail on three things only: the connection being unconfigured, an exception, and a tick
 * that refreshed NO agent at all. That last one is the shape that matters — a roster read that
 * comes back empty, or a vendor session that rejects every agent, leaves the mirror rotting while
 * the job returns 200 twelve times a day.
 *
 * It deliberately does NOT fail on partial degradation. `agentsRefusedEmpty` is the designed
 * safety (an agent whose lists come back empty keeps yesterday's rows rather than being emptied),
 * and a handful of `agentsFailed` or `skipped` is an ordinary vendor hiccup on one twelfth of the
 * roster. Twelve ticks a day means anything flappy here pages daily until it is muted, and a muted
 * check is worth less than no check. Those counts are carried in the ping DETAIL on every tick, so
 * they are visible to anyone reading the check, and the per-tick audit row remains the record.
 */

/**
 * How long this handler may spend fetching before it stops starting new agents.
 *
 * cron-job.org cuts every request at 30 seconds — a platform cap that ignores the per-job
 * `requestTimeout`, measured 2026-08-28 at `ms=30108` against a job set to 300. The handler DOES
 * keep running past the cut and finishes (see contacts-sync.ts), so the budget is not protecting
 * the data; it is protecting the REPORT. 21 seconds leaves room for the roster read, the vendor
 * login and the audit write inside the cap, so the scheduler records a real answer with a readable
 * body instead of a permanent timeout nobody reads. Measured on production: 8-10s for a full tick.
 */
const SLICE_BUDGET_MS = 21_000;

// Refreshes each rep's assigned doctor list from the CRM web app — a twelfth of the roster per
// call, twelve calls five minutes apart, once a day.
//
// This is the ONLY writer of ireports360_contacts, and the only path by which Phoenix learns about
// a doctor who has been assigned to a rep but never planned and never visited — 448 of them on the
// first sweep. Everything else in the CRM mirror is built from activity and is blind to them.
//
// THE SCHEDULE AND THE SLICE COUNT ARE ONE DESIGN, NOT TWO SETTINGS. The route reads the Cairo
// minute and serves the matching twelfth, so the cron entry must fire every 5 minutes across a
// single whole hour — currently 05:00-05:55 Africa/Cairo. Firing it hourly, or on the half hour,
// sweeps the same twelfth over and over and quietly abandons the other eleven.
//
// SAFE TO RUN TWICE, AND SAFE TO FAIL HALFWAY. Each agent is replaced independently and an agent
// whose lists all come back empty while the mirror holds rows is refused rather than emptied, so a
// vendor outage or an expired session degrades to "yesterday's list" instead of "no doctors". See
// the rule at the top of contacts-sync.ts.

export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/crm-contact-lists");
  if (denied) return denied;

  if (!isIReports360Configured()) {
    await pingDeadMansSwitch(JOB_SLUG, "fail", "iReports360 is not configured — the contact mirror is not being refreshed");
    return NextResponse.json(
      { error: "The iReports360 connection is not configured in this environment.", skipped: true },
      { status: 503 },
    );
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  // `?all=1` sweeps the whole roster in one request. That is the by-hand backfill path — it takes
  // about 156 seconds and the scheduler would cut it at 30, so nothing automated may ask for it.
  const sweepAll = url.searchParams.get("all") === "1";
  const sliceOf = sweepAll ? 1 : CONTACT_SYNC_SLICE_COUNT;
  // An explicit ?slice= exists so a missed tick can be re-run on demand and so the partition can be
  // exercised without waiting for a clock. Unattended, the slice comes from the Cairo minute.
  //
  // The presence of the parameter is tested on the RAW string, never on Number(): searchParams.get
  // returns null when it is absent and `Number(null)` is 0, which would silently pin every single
  // tick to slice 1 and leave eleven twelfths of the roster never swept — a job that runs green
  // forever while the mirror rots.
  const rawSlice = url.searchParams.get("slice");
  const requestedSlice = rawSlice === null || rawSlice.trim() === "" ? Number.NaN : Number(rawSlice);
  const slice = sweepAll
    ? 0
    : Number.isInteger(requestedSlice)
      ? ((requestedSlice % sliceOf) + sliceOf) % sliceOf
      : contactSyncSliceForDate(new Date());

  try {
    const { targets, unresolved } = await loadCrmContactSyncTargets();
    const sliceTargets = selectContactSyncSlice(targets, slice, sliceOf);
    const result = await syncCrmContactLists({
      deadlineAt: sweepAll ? undefined : startedAt + SLICE_BUDGET_MS,
      targets: sliceTargets,
    });

    // Refusals and failures are the two outcomes that mean "the mirror is older than it looks", so
    // they are named in the audit row rather than buried in a count nobody reads. `skipped` is the
    // third: it means the tick ran out of time, and the agents behind it wait a whole day.
    const summary =
      `CRM contact lists refreshed (slice ${slice + 1}/${sliceOf}) — ${result.upserted} rows across ` +
      `${result.agents} agents (${result.contacts} distinct contacts), ${result.deleted} removed` +
      (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
      (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
      (result.skipped ? `, ${result.skipped} out of time` : "") +
      (unresolved.length ? `, ${unresolved.length} with no CRM account yet` : "");

    await writeAuditLog({
      actorLoginId: null,
      entityType: "crm_contact_list_sync",
      // One row per tick, not one per day: twelve ticks that each say what they did is the only way
      // to see WHICH twelfth of the roster went stale when one of them starts failing.
      entityId: `${new Date().toISOString().slice(0, 10)}#${slice + 1}of${sliceOf}`,
      newValues: {
        agents: result.agents,
        agentsFailed: result.agentsFailed,
        agentsRefusedEmpty: result.agentsRefusedEmpty,
        agentsSkipped: result.skipped,
        contacts: result.contacts,
        deleted: result.deleted,
        durationMs: Date.now() - startedAt,
        failures: result.outcomes.filter((outcome) => outcome.error).map((outcome) => ({
          agentCrmId: outcome.agentCrmId,
          error: outcome.error,
          hrId: outcome.hrId,
        })),
        refused: result.outcomes.filter((outcome) => outcome.refusedEmpty).map((outcome) => outcome.hrId),
        slice: slice + 1,
        sliceOf,
        unresolved,
        upserted: result.upserted,
      },
      summary,
    });

    await pingDeadMansSwitch(
      JOB_SLUG,
      result.agents === 0 ? "fail" : "success",
      `slice ${slice + 1}/${sliceOf}: ${result.agents} agent(s) refreshed, ${result.upserted} row(s) upserted` +
        (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
        (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
        (result.skipped ? `, ${result.skipped} out of time` : ""),
    );

    return NextResponse.json(
      {
        agents: result.agents,
        agentsFailed: result.agentsFailed,
        agentsRefusedEmpty: result.agentsRefusedEmpty,
        agentsSkipped: result.skipped,
        contacts: result.contacts,
        deleted: result.deleted,
        durationMs: Date.now() - startedAt,
        rosterSize: targets.length,
        slice: slice + 1,
        sliceOf,
        unresolved: unresolved.length,
        upserted: result.upserted,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logError("CRM contact list sync failed", { error, labels: { event: "cron_failed", job: JOB_NAME } });
    await pingDeadMansSwitch(JOB_SLUG, "fail", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "The CRM contact list sync failed.") },
      { status: 500 },
    );
  }
}
