/**
 * Phoenix CRM — fingerprinting the photos, and filing what the comparison finds.
 *
 * The judgement itself is pure and lives in `@/lib/phoenix-crm/duplicate-photos`; this file is its
 * I/O: it finds photos with no fingerprint, reads each one ONCE, computes the two hashes, and then
 * compares the new ones against the recent corpus and writes the evidence.
 *
 * THREE RULES GOVERN EVERYTHING HERE.
 *
 *   1. THE REP MUST NOT KNOW (owner, 2026-09-25, Golden Rule #1). Nothing in this file runs on a
 *      rep's request, changes a response, or writes a column any rep-facing read selects. It runs at
 *      night, as the system, and its output goes to a table the field app cannot reach.
 *
 *   2. EVERY PHOTO IS READ ONCE, FOREVER. A fingerprint row is written for every photo the sweep
 *      touches — including one it could not read, which is recorded with a `failure` so it is never
 *      downloaded again and so the board can tell NOT CHECKED from clean. Re-reading the bucket
 *      nightly would cost more egress every night for an answer that cannot change.
 *
 *   3. IT MUST NEVER COST A REP HIS VISIT, and it must never take a night's sweep down over one bad
 *      object. Every photo is wrapped on its own; a failure is a row, not an exception.
 *
 * WHY `sharp` IS IMPORTED INSIDE THE FUNCTION. A top-level `import sharp` has taken this repository
 * down once already by 500ing a whole page when the native binary did not load. It is a native
 * module, this file is reachable from the route graph, and the cost of being wrong is a blank page
 * rather than a missed hash — so it is loaded lazily, inside the one function that needs it.
 */

import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { runPhoenixCrmBehaviourSweep, type BehaviourSweepResult } from "@/lib/phoenix-crm/server/behaviour";
import {
  dhashFromGreyscale,
  judgePhotoDuplicate,
  PHOTO_HASH_HEIGHT,
  PHOTO_HASH_WIDTH,
  type PhotoFingerprint,
} from "@/lib/phoenix-crm/duplicate-photos";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { downloadPhoto } from "@/lib/phoenix-crm/server/photos";
import { runPhoenixCrmSignboardSweep, type SignboardSweepResult } from "@/lib/phoenix-crm/server/signboard-sweep";
import { runPhoenixCrmSilentSweep, type SilentSweepResult } from "@/lib/phoenix-crm/server/silent-detectors";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** How many photos one night reads. A field day is a few hundred; this drains a backlog too. */
export const PHOTO_SWEEP_LIMIT = 400;

/**
 * How far back the fuzzy comparison looks.
 *
 * Six months, not forever. A re-used photograph is re-used soon — the whole point of it is to stand
 * in for a visit that should have happened this week — and an unbounded corpus turns one nightly
 * read into a table scan that grows for the life of the system. The exact-match half is not bounded
 * this way: a sha256 lookup is one indexed read whatever the table holds.
 */
export const PHOTO_COMPARE_DAYS = 180;

/**
 * A ceiling on the in-memory corpus, so one night can never pull an unbounded table into RAM.
 *
 * 🔴 A CEILING, NOT A PAGE SIZE: PostgREST stops every response at 1,000 rows whatever `.limit()` asks
 * for, so the corpus reaches this only through the pager in `loadPhotoCorpus`.
 */
export const PHOTO_CORPUS_MAX = 20_000;

/** How many photos are downloaded and hashed at once. Each holds one photo's bytes while it is read. */
const PHOTO_READS_AT_ONCE = 4;

export type PhotoSweepResult = {
  /** Photos that had no fingerprint and were read this run. */
  fingerprinted: number;
  /** Of those, how many could not be read at all. */
  failed: number;
  /** Captures the comparison filed evidence about. */
  flagged: number;
  /** True when the sweep stopped on its own limit — there is more backlog waiting. */
  moreWaiting: boolean;
};

type Candidate = {
  subjectKind: "visit" | "place";
  subjectId: string;
  photoPath: string;
  seatId: string | null;
  repHrId: string;
  customerId: string | null;
  capturedAt: Date;
  isTest: boolean;
};

