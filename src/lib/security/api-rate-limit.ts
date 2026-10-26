import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientAddress } from "@/lib/security/client-address";
import { createMemoryRateBuckets } from "@/lib/security/memory-rate-buckets";

/**
 * The in-process stand-in for the bucket table, used ONLY by a caller that opted in with
 * `onStoreError: "memory"`. Bounded (audit, 2026-10-26, points 21 and 22): it used to be a plain Map
 * that only grew, so a caller rotating its key could grow it for as long as the process lived.
 */
export const API_RATE_LIMIT_MEMORY_MAX_KEYS = 10_000;
const fallbackBuckets = createMemoryRateBuckets(API_RATE_LIMIT_MEMORY_MAX_KEYS);

export class ApiRateLimitError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests. Please try again shortly.");
    this.name = "ApiRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isApiRateLimitError(error: unknown) {
  return error instanceof ApiRateLimitError;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** The address Railway's edge saw — never the caller-written left of X-Forwarded-For (client-address.ts). */
function requestIp(request: Request) {
  return clientAddress(request) || "unknown-ip";
}

export function rateLimitIdentity(input: {
  actor?: string | null;
  request: Request;
  token?: string | null;
}) {
  const actor = input.actor?.trim();
  if (actor) return `actor:${actor.toLowerCase()}`;
  const token = input.token?.trim();
  if (token) return `token:${sha256(token)}`;
  return `ip:${requestIp(input.request)}`;
}

function assertFallbackRateLimit(bucketKey: string, limit: number, windowMs: number) {
  const retryAfterSeconds = fallbackBuckets.consume(bucketKey, limit, windowMs);
  if (retryAfterSeconds > 0) throw new ApiRateLimitError(retryAfterSeconds);
}

function isRateLimitSchemaMissing(error: unknown) {
  const fields = [error instanceof Error ? error.message : null];
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    fields.push(
      typeof record.code === "string" ? record.code : null,
      typeof record.details === "string" ? record.details : null,
      typeof record.hint === "string" ? record.hint : null,
      typeof record.message === "string" ? record.message : null,
      typeof record.name === "string" ? record.name : null,
    );
  }
  fields.push(String(error));

  const message = fields.filter(Boolean).join(" ").toLowerCase();
  return (
    message.includes("api_rate_limit_consume") ||
    message.includes("api_rate_limit_buckets") ||
    message.includes("could not find the table") ||
    message.includes("could not find the function") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

export async function assertApiRateLimit(input: {
  identifier: string;
  limit: number;
  /**
   * What happens when the shared bucket store cannot be read or written (the database is down, or
   * the rate-limit schema is missing).
   *
   * Left out — every caller but two — the store's error is THROWN, so the caller fails closed: a
   * limit that cannot be checked is not a limit that passed.
   *
   * `"memory"` counts in this process instead, in a bounded map. Only for a public route that must
   * keep answering through a database outage and must never run unlimited while it does: the crash
   * report (a report must not depend on the database being up) and the one-time WhatsApp connection.
   * Both used to catch the store error and let the request through with no limit at all.
   */
  onStoreError?: "memory";
  scope: string;
  windowMs: number;
}) {
  const bucketKey = `${input.scope}:${sha256(input.identifier)}`;
  const now = Date.now();
  const resetAt = new Date(now + input.windowMs).toISOString();

  try {
    const supabase = getSupabaseAdmin();
    const { data: rpcData, error: rpcError } = await supabase
      .rpc("api_rate_limit_consume", {
        p_bucket_key: bucketKey,
        p_limit: input.limit,
        p_window_ms: input.windowMs,
      })
      .maybeSingle();

    if (!rpcError && rpcData) {
      const row = rpcData as { allowed?: boolean | null; retry_after_seconds?: number | null };
      if (!row.allowed) {
        throw new ApiRateLimitError(Math.max(1, Number(row.retry_after_seconds ?? 1)));
      }
      return;
    }

    if (rpcError && !isRateLimitSchemaMissing(rpcError)) {
      throw rpcError;
    }

    const { data, error } = await supabase
      .from("api_rate_limit_buckets")
      .select("bucket_key,request_count,reset_at")
      .eq("bucket_key", bucketKey)
      .maybeSingle();
    if (error) throw error;

    const row = data as { request_count?: number | null; reset_at?: string | null } | null;
    const currentResetAt = row?.reset_at ? new Date(row.reset_at).getTime() : 0;
    if (!row || currentResetAt <= now) {
      const { error: upsertError } = await supabase
        .from("api_rate_limit_buckets")
        .upsert({
          bucket_key: bucketKey,
          request_count: 1,
          reset_at: resetAt,
          updated_at: new Date(now).toISOString(),
        }, { onConflict: "bucket_key" });
      if (upsertError) throw upsertError;
      return;
    }

    const count = Number(row.request_count ?? 0);
    if (count >= input.limit) {
      throw new ApiRateLimitError(Math.max(1, Math.ceil((currentResetAt - now) / 1000)));
    }

    const { error: updateError } = await supabase
      .from("api_rate_limit_buckets")
      .update({
        request_count: count + 1,
        updated_at: new Date(now).toISOString(),
      })
      .eq("bucket_key", bucketKey);
    if (updateError) throw updateError;
  } catch (error) {
    if (error instanceof ApiRateLimitError) throw error;
    if (input.onStoreError === "memory") {
      assertFallbackRateLimit(bucketKey, input.limit, input.windowMs);
      return;
    }
    throw error;
  }
}

/**
 * Deletes rate-limit buckets whose window expired more than `graceMs` ago. Runs from
 * the daily cron so `api_rate_limit_buckets` does not accumulate dead rows on the hot
 * auth path. The 1-hour grace protects any window still in flight. Degrades gracefully
 * to a no-op when the rate-limit schema is not deployed.
 */
export async function pruneExpiredRateLimitBuckets(
  graceMs = 60 * 60 * 1000,
): Promise<{ deleted: number; skipped?: boolean }> {
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  try {
    const supabase = getSupabaseAdmin();
    const { count, error } = await supabase
      .from("api_rate_limit_buckets")
      .delete({ count: "exact" })
      .lt("reset_at", cutoff);
    if (error) throw error;
    return { deleted: count ?? 0 };
  } catch (error) {
    if (isRateLimitSchemaMissing(error)) {
      return { deleted: 0, skipped: true };
    }
    throw error;
  }
}
