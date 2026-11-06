import { createHash } from "node:crypto";

import { POSTGREST_ROW_CEILING } from "../supabase/row-cap-watch";
import type { RecordedRead } from "./read-recorder";

/**
 * Source proof for the owner-only MCP source host.
 *
 * A proof is what stands between "the report returned" and "the report is a complete, current
 * picture of Phoenix". It is derived from two independent kinds of evidence and is NEVER asserted by
 * the caller — there is no `complete: true` anywhere in this API:
 *
 *  1. THE READ LOG (`read-recorder.ts`). Every PostgREST request made while the report ran, as seen
 *     from underneath the loaders. A loader that swallowed a failure, a page that hit the server's
 *     row cap, a read of something nobody watermarked, and an answer that issued NO read at all (a
 *     cache) are each a refusal.
 *  2. A CHANGE WATERMARK read BEFORE and AFTER the collection. If any watched source differs between
 *     the two reads, the collection straddled a mutation and is refused. Equal watermarks mean no
 *     change was observed anywhere in the window, so the rows are one consistent picture.
 *
 * WHAT A WATERMARK CAN AND CANNOT PROVE. A row count plus the newest change stamp detects every
 * insert, every delete, and every update to a table whose change column is maintained. It cannot see
 * an update to a table with no maintained stamp. Each source therefore declares its strength, and the
 * proof carries it, so a release reviewer reads what was and was not covered instead of assuming.
 */

export type WatermarkEntry = {
  /** Exact row count, or null when the source has no countable relation. */
  rows: number | null;
  /** Newest change stamp (ISO-8601), or null when the source has none. */
  stamp: string | null;
  /** Content digest of a bounded relation, or null. */
  digest: string | null;
};
export type Watermark = Record<string, WatermarkEntry>;

export type SourceSpec = {
  dataset: string;
  /** The sources whose watermark guards this dataset. */
  watched: readonly string[];
  /** Every relation or function the loaders may read, mapped to the watched sources that guard it. */
  coverage: Readonly<Record<string, readonly string[]>>;
  /** Reads that MUST appear. A loader that answered without issuing one served a cache. */
  required: readonly (string | RegExp)[];
};

export type SourceProofFailure =
  | "no_reads"
  | "read_failed"
  | "truncated"
  | "unwatched_read"
  | "required_read_missing"
  | "watermark_missing"
  | "changed_during_read"
  | "invalid_time"
  | "no_change_stamp";