function toCandidate(row: Row): Candidate | null {
  const photoPath = String(row.photo_path ?? "");
  const subjectId = String(row.subject_id ?? "");
  const capturedAt = new Date(String(row.captured_at));
  const repHrId = String(row.rep_hr_id ?? "").toUpperCase();
  if (!photoPath || !subjectId || Number.isNaN(capturedAt.getTime())) return null;
  return {
    subjectKind: row.subject_kind === "place" ? "place" : "visit",
    subjectId,
    photoPath,
    seatId: row.seat_id ? String(row.seat_id) : null,
    repHrId,
    customerId: row.customer_id ? String(row.customer_id) : null,
    capturedAt,
    isTest: row.is_test === true,
  };
}

async function loadCandidates(limit: number, includeTest: boolean): Promise<Candidate[]> {
  const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_photos_to_fingerprint", {
    p: { limit, include_test: includeTest },
  });
  throwIfError(error);
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  return rows.map(toCandidate).filter((entry): entry is Candidate => entry !== null);
}

/**
 * The two hashes of one photo's bytes.
 *
 * `sharp` is asked for a raw greyscale thumbnail and nothing else — the bit arithmetic that turns it
 * into a hash is pure and lives in the rules module, where it is tested against pixels written by
 * hand rather than against whatever an image library happens to produce this version.
 */
async function hashBytes(bytes: Uint8Array): Promise<{ sha256: string; dhash: string | null }> {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  let dhash: string | null = null;
  try {
    const { default: sharp } = await import("sharp");
    const thumbnail = await sharp(Buffer.from(bytes))
      .greyscale()
      .resize(PHOTO_HASH_WIDTH, PHOTO_HASH_HEIGHT, { fit: "fill" })
      .raw()
      .toBuffer();
    dhash = dhashFromGreyscale(thumbnail);
  } catch {
    // A picture sharp cannot decode still has a sha256, which catches the easy re-send. The fuzzy
    // half simply does not apply to it, and that is recorded as a null rather than as a clean hash.
    dhash = null;
  }
  return { sha256, dhash };
}

/**
 * Everything a new photo is compared against: the recent fingerprints, newest first.
 *
 * 🔴 PAGED. Until 2026-10-02 this read ended in `.limit(PHOTO_CORPUS_MAX)` — it asked for 20,000 and
 * PostgREST, which stops every response at 1,000 rows with no error, gave 1,000. Newest first, so a
 * photo was compared only with the newest 1,000 fingerprints, and a picture re-used from a few weeks
 * back was never seen at all. At the ceiling the read STOPS rather than refuses: the order puts the
 * newest first, so the comparison simply looks back less far (`src/lib/phoenix-crm/server/paged-read.ts`).
 *
 * Takes its client so the paging test can hand it a fake that stops at 1,000 rows, as the server does.
 */
