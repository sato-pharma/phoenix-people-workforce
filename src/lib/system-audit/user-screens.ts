import {
  USER_ERROR_SCREENS_BUCKET,
  USER_ERROR_SCREENS_RETENTION_DAYS,
  USER_ERROR_SCREENS_TABLE,
} from "@/lib/error-monitor/screen-intake";
import { ERROR_SCREENSHOT_BUCKET } from "@/lib/error-monitor/screenshot-intake";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { isUuid } from "@/lib/http/uuid";
import type { ScreenKind } from "@/lib/error-monitor/screen-capture-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The error screenshots, as the System Audit reads them — the row drawer's pictures, the Super
 * Admin's image route, and the nightly 90-day retention.
 *
 * Service-role reads of a service-role-only table and a private bucket, so every caller is behind
 * assertSystemAdministratorWorkspaceAccess (the drawer and the image route) or inside the
 * CRON_SECRET-checked nightly sweep. A failed read THROWS; nothing here turns a failure into "no
 * pictures".
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

function client(override?: Client): Client {
  return override ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
}

function failure(what: string, error: { message?: string; code?: string } | null): Error {
  const code = error?.code ? ` (${error.code})` : "";
  return new Error(`System audit screenshot ${what} failed${code}: ${error?.message ?? "unknown error"}`);
}

export type UserScreenSummary = {
  id: string;
  capturedAt: string;
  kind: ScreenKind;
  httpStatus: number | null;
  width: number | null;
  height: number | null;
};

/** The screens named by `ids` that still exist (a pruned one is simply absent), oldest first. */
export async function loadUserScreenSummaries(ids: readonly string[], override?: Client): Promise<UserScreenSummary[]> {
  const wanted = Array.from(new Set(ids.filter((id) => isUuid(id)))).slice(0, 50);
  if (wanted.length === 0) return [];
  const { data, error } = await client(override)
    .from(USER_ERROR_SCREENS_TABLE)
    .select("id, created_at, kind, http_status, width, height")
    .in("id", wanted)
    .order("created_at", { ascending: true });
  if (error) throw failure("read", error);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    capturedAt: String(row.created_at),
    kind: row.kind as ScreenKind,
    httpStatus: typeof row.http_status === "number" ? row.http_status : null,
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
  }));
}

/** Whose screen a picture is, for the audit row its viewing writes (screenshot-views.ts). */
export type UserScreenTaken = {
  hrId: string | null;
  loginId: string | null;
  kind: string | null;
  pagePath: string | null;
  capturedAt: string | null;
  isTest: boolean;
};

/** One picture's bytes and whose screen it was, or null when no screen has that id (or its file is gone). */
export async function loadUserScreenImage(
  id: string,
  override?: Client,
): Promise<{ contentType: string; bytes: ArrayBuffer; taken: UserScreenTaken } | null> {
  if (!isUuid(id)) return null;
  const supabase = client(override);
  const { data, error } = await supabase
    .from(USER_ERROR_SCREENS_TABLE)
    .select("storage_path, hr_id, login_id, kind, page_path, created_at, is_test")
    .eq("id", id)
    .maybeSingle();
  if (error) throw failure("read", error);
  const row = (data ?? null) as Record<string, unknown> | null;
  const path = typeof row?.storage_path === "string" ? row.storage_path : null;
  if (!row || !path) return null;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const taken: UserScreenTaken = {
    hrId: text(row.hr_id),
    loginId: text(row.login_id),
    kind: text(row.kind),
    pagePath: text(row.page_path),
    capturedAt: text(row.created_at),
    isTest: row.is_test === true,
  };
  const { data: file, error: downloadError } = await supabase.storage.from(USER_ERROR_SCREENS_BUCKET).download(path);
  if (downloadError) {
    // A file the bucket no longer holds is "not found", never a server failure.
    if (/not.?found|404/i.test(downloadError.message ?? "")) return null;
    throw failure("download", { message: downloadError.message });
  }
  if (!file) return null;
  return {
    contentType: file.type || (path.endsWith(".webp") ? "image/webp" : "image/jpeg"),
    bytes: await file.arrayBuffer(),
    taken,
  };
}

/**
 * Pictures removed per night, at most — 10 storage calls of 100, and exactly the 1,000 rows one PostgREST
 * read returns (a larger limit would be cut to 1,000 without a word). At 500 a
 * day of more than 500 new pictures would outlive the owner’s 90 days with no alarm (risk review,
 * 23 Oct 2026). A run that hits this cap and leaves pictures past their 90 days raises an issue on
 * the System Audit board, which the morning message carries (owner, 23 Oct 2026: "alert when the
 * nightly screenshot removal hits its 1,000 cap") — detectors/user-screens.ts `buildRetentionCapFinding`.
 */
