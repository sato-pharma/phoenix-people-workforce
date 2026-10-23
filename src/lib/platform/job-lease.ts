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
