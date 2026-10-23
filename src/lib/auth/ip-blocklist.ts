// IP blocklist used by the login path (enforcement) and the System Audit login-security section
// (admin management). Blocks are time-bound by default (see the migration) so a mistake
// self-heals; enforcement is fail-open so a DB blip can never lock everyone out.

import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const DEFAULT_BLOCK_DAYS = 30;

export type BlockedIp = {
  ip: string;
  reason: string | null;
  blockedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
};

/**
 * Login enforcement check. Returns true only if the exact IP has an active block
 * (expires_at is null or in the future). FAIL-OPEN: any error / no IP → false, so a
 * blocklist outage never blocks legitimate logins. Must be called with the SAME ip value
 * the login attempts table records (getRequestIp) so a block actually matches.
 */
export async function isIpBlocked(ip: string | null): Promise<boolean> {
  if (!ip) return false;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await getSupabaseAdmin()
      .from("blocked_ips")
      .select("ip, expires_at")
      .eq("ip", ip)
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] as { expires_at: string | null } | undefined;
    if (!row) return false;
    return row.expires_at === null || row.expires_at > nowIso;
  } catch (error) {
    logError("isIpBlocked failed (failing open — not blocking)", { labels: { event: "ip_blocklist_check_failed", ip }, error });
    return false;
  }
}

/** Admin: block an IP (upsert). `days` null → permanent; otherwise expires in `days`. */
export async function blockIp(input: { ip: string; reason?: string | null; blockedBy?: string | null; days?: number | null }): Promise<void> {
  const ip = input.ip.trim();
  if (!ip) throw new Error("ip is required");
  const days = input.days === null ? null : input.days ?? DEFAULT_BLOCK_DAYS;
  const expiresAt = days === null ? null : new Date(Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await getSupabaseAdmin()
    .from("blocked_ips")
    .upsert(
      {
        blocked_by: input.blockedBy ?? null,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        ip,
        reason: input.reason ?? null,
      },
      { onConflict: "ip" },
    );
  if (error) throw error;
}

/** Admin: remove a block. */
export async function unblockIp(ip: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from("blocked_ips").delete().eq("ip", ip.trim());
  if (error) throw error;
}

/**
 * Admin: currently-active blocks (for the login-security section). THROWS on a failed read — it
 * used to return [] and the screen then said "no IPs are blocked" while blocks were in force. The
 * caller names the source as unavailable instead. Enforcement (isIpBlocked above) stays fail-open.
 */
export async function getBlockedIps(): Promise<BlockedIp[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("blocked_ips")
    .select("ip, reason, blocked_by, created_at, expires_at")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    blockedBy: (row.blocked_by as string | null) ?? null,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
    ip: row.ip as string,
    reason: (row.reason as string | null) ?? null,
  }));
}
