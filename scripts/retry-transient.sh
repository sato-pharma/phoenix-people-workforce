#!/usr/bin/env bash
#
# Retry a command ONLY when it fails with a transient Cloud Build / Cloud Run error,
# with escalating backoff. Genuine (non-transient) failures are surfaced immediately
# so a broken build never silently retries four times.
#
# The specific failure this exists for: `gcloud builds submit` and
# `gcloud run deploy --source` both submit a build to Cloud Build and poll its status.
# Cloud Build caps "Build and Operation Get requests" at 60/min/project. When two
# source builds in the same GCP project poll concurrently they blow past it and one
# gets HTTP 429 RATE_LIMIT_EXCEEDED (observed 2026-07-17 staging burst; see
# .github/workflows/deploy-cloud-run*.yml and PR #1029/#1032). The deploy workflows
# also share a GitHub Actions concurrency group so their own two jobs never overlap;
# this wrapper is the belt-and-suspenders for any residual contention. Because the
# quota is per-minute, the >=60s backoff lets the window reset before retrying.
#
# Second caller, same shape (2026-09-04): ci.yml's dependency-audit step. `pnpm audit`
# POSTs the dependency graph to registry.npmjs.org's bulk-advisory endpoint and has no
# retry of its own worth the name — two attempts at 10s/1m, then the step dies with a
# bare `TimeoutError: The operation was aborted due to timeout`. That registry blip
# failed `validate` twice in 31 minutes (runs 33832022834 and 33833948465), each time
# AFTER every real check had passed, so the PR's Test and Build steps never ran. A
# genuine vulnerability finding fails with an advisory table and matches none of the
# markers below, so wrapping the audit changes nothing the gate gates on.
#
# Usage:   scripts/retry-transient.sh <command> [args...]
# Tunables (env): RETRY_MAX_ATTEMPTS (default 4), RETRY_BASE_WAIT_SECONDS (default 60).
# Exit code: 0 on success; otherwise the failing command's last exit code.

set -uo pipefail

max_attempts="${RETRY_MAX_ATTEMPTS:-4}"
base_wait="${RETRY_BASE_WAIT_SECONDS:-60}"

# Case-insensitive markers of a retryable transient error. Two classes, both
# genuinely transient — a real build/compile failure, or a real auth *misconfig*,
# matches none of these and is surfaced to the caller on the first attempt:
#   1. Cloud Build quota / 5xx / network blips — the original reason (HTTP 429 on the
#      60/min "Get requests" quota when two source builds poll concurrently; see
#      PR #1029/#1032).
#   2. Workload Identity token-refresh timeouts. The OIDC->GCP token exchange (and
#      gcloud's mid-run re-refresh during `builds submit`) intermittently cannot reach
#      Google's STS endpoint and fails with "Unable to retrieve Identity Pool subject
#      token" / "upstream connect error" / "connection timeout". A ~5-min GCP auth blip
#      on 2026-07-17 hard-failed BOTH the prod and staging deploys of commit 19d5a572
#      this way, while the very next commit deployed fine. These are connectivity
#      errors, NOT credential/permission errors — a broken WIF provider or unauthorized
#      service account surfaces as 403 / PERMISSION_DENIED, deliberately absent below —
#      so retrying with the same escalating backoff is safe and lets the endpoint
#      recover instead of turning a transient blip into a red deploy.
#   3. pnpm's fetch aborts and network markers (added 2026-09-04 for the CI dependency
#      audit — see the header note). pnpm prints `TimeoutError: The operation was
#      aborted due to timeout` when its abort controller fires, `FetchError` /
#      `ECONNRESET` / `ETIMEDOUT` / `ECONNREFUSED` on socket failures, and `ERR_PNPM_FETCH_*`
#      on registry non-2xx. A lockfile, parse, or vulnerability-table failure contains
#      none of these, so it is still surfaced on the first attempt.
transient_re='RATE_LIMIT_EXCEEDED|Quota exceeded|Get requests per minute|(^|[^0-9])(429|503)([^0-9]|$)|network connectivity|Deadline exceeded|connection reset|Unable to retrieve Identity Pool subject token|refreshing your current auth tokens|upstream connect error|disconnect/reset before headers|connection timeout|TimeoutError|aborted due to timeout|FetchError|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ERR_PNPM_FETCH'

if [ "$#" -eq 0 ]; then
  echo "retry-transient: no command given" >&2
  exit 2
fi

log="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '$log'" EXIT

attempt=0
while :; do
  attempt=$((attempt + 1))

  # Run the command, streaming output live AND capturing it for classification.
  "$@" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}

  if [ "$rc" -eq 0 ]; then
    exit 0
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "retry-transient: '$1' failed after ${attempt} attempt(s) (exit ${rc}); giving up." >&2
    exit "$rc"
  fi

  if ! grep -qiE "$transient_re" "$log"; then
    echo "retry-transient: '$1' failed (exit ${rc}) with a non-transient error; not retrying." >&2
    exit "$rc"
  fi

  wait_s=$((attempt * base_wait))
  echo "retry-transient: '$1' hit a transient Cloud Build/Run error on attempt ${attempt}; retrying in ${wait_s}s..." >&2
  sleep "$wait_s"
done