export async function loadPhotoCorpus(client: Pick<SupabaseClient, "from">, includeTest: boolean): Promise<PhotoFingerprint[]> {
  const since = new Date(Date.now() - PHOTO_COMPARE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const read = await readEveryPage<Row>(
    () => {
      let query = client
        .from("phoenix_crm_photo_fingerprints")
        .select("subject_kind, subject_id, photo_path, rep_hr_id, customer_id, captured_at, sha256, dhash")
        .gte("captured_at", since);
      if (!includeTest) query = query.eq("is_test", false);
      // A TOTAL order — the photo path is the identity — or paging drops and repeats rows.
      return query.order("captured_at", { ascending: false }).order("photo_path", { ascending: true });
    },
    { maxRows: PHOTO_CORPUS_MAX, whenFull: "stop", what: "The photo corpus", uniqueBy: (row) => String(row.photo_path ?? "") },
  );
  throwIfError(read.error);
  const out: PhotoFingerprint[] = [];
  for (const row of read.rows) {
    const capturedAt = new Date(String(row.captured_at));
    if (Number.isNaN(capturedAt.getTime())) continue;
    out.push({
      subjectKind: row.subject_kind === "place" ? "place" : "visit",
      subjectId: String(row.subject_id ?? ""),
      photoPath: String(row.photo_path ?? ""),
      repHrId: String(row.rep_hr_id ?? "").toUpperCase(),
      customerId: row.customer_id ? String(row.customer_id) : null,
      capturedAt,
      sha256: row.sha256 ? String(row.sha256) : null,
      dhash: row.dhash ? String(row.dhash) : null,
    });
  }
  return out;
}

// 🔴 THE VISIT DAY ENDS AT 02:00 CAIRO (owner, 2026-09-29), and this filed the CALENDAR day until
// 2026-10-02 — so a visit logged at 01:30 was filed on the day after the one its own visit row,
// every other CRM reader and the board's own visit column call it. The evidence then named a day the
// rep did not work, which is the worst possible wording on a page about his honesty. `visit_date` is
// the same arithmetic as `phoenix_crm_save_visit` now.

/**
 * Read every photo that has none, hash it, and judge the new ones against the recent corpus.
 *
 * Returns a count and throws nothing a caller has to handle per photo: a photo that fails is a row
 * with a `failure` on it. It DOES let a failure of the batch reads themselves escape, so the cron's
 * dead-man's switch records a night that did not run rather than reporting a silent success.
 */
export async function runPhoenixCrmPhotoSweep(options: { limit?: number; includeTest?: boolean } = {}): Promise<PhotoSweepResult> {
  const limit = Math.max(1, Math.min(2_000, options.limit ?? PHOTO_SWEEP_LIMIT));
  const includeTest = options.includeTest === true;
  const candidates = await loadCandidates(limit, includeTest);
  const result: PhotoSweepResult = { fingerprinted: 0, failed: 0, flagged: 0, moreWaiting: candidates.length >= limit };
  if (candidates.length === 0) return result;

  const supabase = getSupabaseAdmin();
  const fresh: PhotoFingerprint[] = [];
  const rows: Row[] = [];

  // Each photo is still read once and wrapped on its own; they are simply fetched a few at a time
  // rather than one after another (Phoenix CRM performance audit, 2026-10-16). The answers come back
  // in the candidates' own order, so the rows below are written exactly as the one-at-a-time walk
  // wrote them. Four, not more: each one holds a photo's bytes in memory while sharp reads it.
  const readings = await mapWithConcurrency(candidates, PHOTO_READS_AT_ONCE, async (candidate) => {
    let sha256: string | null = null;
    let dhash: string | null = null;
    let failure: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const bytes = await downloadPhoto(candidate.photoPath);
      if (!bytes || bytes.length === 0) {
        failure = "the object is missing or empty";
      } else {
        sizeBytes = bytes.length;
        const hashes = await hashBytes(bytes);
        sha256 = hashes.sha256;
        dhash = hashes.dhash;
      }
    } catch (error) {
      failure = String(error instanceof Error ? error.message : error).slice(0, 200);
    }
    return { sha256, dhash, failure, sizeBytes };
  });

  for (const [position, candidate] of candidates.entries()) {
    const { sha256, dhash, failure, sizeBytes } = readings[position]!;
    result.fingerprinted += 1;
    if (failure !== null) result.failed += 1;
    rows.push({
      photo_path: candidate.photoPath,
      subject_kind: candidate.subjectKind,
      subject_id: candidate.subjectId,
      seat_id: candidate.seatId,
      rep_hr_id: candidate.repHrId || null,
      customer_id: candidate.customerId,
      captured_at: candidate.capturedAt.toISOString(),
      sha256,
      dhash,
      size_bytes: sizeBytes,
      failure,
      is_test: candidate.isTest,
    });
    if (sha256 !== null) {
      fresh.push({
        subjectKind: candidate.subjectKind,
        subjectId: candidate.subjectId,
        photoPath: candidate.photoPath,
        repHrId: candidate.repHrId,
        customerId: candidate.customerId,
        capturedAt: candidate.capturedAt,
        sha256,
        dhash,
      });
    }
  }

  // `ignoreDuplicates` because the photo path is the identity and two sweeps overlapping must not
  // fight: the first fingerprint of a photo is the only one that ever needs to exist.
  const written = await supabase.from("phoenix_crm_photo_fingerprints").upsert(rows, { onConflict: "photo_path", ignoreDuplicates: true });
  throwIfError(written.error);

  if (fresh.length === 0) return result;

  // One corpus read for the whole batch, taken AFTER the insert so this run's own photos compare
  // against each other — a rep who sent the same picture twice in one day is the obvious case, and a
  // corpus read beforehand would be blind to exactly it.
  const corpus = await loadPhotoCorpus(supabase, includeTest);
  const byPath = new Map(candidates.map((entry) => [entry.photoPath, entry]));
  const evidence: Row[] = [];
  for (let i = 0; i < fresh.length; i += 1) {
    // Each judgement walks the whole corpus synchronously; yield to the event loop every 25 so a
    // large nightly batch never holds the server's one thread long enough to stall live requests.
    if (i % 25 === 24) await new Promise((resolve) => setImmediate(resolve));
    const photo = fresh[i];
    const verdict = judgePhotoDuplicate(photo, corpus);
    if (verdict.flags.length === 0) continue;
    const candidate = byPath.get(photo.photoPath);
    evidence.push({
      subject_kind: photo.subjectKind,
      subject_id: photo.subjectId,
      source: "photo",
      seat_id: candidate?.seatId ?? null,
      rep_hr_id: photo.repHrId || null,
      customer_id: photo.customerId,
      captured_at: photo.capturedAt.toISOString(),
      visit_date: cairoBusinessDay(photo.capturedAt),
      flags: verdict.flags,
      strong: verdict.strong,
      signals: { ...verdict.signals, photoPath: photo.photoPath },
      is_test: candidate?.isTest === true,
    });
  }

  if (evidence.length > 0) {
    // 🔴 `source` is part of the conflict target. Without it this write would REPLACE the GPS verdict
    // on the same visit instead of sitting beside it — see the migration's header.
    const filed = await supabase.from("phoenix_crm_location_integrity").upsert(evidence, { onConflict: "subject_kind,subject_id,source" });
    throwIfError(filed.error);
    result.flagged = evidence.length;
  }

  return result;
}