export const SCREEN_PRUNE_BATCH = 1_000;
const STORAGE_REMOVE_CHUNK = 100;

export type ScreenPruneResult = {
  cutoff: string;
  candidates: number;
  deletedRows: number;
  deletedFiles: number;
  /** Rows kept because their file could not be removed — tried again next night. */
  keptForRetry: number;
  /** The most this run would remove (SCREEN_PRUNE_BATCH, or a smaller test limit). */
  cap: number;
  /** The run read a full batch: it stopped at `cap`, not at the last old picture. */
  capped: boolean;
  /**
   * Pictures still older than the cutoff once this run finished — counted only when `capped`
   * (0 otherwise), null when that count could not be read. The System Audit raises an issue when
   * a capped run leaves any (detectors/user-screens.ts `buildRetentionCapFinding`).
   */
  remaining: number | null;
  error: string | null;
  /** The 91-day backstop for files no row points at (`pruneOrphanScreens`); absent only in a test's hand-made result. */
  orphans?: OrphanPruneResult;
};

/**
 * Files removed per night by the orphan backstop, at most — shared by its two buckets, the people's
 * pictures first. Ten Storage calls of 100, the same ceiling as the row-driven removal above.
 */
export const ORPHAN_PRUNE_BATCH = 1_000;
/** A day past the owner's 90: a file the row-driven removal is still due to take is left to it. */
const ORPHAN_MIN_AGE_DAYS = 91;
const STORAGE_LIST_PAGE = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type OrphanBucketResult = {
  bucket: string;
  /** Folders of Cairo days strictly before this one are swept; null when the bucket was not swept. */
  before: string | null;
  /** Files found to remove (up to the night's cap); null when a listing failed — never 0. */
  found: number | null;
  removed: number;
  /** Why the bucket was not swept, when it was not. */
  skipped: string | null;
  error: string | null;
};

type OrphanPruneResult = {
  cap: number;
  /** The night's cap was reached: more old files may be waiting for the next night. */
  capped: boolean;
  buckets: OrphanBucketResult[];
};

/** A file the backstop may remove: `<id>.<webp|jpg>`; anything else in a bucket is never touched. */
const ORPHAN_FILE = /^[A-Za-z0-9-]+\.(?:webp|jpg)$/;

type StorageEntry = { name: string; id: string | null };

function cairoDay(ms: number): string {
  return cairoDateTimeSortable(new Date(ms).toISOString()).slice(0, 10);
}

/** The crash pictures' own retention days (service.ts `pruneOldAppErrorEvents`), plus a day, never under 91. */
function errorScreenshotOrphanDays(): number {
  const configured = Number(process.env.PHOENIX_ERROR_EVENT_RETENTION_DAYS);
  const retention = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 90;
  return Math.max(ORPHAN_MIN_AGE_DAYS, retention + 1);
}

/** Every entry under `prefix` that `keep` accepts, name order, paged; stops once `max` are kept. A failed page THROWS. */
async function listEntries(
  supabase: Client,
  bucket: string,
  prefix: string,
  keep: (entry: StorageEntry) => boolean,
  max: number = Number.POSITIVE_INFINITY,
): Promise<StorageEntry[]> {
  const kept: StorageEntry[] = [];
  for (let offset = 0; kept.length < max; offset += STORAGE_LIST_PAGE) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: STORAGE_LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`listing ${prefix || "the bucket"} failed: ${error.message}`);
    const page = (data ?? []) as StorageEntry[];
    for (const entry of page) {
      if (kept.length >= max) break;
      if (keep(entry)) kept.push(entry);
    }
    if (page.length < STORAGE_LIST_PAGE) break;
  }
  return kept;
}

const isFolder = (pattern: RegExp) => (entry: StorageEntry) => entry.id === null && pattern.test(entry.name);
const isOrphanFile = (entry: StorageEntry) => entry.id !== null && ORPHAN_FILE.test(entry.name);

/** user-error-screens: `<yyyy-mm-dd>/<owner>/<id>.<ext>` — the paths of the old day folders' files. */
async function oldScreenFiles(supabase: Client, before: string, max: number): Promise<string[]> {
  const paths: string[] = [];
  const days = await listEntries(supabase, USER_ERROR_SCREENS_BUCKET, "", (entry) => isFolder(/^\d{4}-\d{2}-\d{2}$/)(entry) && entry.name < before);
  for (const day of days) {
    const owners = await listEntries(supabase, USER_ERROR_SCREENS_BUCKET, day.name, isFolder(/^[A-Za-z0-9_-]{1,60}$/));
    for (const owner of owners) {
      if (paths.length >= max) return paths;
      const prefix = `${day.name}/${owner.name}`;
      const files = await listEntries(supabase, USER_ERROR_SCREENS_BUCKET, prefix, isOrphanFile, max - paths.length);
      paths.push(...files.map((file) => `${prefix}/${file.name}`));
    }
  }
  return paths;
}

