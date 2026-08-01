// Which build is currently serving?
//
// Cloud Run injected `K_REVISION` (the active revision name) and the deploy workflow injected
// `COMMIT_SHA` as a build arg. Neither exists on Railway, which supplies `RAILWAY_GIT_COMMIT_SHA`
// instead. After the 2026-08-01 cutover both Cloud Run variables were gone, so every captured
// error was stamped `release: "unknown"` — and because the "is this signature still happening on
// the current build?" comparison then matched the ENTIRE history, errors a deploy genuinely fixed
// kept reading Active forever. /api/healthz and /api/readyz reported `revision: null` for the same
// reason.
//
// Deliberately kept in one dependency-free module. The capture path (app/api/errors/client) and
// the query path (error-monitor/derived-status) MUST resolve this identically — if they ever drift,
// no stored row matches the current release and the comparison silently returns nothing rather than
// failing. Anything that needs the running build's identity should import from here.
//
// Precedence: an explicitly-set COMMIT_SHA wins (a deploy pipeline that stamps it means it), then
// the platform's own value.

export function getDeployRevision(): string | null {
  return (
    process.env.COMMIT_SHA
    || process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.K_REVISION
    || null
  );
}

/** The same value as a always-present string, for fields that cannot hold null. */
export function getDeployRevisionTag(): string {
  return getDeployRevision() ?? "unknown";
}
