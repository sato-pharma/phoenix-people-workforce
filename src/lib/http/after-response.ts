import { after } from "next/server";

import { logError } from "@/lib/observability/log";

/**
 * Run work the caller's answer does not depend on AFTER the response has gone, so the person who
 * pressed Save never waits for it.
 *
 * WHY (2026-10-16 Phoenix CRM performance audit). A plan submit, a list request, a validation, a day
 * start and twenty-odd other writes held the HTTP reply open while every notice was delivered — one
 * recipient after another, eleven to twenty database steps each, plus the Telegram and phone calls —
 * although the sender already swallowed its own failures, so the reply could never depend on it.
 * A plan submit measured 975 ms on production that afternoon.
 *
 * Inside a request (a route handler, a server action, a page render) the task is handed to Next's
 * `after()`, which runs it once the response has closed. The long-lived Railway process completes it;
 * a crash between the reply and the task loses that one task, which is the trade every caller here
 * already made by swallowing its errors.
 *
 * Outside a request scope — a cron's own loop past its response, a script, the unit suite — `after()`
 * throws, and the task is simply awaited here, exactly as every caller did before.
 *
 * ONLY for work whose failure the caller already ignores: a failure is logged under `label` and never
 * thrown, in either mode. Next runs every queued `after()` task at once, so a loop of thousands belongs
 * in the worker, not here.
 */
export async function afterResponse(label: string, task: () => Promise<unknown>): Promise<void> {
  const guarded = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      logError("Work deferred past the response failed", {
        labels: { event: "after_response_failed", label },
        error,
      });
    }
  };
  try {
    after(guarded);
    return;
  } catch {
    // Outside a request scope: run it now, as before.
  }
  await guarded();
}
