import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG } from "@/lib/crm/contact-lists";
import { isIReports360Configured } from "@/lib/crm/config";
import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";
import { contactMasterRefreshIncludesActivity, refreshCrmContactMaster } from "@/lib/crm/contact-master";
import {
  CONTACT_SYNC_SLICE_COUNT,
  contactSyncSliceForDate,
  contactSyncSliceRefreshedNothing,
  loadCrmContactSyncTargets,
  selectContactSyncSlice,
  syncCrmContactLists,
} from "@/lib/crm/contacts-sync";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { writeAuditLog } from "@/lib/admin/audit";
import { assertCronAuthorized } from "@/lib/security/cron-auth";
import { refuseOnPageServer } from "@/lib/platform/worker-only-route";

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
  const wrongProcess = refuseOnPageServer("cron/crm-contact-lists");
  if (wrongProcess) return wrongProcess;

  // THE CRM CUTOVER. Once iReports360 is retired there is no vendor list to scrape, so the job stands
  // down — before the dead-man's switch and the configuration check, which would otherwise page every
  // morning about a connection that is gone on purpose (docs/crm-cutover-runbook.md).
  const standDown = await resolveVendorSyncStandDown();
  if (standDown) return NextResponse.json({ reason: standDown, skipped: true });

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

    // THE CONTACT MASTER FOLLOWS THE MIRROR. These rows are the only signal that a doctor joined or
    // left a list, and the master's dated assignments are built from them, so the master is rebuilt
    // right after the slice that changed them. It never throws: a failure is named in the audit row
    // and the sync still answers 200, because the mirror rows ARE written.
    const contactMaster = await refreshCrmContactMaster({
      includeActivity: contactMasterRefreshIncludesActivity({ slice, sliceOf }),
    });
    if (contactMaster.status === "failed") {
      logError("crm-contact-lists: contact master refresh failed", {
        error: contactMaster.error,
        labels: { event: "contact_master_refresh_failed", job: JOB_NAME },
      });
    }

    // THE LISTS JUST MOVED, SO THE CACHED PICKER COUNTS ARE NOW WRONG. getDoctorListRepSummaries
    // caches its summary rows for 300s (contact-lists.ts) and reads the master's open assignments,
    // so the tag is busted AFTER the master refresh — busting it before would let a board re-cache
    // the pre-refresh counts for another five minutes. Wrapped because a revalidate failure must
    // never turn a SUCCESSFUL sync into a 500: the rows are written, and the TTL is the fallback.
    try {
      revalidateTag(CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG, "max");
    } catch (error) {
      logError("crm-contact-lists: cache revalidation failed", {
        error,
        labels: { event: "cache_revalidate_failed", job: JOB_NAME },
      });
    }

    // Refusals and failures are the two outcomes that mean "the mirror is older than it looks", so
    // they are named in the audit row rather than buried in a count nobody reads. `skipped` is the
    // third: it means the tick ran out of time, and the agents behind it wait a whole day.
    const summary =
      `CRM contact lists refreshed (slice ${slice + 1}/${sliceOf}) — ${result.upserted} rows across ` +
      `${result.agents} agents (${result.contacts} distinct contacts), ${result.deleted} removed` +
      (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
      (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
      (result.skipped ? `, ${result.skipped} out of time` : "") +
      (unresolved.length ? `, ${unresolved.length} with no CRM account yet` : "") +
      (contactMaster.status === "failed"
        ? ", contact master refresh FAILED"
        : contactMaster.status === "not_provisioned"
          ? ", contact master not provisioned"
          : "");

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
        contactMaster:
          contactMaster.status === "refreshed" ? { status: contactMaster.status, ...contactMaster.result } : contactMaster,
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

    // A FAILED MASTER REFRESH FAILS THE PING. The direct-order venue picker and its write check read
    // the master, not the mirror, so a refresh that fails every day leaves them serving a frozen
    // list — a handed-over doctor stays in the old manager's picker — while the mirror looks fresh.
    // The audit row alone would say so to nobody. `not_provisioned` is the expected state between a
    // deploy and the migration, and stays green.
    await pingDeadMansSwitch(
      JOB_SLUG,
      // `result.agents` counts ATTEMPTED agents, so `=== 0` alone never caught the very shape the
      // doc comment above names — "a vendor session that rejects every agent". That tick pinged
      // SUCCESS while the mirror rotted. `contactSyncSliceRefreshedNothing` is the shared predicate
      // with the poller; partial degradation still stays green, exactly as before.
      contactSyncSliceRefreshedNothing(result) || contactMaster.status === "failed" ? "fail" : "success",
      `slice ${slice + 1}/${sliceOf}: ${result.agents} agent(s) attempted, ${result.upserted} row(s) upserted` +
        (result.agentsRefusedEmpty ? `, ${result.agentsRefusedEmpty} kept unchanged (empty answer)` : "") +
        (result.agentsFailed ? `, ${result.agentsFailed} failed` : "") +
        (result.skipped ? `, ${result.skipped} out of time` : "") +
        (contactMaster.status === "failed" ? `, contact master refresh FAILED: ${contactMaster.error}` : ""),
    );

    return NextResponse.json(
      {
        agents: result.agents,
        agentsFailed: result.agentsFailed,
        agentsRefusedEmpty: result.agentsRefusedEmpty,
        agentsSkipped: result.skipped,
        contactMaster: contactMaster.status,
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
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "The CRM contact list sync failed.") },
      { status: 500 },
    );
  }
}
