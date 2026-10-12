import type { SupabaseClient } from "@supabase/supabase-js";

import { runWithReadRecorder } from "./read-recorder";
import { SourceProofError, verifySourceProof, type SourceSpec, type VerifiedProof, type Watermark, type WatermarkEntry } from "./source-proof";

/**
 * Proven collection: run a report loader while recording every read, bracket it with a change
 * watermark, and return the value only together with a proof that refused everything it could not
 * show complete and consistent (see source-proof.ts).
 */

export type WatermarkReader = (sources: readonly string[], period: string | null) => Promise<Watermark>;

/** Reads `public.phoenix_mcp_source_watermark` (proposal/source-watermark.sql): one statement, one snapshot. */
export function createRpcWatermarkReader(db: SupabaseClient): WatermarkReader {
  return async (sources, period) => {
    const { data, error } = await db.rpc("phoenix_mcp_source_watermark", { p_sources: [...sources], p_period: period });
    if (error) throw new SourceProofError("watermark_missing", "watermark function failed");
    const result: Watermark = {};
    for (const row of (data ?? []) as { source: string; rows: number | string | null; stamp: string | null; digest: string | null }[]) {
      result[row.source] = {
        rows: row.rows === null ? null : Number(row.rows),
        stamp: row.stamp ? new Date(row.stamp).toISOString() : null,
        digest: row.digest,
      };
    }
    return result;
  };
}

/**
 * Phoenix does not maintain `updated_at` on UPDATE (no trigger exists on any watched table), so a
 * stamp read from the database can be old while the content is new. The content digest is the real
 * change detector; this wrapper turns it into a stamp by remembering when THIS process first saw the
 * current digest. After a restart that is "now", which can only make a source look newer than it is.
 */
export function withChangeClock(inner: WatermarkReader, now: () => Date = () => new Date()): WatermarkReader {
  const seen = new Map<string, { digest: string | null; at: number }>();
  return async (sources, period) => {
    const raw = await inner(sources, period);
    const out: Watermark = {};
    for (const [name, entry] of Object.entries(raw)) {
      const key = `${name}\u0000${period ?? ""}`;
      const known = seen.get(key);
      const at = known && known.digest === entry.digest ? known.at : now().getTime();
      if (!known || known.digest !== entry.digest) seen.set(key, { digest: entry.digest, at });
      const dbStamp = entry.stamp ? Date.parse(entry.stamp) : Number.NEGATIVE_INFINITY;
      out[name] = { ...entry, stamp: new Date(Math.max(dbStamp, at)).toISOString() } satisfies WatermarkEntry;
    }
    return out;
  };
}

export type ProvenRead<T> = { value: T; proof: VerifiedProof };

export type CollectorDeps = {
  watermark: WatermarkReader;
  now?: () => Date;
  /** Attempts at one collection when the sources changed under it. */
  attempts?: number;
};

export async function provenRead<T>(
  spec: SourceSpec,
  period: string,
  work: () => Promise<T>,
  deps: CollectorDeps,
): Promise<ProvenRead<T>> {
  const now = deps.now ?? (() => new Date());
  const attempts = Math.max(1, deps.attempts ?? 2);
  const scopePeriod = spec.dataset === "published_sales" ? period : null;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = now().toISOString();
    const before = await deps.watermark(spec.watched, scopePeriod);
    const run = await runWithReadRecorder(work);
    const after = await deps.watermark(spec.watched, scopePeriod);
    const finishedAt = now().toISOString();
    try {
      // A loader that threw is reported as the loader's error, but only after the read log was judged
      // so a failed source read is not mistaken for an absent record.
      const proof = verifySourceProof({ spec, period, startedAt, finishedAt, reads: run.reads, before, after });
      if (!run.ok) throw run.error;
      return { value: run.value, proof };
    } catch (error) {
      last = error;
      if (!(error instanceof SourceProofError) || error.reason !== "changed_during_read") break;
    }
  }
  throw last;
}
