// IP blocklist used by the login path (enforcement) and the System Audit login-security section
// (admin management). Blocks are time-bound by default (see the migration) so a mistake
// self-heals. Enforcement is FAIL-CLOSED on the sign-in doors (password and both biometric routes,
// audit point 15, 2026-10-26) and fail-open for every other caller. The sign-in doors read
// `readIpBlock`, which tells an unreadable blocklist apart from a block, so an outage answers
// "temporarily unavailable" and is audited as one instead of posing as a blocked address.

import { isIP } from "node:net";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const DEFAULT_BLOCK_DAYS = 30;

/**
 * What a blocked person is told at every sign-in door (password, fingerprint, face). It used to be
 * "Too many failed login attempts. Please try again later." — untrue for a block, and a block lasts
 * 30 days, so a whole office caught behind one blocked address kept retrying a lockout that would
 * never lift (deep audit, 17 Nov 2026). Saying the network is blocked costs an attacker nothing he
 * cannot learn by switching address, and it sends a real employee to HR, who can lift it.
 */
export const BLOCKED_SIGN_IN_MESSAGE = "Sign-in from this network has been blocked. Ask HR to lift it.";

/**
 * An address that two or more different people signed in to successfully from, in the last 7 days,
 * is an office or a mobile network, not one attacker — blocking it locks all of them out. The block
 * route refuses it (409) until the Super Admin presses a second time (deep audit, 17 Nov 2026).
 */
export const SHARED_ADDRESS_LOOKBACK_DAYS = 7;
export const SHARED_ADDRESS_MIN_ACCOUNTS = 2;

/**
 * The one spelling of an address the blocklist stores and matches, or null when the text is not a
 * single internet address. The match is exact text, so "10.0.0.0/8", a typo, or an upper-case IPv6
 * used to be saved, showed "Blocked", and blocked nobody (deep audit, 17 Nov 2026). Trimmed and
 * lower-cased — the sign-in side (client-address.ts) lower-cases the address it records the same way.
 */
export function normalizeIpAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  return address && isIP(address) !== 0 ? address : null;
}

/** How many different accounts signed in successfully, counted the way the security lens counts them. */
export function countDistinctAccounts(rows: Array<{ login_id?: unknown }>): number {
  const accounts = new Set<string>();
  for (const row of rows) {
    const account = canonicalHrIdKey(typeof row.login_id === "string" ? row.login_id : null);
    if (account) accounts.add(account);
  }
  return accounts.size;
}

/**
 * The number of different accounts that signed in SUCCESSFULLY from this exact address in the last
 * SHARED_ADDRESS_LOOKBACK_DAYS. Fully paged; THROWS on a failed read, so the block route refuses
 * rather than blocking a network it could not check.
 */
export async function countRecentSuccessfulAccounts(ip: string, now = Date.now()): Promise<number> {
  const address = normalizeIpAddress(ip) ?? ip.trim();
  const since = new Date(now - SHARED_ADDRESS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<{ login_id?: unknown }>(
    () => supabase.from("auth_login_attempts").select("id, login_id").eq("ip", address).eq("success", true).gte("attempted_at", since),
    "id",
  );
  return countDistinctAccounts(rows);
}

export type BlockedIp = {
  ip: string;
  reason: string | null;
  blockedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type IpBlockCheckOptions = {
  /**
   * What an unreadable blocklist answers. `"open"` (the default) answers "not blocked". `"closed"`
   * answers "blocked" and is what every SIGN-IN route passes (audit point 15, 2026-10-26): a blocked
   * attacker who could make the read fail — or who simply arrived during a database blip — used to
   * get a free pass at the password and biometric doors. Those doors read the database for the
   * sign-in itself, so an outage that fails this read fails the sign-in anyway; refusing it costs a
   * legitimate user nothing they would have had.
   */
  onError?: "open" | "closed";
};

/**
 * What the blocklist says about one address. `"unreadable"` means the read failed — it is NOT a
 * block, and a sign-in door that refuses on it says "temporarily unavailable" and audits it as such
 * (risk review, 26 Oct): answering it as a block put "Login blocked: IP on blocklist" in the audit
 * log for an address nobody had blocked, and told the person to wait out a lockout that did not exist.
 */
export type IpBlockState = "blocked" | "clear" | "unreadable";

/**
 * Login enforcement read. `"blocked"` when the exact IP has an active block (expires_at is null or
 * in the future); `"clear"` when it has none, or there is no IP to match (a block is per address);
 * `"unreadable"` when the read failed (logged). It never throws. Must be called with the SAME ip
 * value the login attempts table records (getRequestIp) so a block actually matches.
 */
export async function readIpBlock(ip: string | null): Promise<IpBlockState> {
  if (!ip) return "clear";
  try {
    const nowIso = new Date().toISOString();
    // The stored spelling (normalizeIpAddress), so a block saved from the screen always matches.
    const { data, error } = await getSupabaseAdmin()
      .from("blocked_ips")
      .select("ip, expires_at")
      .eq("ip", normalizeIpAddress(ip) ?? ip.trim())
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] as { expires_at: string | null } | undefined;
    if (!row) return "clear";
    return row.expires_at === null || row.expires_at > nowIso ? "blocked" : "clear";
  } catch (error) {
    logError("Reading the IP blocklist failed", { labels: { event: "ip_blocklist_check_failed", ip }, error });
    return "unreadable";
  }
}

/**
 * True if the exact IP has an active block (readIpBlock). A failed read answers per
 * `options.onError` (see above). It never throws. The sign-in doors call readIpBlock instead, so an
 * outage is answered as one.
 */
export async function isIpBlocked(ip: string | null, options: IpBlockCheckOptions = {}): Promise<boolean> {
  const state = await readIpBlock(ip);
  if (state === "unreadable") return options.onError === "closed";
  return state === "blocked";
}

/**
 * Admin: block an IP (upsert). `days` null → permanent; otherwise expires in `days`. Stored in its
 * normalised spelling; anything that is not one address is refused, never saved as a block that
 * matches nothing.
 */
export async function blockIp(input: { ip: string; reason?: string | null; blockedBy?: string | null; days?: number | null }): Promise<void> {
  const ip = normalizeIpAddress(input.ip);
  if (!ip) throw new Error("Only a single internet address can be blocked.");
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
 * caller names the source as unavailable instead. Enforcement (isIpBlocked above) answers per its mode.
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