/**
 * The nightly sweep, as the cron calls it: the photos first, then the month's shape.
 *
 * 🔴 THE ORDER IS LOAD-BEARING, not tidiness. The behaviour pass reads the month whole and is
 * recomputed whole, so it must run after anything that could add evidence about the same month —
 * and a duplicate photograph found tonight is exactly that. Reversing them would leave the
 * behaviour verdict one night stale, every night, for ever.
 *
 * Both passes are allowed to throw. That is the opposite of the rule inside a rep's save, and it is
 * right here: a night that failed must reach the dead-man's switch as a night that failed, or the
 * sweep goes quiet and reports a silent success for as long as nobody looks.
 */
export async function runPhoenixCrmIntegritySweep(
  options: { limit?: number; today?: string } = {},
): Promise<{ photos: PhotoSweepResult; signboards: SignboardSweepResult; silent: SilentSweepResult; behaviour: BehaviourSweepResult }> {
  const photos = await runPhoenixCrmPhotoSweep({ limit: options.limit });
  // The signboard pass (2026-10-08) sits BETWEEN the two for the same reason the photos lead: a case
  // it files tonight is evidence about this month, and the behaviour pass reads the month whole. It
  // never holds a place and tells nobody — see server/signboard-sweep.ts.
  const signboards = await runPhoenixCrmSignboardSweep();
  // The roster, cadence, coverage and shared-venue checks (2026-10-12). Before the behaviour pass for
  // the same reason the other two are: every finding it files is evidence about the month the
  // behaviour pass is about to read whole. It makes no model call and downloads nothing, so it costs
  // the window far less than the signboard pass that precedes it.
  const silent = await runPhoenixCrmSilentSweep({ today: options.today });
  const behaviour = await runPhoenixCrmBehaviourSweep({ today: options.today });
  return { photos, signboards, silent, behaviour };
}
