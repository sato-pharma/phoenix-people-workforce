import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientAddress } from "@/lib/security/client-address";

const fallbackBuckets = new Map<string, { count: number; resetAt: number }>();

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
  const now = Date.now();
  const existing = fallbackBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    fallbackBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (existing.count >= limit) {
    throw new ApiRateLimitError(Math.max(1, Math.ceil((existing.resetAt - now) / 1000)));
  }

  existing.count += 1;
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
    if (isRateLimitSchemaMissing(error)) {
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
