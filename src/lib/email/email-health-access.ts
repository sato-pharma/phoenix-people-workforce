import { canAccessSystemAdministratorWorkspace, type AccessContext } from "@/lib/auth/permissions";

/**
 * Who may read the FULL email health report at `/api/health/email`.
 *
 * The address is public so an uptime monitor can poll it with no credential, and the HTTP status
 * (200 healthy, 503 degraded) is all a monitor needs. The detail is not for the internet: which
 * mail variables are missing, whether production mail is diverted to the test inboxes, and the
 * provider failover chain and per-module sending accounts are a map of how the email side is
 * wired. So the full body goes only to:
 *
 *   - the cron secret (`Authorization: Bearer <CRON_SECRET>`), for scripts and scheduled checks;
 *   - a signed-in system administrator (Super Admin), for a look from the browser.
 *
 * Everyone else gets `{ status, timestamp }` with the same status code.
 *
 * The cron check runs ONLY when the request carries an Authorization header: the guard logs every
 * refusal as an unauthorized cron call, and an anonymous monitor poll is not one.
 */
export type EmailHealthAccessDeps = {
  /** True when the request carries the cron secret. */
  cronAuthorized: (request: Request) => boolean;
  /** The caller's access context; the anonymous guest context when nobody is signed in. */
  resolveAccess: (request: Request) => Promise<Pick<AccessContext, "role" | "scope">>;
};

export async function callerMayReadEmailHealthDetail(
  request: Request,
  deps: EmailHealthAccessDeps,
): Promise<boolean> {
  if (request.headers.get("authorization")?.trim()) {
    if (deps.cronAuthorized(request)) return true;
  }
  try {
    return canAccessSystemAdministratorWorkspace(await deps.resolveAccess(request));
  } catch {
    // A session that cannot be resolved (expired, revoked, a write guard) is not an administrator.
    return false;
  }
}

/** The whole answer an anonymous caller receives: the verdict and when it was taken, nothing else. */
export function publicEmailHealthBody(report: { status: string; timestamp: string }) {
  return { status: report.status, timestamp: report.timestamp };
}
