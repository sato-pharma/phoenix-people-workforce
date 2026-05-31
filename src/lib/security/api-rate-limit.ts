import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

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

function requestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || "unknown-ip";
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
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("api_rate_limit_buckets") ||
    message.includes("could not find the table") ||
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
