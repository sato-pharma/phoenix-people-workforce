// Which kind of server process this is: the one that answers pages, the one that runs the background
// jobs, or (as before 2026-10-16) both at once.
//
// WHY THIS EXISTS. Phoenix ran as ONE Railway process that answered every page AND ran the iReports360
// live poller, its hourly doctor-list scrape, the Early Birds close and CRM housekeeping. Node has one
// thread for JavaScript, so while a job did heavy work no page could move. Measured on production
// 2026-10-16 from the per-minute process-health line: three 4.3-second freezes in three and a half hours,
// each straight after the biggest slice of the doctor-list scrape, and every user waited through them.
// A second Railway service runs the same image with PHOENIX_PROCESS_ROLE=worker and does that work; the
// page server runs with PHOENIX_PROCESS_ROLE=web and starts none of it.
//
// Import-free on purpose: instrumentation.ts and the scheduler guards read it, and instrumentation is
// bundled for the edge runtime too.

export type ProcessRole = "all" | "web" | "worker";

const ROLES: readonly ProcessRole[] = ["all", "web", "worker"];

/**
 * The role named by PHOENIX_PROCESS_ROLE. Unset means "all" — exactly the behaviour before the split, so a
 * deploy of this code changes nothing until the variable is set. A value that is not a role also reads as
 * "all": a typo must never be the reason the background jobs stop, and a doubled job is caught by the
 * log line below where a missing one is silent.
 */
export function resolveProcessRole(value: string | undefined): ProcessRole {
  const role = String(value ?? "").trim().toLowerCase();
  return (ROLES as readonly string[]).includes(role) ? (role as ProcessRole) : "all";
}

/** Was PHOENIX_PROCESS_ROLE set to something that is not a role? Said once at boot, never silent. */
export function isUnrecognisedProcessRole(value: string | undefined): boolean {
  const role = String(value ?? "").trim().toLowerCase();
  return role !== "" && !(ROLES as readonly string[]).includes(role);
}

/** Does a process of this role run the in-process background schedulers? */
export function runsBackgroundJobs(role: ProcessRole): boolean {
  return role !== "web";
}

/** Why this process must not start a background scheduler, or null when it may. */
export function processRoleRefusal(value: string | undefined = process.env.PHOENIX_PROCESS_ROLE): string | null {
  return runsBackgroundJobs(resolveProcessRole(value))
    ? null
    : "PHOENIX_PROCESS_ROLE is 'web' — the worker service runs the background jobs";
}

/**
 * The answer a WORKER-ONLY cron route gives when it is called on the page server, or null where it may
 * run (23 Oct 2026 audit, F-04).
 *
 * The heavy cron routes (the notification drain, the inbound intake, the careers-mailbox poll and the
 * CRM contact lists) are called on the worker's address. Nothing stopped the same request — a
 * cron-job.org job left on, or moved back to, the website's address — from running the whole job on
 * the page server, freezing every page while it ran: the exact thing the worker split exists to stop.
 * Refused LOUDLY (503), so the scheduler shows the job red and its dead-man's switch goes quiet,
 * instead of quietly doing the work in the wrong place. "all" (role unset) still runs it, as before.
 */
export function workerOnlyRouteRefusal(
  job: string,
  value: string | undefined = process.env.PHOENIX_PROCESS_ROLE,
): { body: { error: "wrong_process"; job: string; message: string }; status: 503 } | null {
  if (runsBackgroundJobs(resolveProcessRole(value))) return null;
  return {
    body: {
      error: "wrong_process",
      job,
      message: "This job runs on the worker service, not the page server. Point the scheduler at the worker's address.",
    },
    status: 503,
  };
}
