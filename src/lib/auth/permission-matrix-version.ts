/**
 * THE PERMISSION MATRIX'S SHARED VERSION (REC-083 phase 2, 19 Nov 2026) — the pure half.
 *
 * Every server keeps the effective permission matrix (the compiled defaults plus the rows of
 * `role_permission_overrides`) for 30 seconds. Saving a change on Access Control cleared the copy only
 * on the server that saved it: a second server — or the old container during a deploy — kept granting
 * what had just been revoked, or refusing what had just been granted, until its own 30 seconds ran out.
 *
 * The employee directory had the same gap and closed it the same way (employee-directory.ts): a copy held
 * longer than the check interval asks a cheap shared version, at most that often per process, and is
 * refreshed when it moved. For the matrix the version is the table's own stamp — the newest `updated_at`
 * (every save writes it) — and its row count, so a removed override moves it too. No new table.
 *
 * It only ever makes a copy FRESHER, and it never makes one emptier: a moved version marks the copy
 * stale, so the next read reloads it, and a reload that fails still serves the last-known matrix — never
 * the fail-closed cold start, which would lock every seat but the Super Admin out over another server's
 * change. A version that cannot be read changes nothing; the 30-second ceiling still bounds the copy.
 */

/** How often one process may ask the shared version, and how old a copy must be before it asks. */
export const PERMISSION_SHARED_VERSION_CHECK_MS = 10_000;
/** A version read slower than this is not waited for — the copy is served and the TTL still bounds it. */
export const PERMISSION_SHARED_VERSION_TIMEOUT_MS = 2_000;
/** Clock slack between the server that stamped a row and this one, for the first look only. */
const PERMISSION_SHARED_VERSION_SKEW_MS = 5_000;

export type PermissionSharedVersion = {
  /** The newest stamp and the row count, joined — a change to either is a change. */
  fingerprint: string;
  /** The newest stamp, in ms; null when there is none or it could not be parsed. */
  latestChangeMs: number | null;
};

/** Builds the version from what the table answered: its newest `updated_at` and its row count. */
export function permissionSharedVersionFrom(newestUpdatedAt: string | null | undefined, rowCount: number | null | undefined): PermissionSharedVersion {
  const stamp = typeof newestUpdatedAt === "string" ? newestUpdatedAt : "";
  const parsed = Date.parse(stamp);
  return {
    fingerprint: `${stamp}|${typeof rowCount === "number" ? rowCount : "?"}`,
    latestChangeMs: Number.isFinite(parsed) ? parsed : null,
  };
}

/**
 * Has the shared version moved past the copy this process holds? After the first look it is a plain
 * comparison with the version seen last. On the FIRST look in this process there is nothing to compare
 * with, so the newest stamp is compared with when the copy began loading (less the clock slack): a change
 * stamped after that may not be in it. A stamp in the future says nothing usable and is ignored.
 */
export function permissionSharedVersionMoved(input: {
  copyLoadStartedAt: number;
  current: PermissionSharedVersion;
  now: number;
  previousFingerprint: string | null;
}): boolean {
  if (input.previousFingerprint !== null) return input.current.fingerprint !== input.previousFingerprint;
  const latest = input.current.latestChangeMs;
  if (latest === null || latest > input.now + PERMISSION_SHARED_VERSION_SKEW_MS) return false;
  return latest >= input.copyLoadStartedAt - PERMISSION_SHARED_VERSION_SKEW_MS;
}