export class SourceProofError extends Error {
  readonly reason: SourceProofFailure;
  readonly detail: string;
  constructor(reason: SourceProofFailure, detail = "") {
    super(`Source proof refused: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "SourceProofError";
    this.reason = reason;
    this.detail = detail;
  }
}

export type ReadSummary = {
  requests: number;
  /** Requests whose LAST attempt failed (a retry that later succeeded does not count). */
  failed: string[];
  /** Unpaged reads that came back exactly at the server's row cap, or short of a known total. */
  truncated: string[];
  /** Distinct relation and function names read. */
  relations: string[];
};

/** Supabase's default `db-max-rows`. A read at exactly this size with no limit may have been cut. This is a detector, not a read. */
export const DEFAULT_MAX_ROWS = POSTGREST_ROW_CEILING;

export function summarizeReads(reads: readonly RecordedRead[], maxRows = DEFAULT_MAX_ROWS): ReadSummary {
  const last = new Map<string, RecordedRead>();
  for (const read of reads) last.set(read.key, read);
  const failed: string[] = [];
  const truncated: string[] = [];
  for (const read of last.values()) {
    const label = read.relation ?? read.key;
    if (!read.ok) {
      failed.push(label);
      continue;
    }
    if (read.method !== "GET" && read.method !== "POST") continue;
    const returned = read.rangeStart === null || read.rangeEnd === null ? 0 : read.rangeEnd - read.rangeStart + 1;
    const cappedWithoutLimit = !read.limited && returned >= maxRows;
    const shortOfTotal = read.total !== null && read.rangeEnd !== null && read.rangeEnd + 1 < read.total && !read.limited;
    if (cappedWithoutLimit || shortOfTotal) truncated.push(label);
  }
  return {
    requests: last.size,
    failed: failed.sort(),
    truncated: truncated.sort(),
    relations: [...new Set(reads.map((read) => read.relation).filter((name): name is string => name !== null))].sort(),
  };
}

const verified = new WeakSet<object>();

export type VerifiedProof = Readonly<{
  dataset: string;
  period: string;
  startedAt: string;
  /** The last instant at which the sources were verified unchanged. */
  observedAt: string;
  /** The newest business-change stamp across the watched sources. */
  updatedAt: string;
  requests: number;
  relations: readonly string[];
  sources: Readonly<Watermark>;
}>;

export function isVerifiedProof(value: unknown): value is VerifiedProof {
  return typeof value === "object" && value !== null && verified.has(value);
}

export function assertVerifiedProof(value: unknown): VerifiedProof {
  if (!isVerifiedProof(value)) throw new SourceProofError("watermark_missing", "projection carries no verified proof");
  return value;
}

const SKEW_MS = 5_000;
const same = (a: WatermarkEntry | undefined, b: WatermarkEntry | undefined) =>
  !!a && !!b && a.rows === b.rows && a.stamp === b.stamp && a.digest === b.digest;
const present = (entry: WatermarkEntry | undefined) =>
  !!entry && (entry.rows !== null || entry.stamp !== null || entry.digest !== null);

export type ProofInput = {
  spec: SourceSpec;
  period: string;
  startedAt: string;
  finishedAt: string;
  reads: readonly RecordedRead[];
  before: Watermark;
  after: Watermark;
  maxRows?: number;
};

/** Refuses, with a named reason, anything that cannot be shown complete and consistent. */
export function verifySourceProof(input: ProofInput): VerifiedProof {
  const { spec } = input;
  const summary = summarizeReads(input.reads, input.maxRows);
  if (summary.requests === 0) throw new SourceProofError("no_reads", "the report issued no database read, so it was served from a cache");
  if (summary.failed.length) throw new SourceProofError("read_failed", summary.failed.join(","));
  if (summary.truncated.length) throw new SourceProofError("truncated", summary.truncated.join(","));

  const unwatched = summary.relations.filter((name) => !(spec.coverage[name]?.length));
  if (unwatched.length) throw new SourceProofError("unwatched_read", unwatched.join(","));
  const missing = spec.required.filter((need) =>
    !summary.relations.some((name) => (typeof need === "string" ? name === need : need.test(name))),
  );
  if (missing.length) throw new SourceProofError("required_read_missing", missing.map(String).join(","));

  const started = Date.parse(input.startedAt);
  const finished = Date.parse(input.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new SourceProofError("invalid_time");

  const sources: Watermark = {};
  let newest = Number.NEGATIVE_INFINITY;
  for (const name of spec.watched) {
    const before = input.before[name];
    const after = input.after[name];
    if (!present(before) || !present(after)) throw new SourceProofError("watermark_missing", name);
    if (!same(before, after)) throw new SourceProofError("changed_during_read", name);
    sources[name] = { ...after };
    if (after.stamp !== null) {
      const stamp = Date.parse(after.stamp);
      if (!Number.isFinite(stamp) || stamp > finished + SKEW_MS) throw new SourceProofError("invalid_time", name);
      newest = Math.max(newest, stamp);
    }
  }
  if (!Number.isFinite(newest)) throw new SourceProofError("no_change_stamp", spec.dataset);

  const proof: VerifiedProof = Object.freeze({
    dataset: spec.dataset,
    period: input.period,
    startedAt: new Date(started).toISOString(),
    observedAt: new Date(finished).toISOString(),
    updatedAt: new Date(Math.min(newest, finished)).toISOString(),
    requests: summary.requests,
    relations: Object.freeze([...summary.relations]),
    sources: Object.freeze(sources),
  });
  verified.add(proof);
  return proof;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A snapshot id that is a pure function of the dataset's CONTENT: identical rows give an identical
 * id however many times they are re-read, so a pagination cursor survives a refresh that changed
 * nothing, and any change to any row invalidates it. Row order does not matter.
 */
export function contentSnapshotId(dataset: string, period: string, rows: readonly unknown[]): string {
  const hash = createHash("sha256");
  hash.update(`${dataset}\u0000${period}\u0000${rows.length}\u0000`);
  for (const line of rows.map(canonical).sort()) hash.update(`${line}\u0000`);
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type SealedFreshness = { snapshotId: string; sourceUpdatedAt: string; sourceObservedAt: string };

/** The only way freshness is produced: from a verified proof and the exact rows being published. */
export function sealFreshness(proof: VerifiedProof, rows: readonly unknown[]): SealedFreshness {
  assertVerifiedProof(proof);
  return {
    snapshotId: contentSnapshotId(proof.dataset, proof.period, rows),
    sourceUpdatedAt: proof.updatedAt,
    sourceObservedAt: proof.observedAt,
  };
}
