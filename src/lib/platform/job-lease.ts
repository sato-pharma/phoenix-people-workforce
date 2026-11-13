// A database lease that lets exactly ONE process run a singleton background loop at a time.
//
// WHY (23 Oct 2026 audit, P5-05). The iReports360 live poller is a module-level singleton, which keeps
// it to one copy PER PROCESS — but nothing stopped two processes from each running one: the old and the
// new container overlap during every deploy, and the worker has a standby. Two pollers mean two
// vendor sessions, every deep run twice, and two writers racing on the same CRM tables. The lease is a
// row in public.job_leases that a process claims (and keeps renewing); a process that cannot claim it
// skips its tick, and takes over once the holder stops renewing and the lease runs out.
//
// IT CAN NEVER STOP THE POLLER BY ITSELF. Until migration 20261023140000_job_leases.sql is applied the
// claim function does not exist, and every claim then answers "held" — exactly today's behaviour,
// said once in the log. The same is true of any other error reading the lease: a lease that cannot be
// read is not allowed to be the reason the CRM goes stale. Only a definite "another holder has it"
// skips a tick.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { logError, logInfo } from "@/lib/observability/log";

export const JOB_LEASE_CLAIM_RPC = "claim_job_lease";

export type JobLeaseClaim =
  | { held: true; reason: "acquired" | "renewed" }
  | { held: true; reason: "lease_unavailable"; detail: string }
  | { held: false; reason: "held_elsewhere"; holder: string; expiresAt: string | null };

export type JobLeaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

/** One id per process, readable in the table: host, pid and a random tail (two containers can share a pid). */
export function newJobLeaseHolderId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Claims or renews `jobKey` for `holder` for `ttlSeconds`. Never throws. The previous claim's holder is
 * passed so a renewal is reported as one.
 */
export async function claimJobLease(
  client: JobLeaseRpcClient,
  input: { holder: string; jobKey: string; ttlSeconds: number; wasHeld?: boolean },
): Promise<JobLeaseClaim> {
  try {
    const { data, error } = await client.rpc(JOB_LEASE_CLAIM_RPC, {
      p_holder: input.holder,
      p_job_key: input.jobKey,
      p_ttl_seconds: input.ttlSeconds,
    });
    if (error) return { detail: `${error.code ?? "error"}: ${error.message ?? "unknown"}`, held: true, reason: "lease_unavailable" };
    const row = (Array.isArray(data) ? data[0] : data) as { expires_at?: unknown; held?: unknown; holder?: unknown } | null | undefined;
    if (!row || typeof row.held !== "boolean") {
      return { detail: "the claim returned no answer", held: true, reason: "lease_unavailable" };
    }
    if (row.held) return { held: true, reason: input.wasHeld ? "renewed" : "acquired" };
    return {
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
      held: false,
      holder: typeof row.holder === "string" ? row.holder : "another process",
      reason: "held_elsewhere",
    };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), held: true, reason: "lease_unavailable" };
  }
}

/**
 * The poller's view of one lease: `ensure()` before each tick, `renew()` on a heartbeat, `release()`
 * is not needed (an unrenewed lease runs out in `ttlSeconds`). Logs each change of hands once, and the
 * fail-open "lease unavailable" once per process.
 */
export function createJobLeaseKeeper(input: {
  client: () => JobLeaseRpcClient;
  holder?: string;
  jobKey: string;
  ttlSeconds: number;
}) {
  const holder = input.holder ?? newJobLeaseHolderId();
  let held = false;
  let loggedUnavailable = false;
  let lastOutcome: "held" | "elsewhere" | null = null;

  async function claim(): Promise<boolean> {
    const result = await claimJobLease(input.client(), { holder, jobKey: input.jobKey, ttlSeconds: input.ttlSeconds, wasHeld: held });
    if (result.reason === "lease_unavailable") {
      if (!loggedUnavailable) {
        loggedUnavailable = true;
        logError("Job lease could not be read — running without it (as before the lease existed)", {
          labels: { detail: result.detail, event: "job_lease_unavailable", job: input.jobKey },
        });
      }
      held = true;
      return true;
    }
    held = result.held;
    const outcome = result.held ? "held" : "elsewhere";
    if (outcome !== lastOutcome) {
      lastOutcome = outcome;
      logInfo(result.held ? "Job lease held by this process" : "Job lease held by another process — this one stands by", {
        labels: {
          event: result.held ? "job_lease_held" : "job_lease_standby",
          holder: result.held ? holder : result.holder,
          job: input.jobKey,
        },
      });
    }
    return held;
  }

  return {
    /** Claim or renew before running; false means another live process holds it — skip this run. */
    ensure: claim,
    holder,
    isHeld: () => held,
    /** Heartbeat: renew only while this process holds it, so a long run never lets the lease lapse. */
    async renew(): Promise<void> {
      if (held) await claim();
    },
  };
}