/** error-screenshots: `YYYY/MM/DD/<event id>.<ext>` — the paths of the old day folders' files. */
async function oldCrashFiles(supabase: Client, before: string, max: number): Promise<string[]> {
  const paths: string[] = [];
  const years = await listEntries(supabase, ERROR_SCREENSHOT_BUCKET, "", (entry) => isFolder(/^\d{4}$/)(entry) && entry.name <= before.slice(0, 4));
  for (const year of years) {
    const months = await listEntries(supabase, ERROR_SCREENSHOT_BUCKET, year.name, (entry) => isFolder(/^\d{2}$/)(entry) && `${year.name}-${entry.name}` <= before.slice(0, 7));
    for (const month of months) {
      const days = await listEntries(
        supabase,
        ERROR_SCREENSHOT_BUCKET,
        `${year.name}/${month.name}`,
        (entry) => isFolder(/^\d{2}$/)(entry) && `${year.name}-${month.name}-${entry.name}` < before,
      );
      for (const day of days) {
        if (paths.length >= max) return paths;
        const prefix = `${year.name}/${month.name}/${day.name}`;
        const files = await listEntries(supabase, ERROR_SCREENSHOT_BUCKET, prefix, isOrphanFile, max - paths.length);
        paths.push(...files.map((file) => `${prefix}/${file.name}`));
      }
    }
  }
  return paths;
}

/**
 * The backstop under both retentions: a picture file that outlived every row pointing at it is
 * removed once its day folder is more than 91 days old. The row-driven removals (above, and service.ts
 * for the crash pictures) take a file only through its row, so a file whose row never landed (an
 * upload that went through while its insert failed) or was deleted without it (before 23 Oct 2026)
 * stayed in the bucket for ever — an unmasked picture of someone's screen. A file whose row is
 * still there loses its file a night early, and that row then goes as "already missing".
 *
 * The people's pictures are bounded by the detector's watermark as well (`notAfter`): a folder is
 * swept only once every picture in it has been folded into the ledger, and not at all before the
 * first fold. At most ORPHAN_PRUNE_BATCH files a night across both buckets; a listing or removal
 * that fails is reported per bucket — `found` null, never 0 — and the caller makes the night partial.
 * Only names of the buckets' own shapes are touched.
 */
async function pruneOrphanScreens(
  input: { nowMs: number; notAfter: string | null; limit?: number },
  override?: Client,
): Promise<OrphanPruneResult> {
  const supabase = client(override);
  const cap = Math.min(input.limit ?? ORPHAN_PRUNE_BATCH, ORPHAN_PRUNE_BATCH);
  const outcome: OrphanPruneResult = { cap, capped: false, buckets: [] };
  let budget = cap;

  const notAfterMs = input.notAfter ? Date.parse(input.notAfter) : Number.NaN;
  const screensBefore = Number.isFinite(notAfterMs) ? cairoDay(Math.min(input.nowMs - ORPHAN_MIN_AGE_DAYS * DAY_MS, notAfterMs)) : null;
  const plan: Array<{ bucket: string; before: string | null; skipped: string | null; find: (before: string, max: number) => Promise<string[]> }> = [
    {
      bucket: USER_ERROR_SCREENS_BUCKET,
      before: screensBefore,
      skipped: screensBefore ? null : "the detector has not folded any picture yet",
      find: (before, max) => oldScreenFiles(supabase, before, max),
    },
    {
      bucket: ERROR_SCREENSHOT_BUCKET,
      before: cairoDay(input.nowMs - errorScreenshotOrphanDays() * DAY_MS),
      skipped: null,
      find: (before, max) => oldCrashFiles(supabase, before, max),
    },
  ];

  for (const step of plan) {
    const row: OrphanBucketResult = { bucket: step.bucket, before: step.before, found: null, removed: 0, skipped: step.skipped, error: null };
    outcome.buckets.push(row);
    if (!step.before) continue;
    if (budget <= 0) {
      row.skipped = "the night's cap was reached";
      continue;
    }
    let paths: string[];
    try {
      paths = await step.find(step.before, budget);
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      continue;
    }
    row.found = paths.length;
    budget -= paths.length;
    for (let index = 0; index < paths.length; index += STORAGE_REMOVE_CHUNK) {
      const { data: removed, error: removeError } = await supabase.storage.from(step.bucket).remove(paths.slice(index, index + STORAGE_REMOVE_CHUNK));
      if (removeError) {
        row.error = `Storage refused a removal: ${removeError.message}`;
        break;
      }
      row.removed += (removed ?? []).length;
    }
  }
  outcome.capped = budget <= 0;
  return outcome;
}

