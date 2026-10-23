import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { claimJobLease, createJobLeaseKeeper, type JobLeaseRpcClient } from "../src/lib/platform/job-lease.ts";

/**
 * ONE CRM POLLER ACROSS EVERY PROCESS (23 Oct 2026 audit, P5-05).
 *
 * The live poller was a singleton per PROCESS only; the deploy overlap and a standby each ran their
 * own. It now claims a lease in public.job_leases before every tick and stands by when another live
 * process holds it. The lease must never be the reason the CRM stops: until the migration is applied
 * (or whenever the lease cannot be read) every claim answers "held", exactly today's behaviour.
 */

/** An in-memory claim_job_lease with the migration's semantics: free, ours, or expired → ours. */
function fakeLeaseDb(nowRef: { ms: number }) {
  const rows = new Map<string, { expiresMs: number; holder: string }>();
  const client: JobLeaseRpcClient = {
    async rpc(fn, args) {
      assert.equal(fn, "claim_job_lease");
      const key = String(args.p_job_key);
      const holder = String(args.p_holder);
      const row = rows.get(key);
      if (!row || row.holder === holder || row.expiresMs < nowRef.ms) {
        rows.set(key, { expiresMs: nowRef.ms + Number(args.p_ttl_seconds) * 1000, holder });
      }
      const current = rows.get(key)!;
      return { data: [{ expires_at: new Date(current.expiresMs).toISOString(), held: current.holder === holder, holder: current.holder }], error: null };
    },
  };
  return client;
}

export async function runJobLeaseTests() {
  const clock = { ms: Date.parse("2026-10-23T10:00:00Z") };
  const db = fakeLeaseDb(clock);

  const a = createJobLeaseKeeper({ client: () => db, holder: "host-a:1:aaaa", jobKey: "crm-live-poll", ttlSeconds: 180 });
  const b = createJobLeaseKeeper({ client: () => db, holder: "host-b:1:bbbb", jobKey: "crm-live-poll", ttlSeconds: 180 });

  assert.equal(await a.ensure(), true, "the first process claims the lease");
  assert.equal(await b.ensure(), false, "a second live process stands by — two pollers never tick together");
  clock.ms += 60_000;
  await a.renew();
  clock.ms += 150_000; // 210 s after the first claim: past the ttl of the FIRST claim, inside the renewal's
  assert.equal(await b.ensure(), false, "a holder that keeps renewing keeps the lease through a long run");
  clock.ms += 200_000; // the holder died: no renewal
  assert.equal(await b.ensure(), true, "once the holder stops renewing, the standby takes over within the ttl");
  assert.equal(await a.ensure(), false, "and the old holder, if it was only stalled, now stands by");

  // Fail open: no function yet (migration not applied), any error, or an unreadable answer.
  const missing: JobLeaseRpcClient = {
    async rpc() {
      return { data: null, error: { code: "PGRST202", message: "Could not find the function public.claim_job_lease" } };
    },
  };
  const result = await claimJobLease(missing, { holder: "h", jobKey: "crm-live-poll", ttlSeconds: 180 });
  assert.equal(result.held, true, "before the migration is applied the poller runs exactly as it did");
  assert.equal(result.reason, "lease_unavailable");
  const throwing: JobLeaseRpcClient = {
    rpc() {
      throw new Error("network down");
    },
  };
  assert.equal((await claimJobLease(throwing, { holder: "h", jobKey: "k", ttlSeconds: 180 })).held, true, "a lease that cannot be read never stops the poller");
  const blank: JobLeaseRpcClient = {
    async rpc() {
      return { data: [], error: null };
    },
  };
  assert.equal((await claimJobLease(blank, { holder: "h", jobKey: "k", ttlSeconds: 180 })).held, true);

  // The poller is wired to it: every tick claims before any work, and a heartbeat renews it.
  const poller = readFileSync("src/lib/crm/live-poller.ts", "utf8");
  const tick = poller.slice(poller.indexOf("async function tick(): Promise<void> {"));
  assert.match(tick.slice(0, 1_500), /if \(!\(await liveLease\.ensure\(\)\)\) return;/, "each tick claims the lease before any vendor call");
  assert.ok(tick.indexOf("liveLease.ensure()") < tick.indexOf("seedMarkers("), "and before any deep-run weighing");
  assert.match(poller, /LIVE_POLL_LEASE_TTL_SECONDS = 180/);
  assert.match(poller, /setInterval\(\(\) => void liveLease\.renew\(\), LIVE_POLL_LEASE_HEARTBEAT_MS\)/, "a heartbeat renews the lease while held");
  assert.match(poller, /clearInterval\(leaseHeartbeat\)/, "and stopping the poller stops the heartbeat");

  // The migration: one table, RLS on, browser roles locked out, takeover only when free/ours/expired.
  const migration = readFileSync("supabase/migrations/20261023140000_job_leases.sql", "utf8");
  assert.match(migration, /create table if not exists public\.job_leases/);
  assert.match(migration, /alter table public\.job_leases enable row level security;/);
  assert.match(migration, /revoke all on public\.job_leases from anon, authenticated;/);
  assert.match(migration, /where l\.holder = excluded\.holder or l\.expires_at < now\(\);/, "a live holder's lease is never taken");
  assert.match(migration, /revoke execute on function public\.claim_job_lease\(text, text, integer\) from public, anon, authenticated;/);
}
