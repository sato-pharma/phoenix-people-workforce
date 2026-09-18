import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

// Every brick the customer AI has named for a pharmacy text (customerPharmacyKey), per model, so the
// same question is never paid for twice. Before this store, Auto-map re-ran the AI over pharmacies
// AI suggest had just paid for, a retry after a cut connection paid again for answers the server had
// finished, and a pharmacy asked about once was asked again every time until someone saved it.
//
// Read after the free steps (customer-free-steps.ts), so anything the map itself can now answer —
// the owner's own saved mapping included — wins over a stored AI answer. An answer older than
// FRESH_DAYS is asked again: the map and the brick list the AI reasons over keep changing.
//
// Best effort in both directions. The store being unreachable, or its migration not applied yet,
// costs money, never correctness: every read that fails is a miss and every write that fails is
// skipped.

const TABLE = "source_of_sales_customer_ai_answers";
const FRESH_DAYS = 90;
// Each key is a 64-character hash, so 50 keep one read's URL near 3.5 KB, far from the ~16 KB where
// PostgREST requests start failing.
const READ_CHUNK = 50;

export function aiAnswerKeyHash(pharmacyKey: string): string {
  return createHash("sha256").update(pharmacyKey, "utf8").digest("hex");
}

// PostgREST answers a missing table with PGRST205 out of its schema cache rather than Postgres's
// 42P01, so both are the one expected case (the code can deploy before the migration applies).
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  const code = error?.code ?? "";
  return code === "PGRST205" || code === "42P01" || String(error?.message ?? "").toLowerCase().includes("schema cache");
}

function warn(action: string, error: { code?: string; message?: string } | null) {
  if (isMissingTable(error)) return;
  console.warn(`[customer-ai-answers] ${action} skipped: ${error?.code ?? ""} ${String(error?.message ?? "").slice(0, 200)}`);
}

/** Stored answers for these pharmacy keys under this model, fresher than FRESH_DAYS: pharmacy key → brick id. */
export async function readStoredAiAnswers(pharmacyKeys: readonly string[], model: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const key of pharmacyKeys) if (key) byHash.set(aiAnswerKeyHash(key), key);
  if (byHash.size === 0 || !model) return found;
  const since = new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const hashes = [...byHash.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < hashes.length; i += READ_CHUNK) chunks.push(hashes.slice(i, i + READ_CHUNK));
  try {
    const supabase = getSupabaseAdmin();
    const results = await Promise.all(
      chunks.map((chunk) =>
        supabase.from(TABLE).select("key_hash,brick_id").eq("model", model).gte("answered_at", since).in("key_hash", chunk),
      ),
    );
    for (const { data, error } of results) {
      if (error) {
        warn("read", error);
        continue;
      }
      for (const row of (data ?? []) as { key_hash: string; brick_id: string | null }[]) {
        const key = byHash.get(row.key_hash);
        const brick = String(row.brick_id ?? "").trim();
        if (key && brick) found.set(key, brick);
      }
    }
  } catch (error) {
    warn("read", error as { message?: string });
  }
  return found;
}

/** Keeps what the AI just answered. A later answer for the same pharmacy and model replaces the earlier one. */
export async function storeAiAnswers(answers: readonly { pharmacyKey: string; brickId: string }[], model: string): Promise<void> {
  const answeredAt = new Date().toISOString();
  const rows = new Map<string, { answered_at: string; brick_id: string; key_hash: string; model: string; pharmacy_key: string }>();
  for (const { pharmacyKey, brickId } of answers) {
    // The table refuses a key over 4,000 characters, and one refused row would fail the whole write.
    if (!pharmacyKey || pharmacyKey.length > 4000 || !brickId) continue;
    const hash = aiAnswerKeyHash(pharmacyKey);
    rows.set(hash, { answered_at: answeredAt, brick_id: brickId, key_hash: hash, model, pharmacy_key: pharmacyKey });
  }
  if (rows.size === 0 || !model) return;
  try {
    const { error } = await getSupabaseAdmin().from(TABLE).upsert([...rows.values()], { onConflict: "key_hash,model" });
    if (error) warn("write", error);
  } catch (error) {
    warn("write", error as { message?: string });
  }
}