/**
 * The 90-day retention (owner, 23 Oct 2026), run inside the nightly sweep. Removes at most 1,000
 * pictures older than 90 days — and never one the detector has not folded yet (`notAfter`, its
 * watermark), so a picture is always in the ledger before it goes. Each file goes through the
 * Storage API first (a delete on storage.objects is refused by storage.protect_delete), and a row is
 * deleted only once its file is gone; a file that will not go keeps its row for the next night.
 * Then the 91-day backstop for files no row points at (`pruneOrphanScreens`), whose failure is
 * added to `error` so the night reads partial.
 */
export async function pruneUserErrorScreens(
  input: { nowMs: number; notAfter: string | null; limit?: number; orphanLimit?: number },
  override?: Client,
): Promise<ScreenPruneResult> {
  const supabase = client(override);
  const cutoffMs = input.nowMs - USER_ERROR_SCREENS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const notAfterMs = input.notAfter ? Date.parse(input.notAfter) : Number.NaN;
  const cutoff = new Date(Number.isFinite(notAfterMs) ? Math.min(cutoffMs, notAfterMs) : cutoffMs).toISOString();
  const limit = Math.min(input.limit ?? SCREEN_PRUNE_BATCH, SCREEN_PRUNE_BATCH);
  const result: ScreenPruneResult = {
    cutoff,
    cap: limit,
    candidates: 0,
    deletedRows: 0,
    deletedFiles: 0,
    keptForRetry: 0,
    capped: false,
    remaining: 0,
    error: null,
  };
  // Never folded at all: no row is old enough to be safe to remove.
  if (input.notAfter) await pruneScreenRows(supabase, result, cutoff, limit);

  result.orphans = await pruneOrphanScreens({ nowMs: input.nowMs, notAfter: input.notAfter, limit: input.orphanLimit }, supabase);
  const failed = result.orphans.buckets.filter((bucket) => bucket.error);
  if (failed.length > 0) {
    const words = `The 91-day sweep of files no row points at did not finish — ${failed.map((bucket) => `${bucket.bucket}: ${bucket.error}`).join("; ")}`;
    result.error = result.error ? `${result.error}; ${words}` : words;
  }
  return result;
}

/** The row-driven half of `pruneUserErrorScreens`: fills `result` in place. A failed read or delete THROWS. */
async function pruneScreenRows(supabase: Client, result: ScreenPruneResult, cutoff: string, limit: number): Promise<void> {
  const { data, error } = await supabase
    .from(USER_ERROR_SCREENS_TABLE)
    .select("id, storage_path")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw failure("retention read", error);
  const rows = (data ?? []) as Array<{ id: string; storage_path: string }>;
  result.candidates = rows.length;
  result.capped = rows.length >= limit;
  if (rows.length === 0) return;

  // A hundred at a time: the ids travel in the request URL, and five hundred of them would not fit.
  for (let index = 0; index < rows.length; index += STORAGE_REMOVE_CHUNK) {
    const chunk = rows.slice(index, index + STORAGE_REMOVE_CHUNK);
    const { data: removed, error: removeError } = await supabase.storage
      .from(USER_ERROR_SCREENS_BUCKET)
      .remove(chunk.map((row) => row.storage_path));
    if (removeError) {
      result.error = `Storage refused a removal: ${removeError.message}`;
      result.keptForRetry += chunk.length;
      continue;
    }
    // A file already missing is not listed as removed, and its row is just as safe to delete.
    result.deletedFiles += (removed ?? []).length;
    const ids = chunk.map((row) => row.id);
    const { error: deleteError, count } = await supabase.from(USER_ERROR_SCREENS_TABLE).delete({ count: "exact" }).in("id", ids);
    if (deleteError) throw failure("retention delete", deleteError);
    result.deletedRows += count ?? ids.length;
  }

  // A full batch means the night stopped at the cap, not at the last old picture. Count what is still
  // waiting so the System Audit can say how far behind the 90 days are; an unreadable count is null,
  // never 0, so it can never read as "caught up".
  if (result.capped) {
    const { count, error: countError } = await supabase
      .from(USER_ERROR_SCREENS_TABLE)
      .select("id", { count: "exact", head: true })
      .lt("created_at", cutoff);
    result.remaining = countError || typeof count !== "number" ? null : count;
  }
}
