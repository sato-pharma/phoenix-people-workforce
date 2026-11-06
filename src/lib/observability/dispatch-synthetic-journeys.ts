import { logError, logWarning } from "@/lib/observability/log";
import {
  SYNTHETIC_DISPATCH_TOKEN_UNSET,
  SYNTHETIC_DISPATCH_UNREACHABLE,
  syntheticDispatchOtherStatus,
  syntheticDispatchRefused,
} from "@/lib/observability/synthetic-dispatch-reasons";

// ─────────────────────────────────────────────────────────────────────────────
// Trigger the Synthetic Journeys workflow on GitHub Actions.
//
// WHY THIS EXISTS RATHER THAN cron-job.org CALLING GITHUB DIRECTLY.
// The workflow carries a `schedule:` trigger, but GitHub does not honour it here. Measured
// 2026-08-05: of the three scheduled workflows in this repo, the only one that fires is
// migration-drift-check (added 2026-07-20), and it lands 4.5-9h after its nominal 07:00 — never on
// time in six days. Both workflows added on 2026-08-05 (direct-orders-sweeps and
// synthetic-journeys) have never fired once. GitHub's scheduler is best-effort and this repo's own
// history shows what that means in practice.
//
// cron-job.org DOES fire on time — it already drives every /api/cron/* route in production. The
// obvious move is to point it at GitHub's workflow_dispatch endpoint, and the reason not to is the
// credential: that would put a GitHub write token into a free-tier, undocumented, third-party
// account that AGENTS.md already calls "a single point of failure no runbook mentions". Routing the
// trigger through here instead keeps the token in Railway beside the other secrets, and gives
// cron-job.org no GitHub access at all — it just calls a Phoenix cron route with the CRON_SECRET it
// already holds.
//
// The dispatch returns 204 immediately, so this route answers well inside cron-job.org's 30s
// request-timeout cap. It does NOT wait for the run to finish — a synthetic run takes ~60s, and
// waiting would risk the false `Failed (timeout)` that phoenix-notify-daily logs every morning.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = "sato-pharma";
const REPO = "phoenix-people-workforce";

/**
 * Referenced by FILENAME, not by the numeric workflow id.
 *
 * The id changes if the workflow is ever deleted and recreated; the filename does not. A stale id
 * would 404 silently on a schedule nobody is watching, which is the exact failure this whole
 * monitor exists to prevent.
 */
const WORKFLOW_FILE = "synthetic-journeys.yml";

const DISPATCH_TIMEOUT_MS = 15000;

export type SyntheticDispatchResult =
  | { dispatched: false; reason: string }
  | { dispatched: true; workflow: string; ref: string };

/**
 * Ask GitHub to run the synthetic journeys now.
 *
 * Returns `{ dispatched: false, reason }` rather than throwing when the token is absent — an
 * unconfigured deployment is a normal state, not an error, and a 500 here would train whoever reads
 * the cron log to ignore it.
 */
export async function dispatchSyntheticJourneys(ref = "main"): Promise<SyntheticDispatchResult> {
  const token = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN?.trim();
  if (!token) {
    return { dispatched: false, reason: SYNTHETIC_DISPATCH_TOKEN_UNSET };
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
  } catch (error) {
    logError("Synthetic journeys dispatch failed to reach GitHub", {
      labels: { event: "synthetic_dispatch_unreachable" },
      error,
    });
    return { dispatched: false, reason: SYNTHETIC_DISPATCH_UNREACHABLE };
  }

  // 204 No Content is success for this endpoint. Anything else is worth naming, but never with the
  // body verbatim — a GitHub error body can echo request headers back.
  if (response.status === 204) {
    return { dispatched: true, workflow: WORKFLOW_FILE, ref };
  }

  if (response.status === 401 || response.status === 403) {
    logError("Synthetic journeys dispatch was refused — check the PAT scope and expiry", {
      labels: { event: "synthetic_dispatch_forbidden" },
      error: new Error(`GitHub returned ${response.status}`),
    });
    return { dispatched: false, reason: syntheticDispatchRefused(response.status) };
  }

  logWarning("Synthetic journeys dispatch returned an unexpected status", {
    labels: { event: "synthetic_dispatch_unexpected_status" },
    error: new Error(`GitHub returned ${response.status}`),
  });
  return { dispatched: false, reason: syntheticDispatchOtherStatus(response.status) };
}