/**
 * Hands a lease back early: re-claims it for its own holder with the shortest ttl the claim allows (one
 * second), so the next run anywhere takes it at once instead of waiting out the full ttl. The claim only
 * touches a row this holder still owns (or one that has already run out), so it can never cut short a
 * lease another process has since taken. Never throws — an unreleased lease simply runs out.
 */
export async function releaseJobLease(client: JobLeaseRpcClient, input: { holder: string; jobKey: string }): Promise<void> {
  await claimJobLease(client, { holder: input.holder, jobKey: input.jobKey, ttlSeconds: 1, wasHeld: true });
}

/** The client factory itself can throw (no service key in this process): that is "lease unavailable" too. */
function clientOrUnavailable(client: () => JobLeaseRpcClient): JobLeaseRpcClient {
  try {
    return client();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { rpc: () => Promise.resolve({ data: null, error: { code: "client_unavailable", message: detail } }) };
  }
}

export type ExclusiveRunEntry =
  | { entered: true; release: () => Promise<void>; via: "lease" | "process" }
  | { entered: false; heldBy: string | null; inFlightForMs: number | null; via: "lease" | "process" };

/**
 * ONE RUN AT A TIME ACROSS EVERY INSTANCE, for a job a cron fires on a timer (REC-083).
 *
 * A module variable only ever kept a run to one copy PER PROCESS: the deploy overlap, a second instance
 * or a restarted container each ran their own. `enter()` now claims a database lease (one row in
 * public.job_leases, a fresh holder per run) before the work starts and `release()` hands it back when
 * it ends; a run that cannot claim it is skipped as an overlap. A run killed mid-flight is replaced
 * once its lease runs out (`ttlMs`) — the same self-healing the timestamp guard had.
 *
 * THE LEASE CAN NEVER STOP THE JOB BY ITSELF. When the lease cannot be read (database unreachable, the
 * claim function missing) the run falls back to the in-process guard this replaced — still kept, and
 * still checked first, so a second run in the SAME process never costs a query. Only a definite "another
 * live run holds it" skips across instances.
 */
export function createExclusiveRunGuard(input: {
  client: () => JobLeaseRpcClient;
  jobKey: string;
  newHolder?: () => string;
  /** Called once when the lease becomes unreadable and again when it is back (`detail` is null then). */
  onLeaseAvailability?: (detail: string | null) => void;
  ttlMs: number;
}) {
  const ttlSeconds = Math.min(3600, Math.max(1, Math.ceil(input.ttlMs / 1000)));
  // This process's own run, as the old guard kept it: the fallback when the lease cannot be read.
  let inFlightStartedAt: number | null = null;
  let leaseUnavailable = false;

  return {
    async enter(enteredAt: number = Date.now()): Promise<ExclusiveRunEntry> {
      if (inFlightStartedAt !== null && enteredAt - inFlightStartedAt < input.ttlMs) {
        return { entered: false, heldBy: null, inFlightForMs: enteredAt - inFlightStartedAt, via: "process" };
      }
      // Marked BEFORE the claim's await, so a second run in this process cannot slip in while it is asked.
      const token = enteredAt;
      inFlightStartedAt = token;
      const holder = (input.newHolder ?? newJobLeaseHolderId)();
      const claim = await claimJobLease(clientOrUnavailable(input.client), { holder, jobKey: input.jobKey, ttlSeconds });

      if (!claim.held) {
        if (inFlightStartedAt === token) inFlightStartedAt = null;
        const expiresMs = claim.expiresAt ? Date.parse(claim.expiresAt) : Number.NaN;
        const inFlightForMs = Number.isFinite(expiresMs) ? Math.max(0, enteredAt - (expiresMs - ttlSeconds * 1000)) : null;
        return { entered: false, heldBy: claim.holder, inFlightForMs, via: "lease" };
      }

      const unavailableDetail = claim.reason === "lease_unavailable" ? claim.detail : null;
      const viaLease = unavailableDetail === null;
      if (unavailableDetail !== null && !leaseUnavailable) {
        leaseUnavailable = true;
        input.onLeaseAvailability?.(unavailableDetail);
      } else if (viaLease && leaseUnavailable) {
        leaseUnavailable = false;
        input.onLeaseAvailability?.(null);
      }

      let released = false;
      return {
        entered: true,
        async release() {
          if (released) return;
          released = true;
          // Only this run's own mark: a run that outlived its ttl must not clear its successor's.
          if (inFlightStartedAt === token) inFlightStartedAt = null;
          if (viaLease) await releaseJobLease(clientOrUnavailable(input.client), { holder, jobKey: input.jobKey });
        },
        via: viaLease ? "lease" : "process",
      };
    },
  };
}
