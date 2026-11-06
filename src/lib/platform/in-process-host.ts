import { processRoleRefusal } from "@/lib/platform/process-role";

/**
 * THE HOST GUARDS FOR AN IN-PROCESS SCHEDULED WRITER — why this process must not run one at all, or
 * null when it may. The Early Birds fortnight close (src/lib/early-birds/close-scheduler.ts) and the
 * CRM housekeeping timer (src/lib/crm/housekeeping-scheduler.ts) both start only when this answers
 * null.
 *
 * These lived in the iReports360 live poller until the vendor was retired (6 November 2026); the
 * poller went with it, and the two timers that shared its guards kept them here, unchanged.
 *  - PHOENIX_LIVE_CRM_POLL must be exactly "true" (the Railway-only opt-in switch; NOT in any
 *    .env file in this repo, so a dev machine — whose .env.local points at PRODUCTION Supabase —
 *    can never start a second writer against prod). Its name is historical: it no longer starts
 *    any CRM poll, and removing it stops the Early Birds close and the probation double-visit capture;
 *  - a production Next.js build (`next dev` is excluded even if someone exports the flag);
 *  - RAILWAY_ENVIRONMENT_NAME === "production" (belt-and-braces host pin);
 *  - and this is not the PAGE server (PHOENIX_PROCESS_ROLE=web): background work runs on the worker
 *    service, because work done here freezes every page while it runs (src/lib/platform/process-role.ts).
 */
export function resolveInProcessHostRefusal(): string | null {
  const roleRefusal = processRoleRefusal();
  if (roleRefusal) return roleRefusal;
  if (process.env.PHOENIX_LIVE_CRM_POLL !== "true") return "PHOENIX_LIVE_CRM_POLL is not 'true'";
  if (process.env.NODE_ENV !== "production") return "not a production build";
  if (process.env.RAILWAY_ENVIRONMENT_NAME !== "production") return "RAILWAY_ENVIRONMENT_NAME is not 'production'";
  return null;
}

/** Timers must never hold the process open (deploy shutdowns, tests) — but in a DOM-typed
 * bundle setTimeout's return type is a number, so reach for unref only when it exists. */
export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}
