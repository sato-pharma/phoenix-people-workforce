import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SuppressionReason = "hard_bounce" | "complaint" | "unsubscribe" | "manual";

/**
 * Add (or refresh) a durable email suppression. Most-recent status wins via the address
 * primary key. Used by the webhook (bounce/complaint), the one-click unsubscribe
 * endpoint, and admin tooling. Idempotent.
 */
export async function addEmailSuppression(input: {
  address: string;
  bounceSubtype?: string | null;
  expiresAt?: string | null;
  reason: SuppressionReason;
  source: string;
}): Promise<boolean> {
  const address = input.address.trim().toLowerCase();
  if (!address) return false;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("email_suppressions").upsert(
    {
      address,
      bounce_subtype: input.bounceSubtype ?? null,
      expires_at: input.expiresAt ?? null,
      reason: input.reason,
      source: input.source,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "address" },
  );
  if (error) {
    logError("Failed to add email suppression", { labels: { event: "email_suppression_add_failed", source: input.source, reason: input.reason }, error });
    return false;
  }
  return true;
}
