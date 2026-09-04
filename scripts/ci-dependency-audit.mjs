#!/usr/bin/env node
/**
 * The CI dependency audit, with npm's outages told apart from real vulnerabilities.
 *
 * WHY THIS EXISTS. The step used to be a bare `pnpm audit --audit-level=high --prod`, which exits
 * non-zero for two completely different reasons: a high-severity advisory against a production
 * dependency, and `registry.npmjs.org` failing to answer. Only the first is a reason to stop a
 * merge. On 2026-09-04 the second one took the required `validate` check red twice inside three
 * hours — once on a PR and once on `main`, which is production's own branch — with the identical
 * signature both times:
 *
 *     [WARN] POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23).
 *     [23] The operation was aborted due to timeout
 *     TimeoutError: The operation was aborted due to timeout
 *
 * The audit is the FIRST step in `validate`, so when it dies nothing behind it runs: no tests, no
 * build. A red check that never looked at the code is worse than no check, because it reads as the
 * change being broken.
 *
 * WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT. The command, its flags and its exit
 * semantics for a REAL finding are untouched — `pnpm audit --audit-level=high --prod`, so
 * `auditConfig.ignoreGhsas` in pnpm-workspace.yaml keeps applying exactly as before and a genuine
 * high or critical advisory still fails the build. The only new behaviour is that a failure whose
 * output is a TRANSPORT failure is retried, and if the registry never answers it is reported as a
 * GitHub warning annotation and the step passes.
 *
 * THE FAIL-OPEN IS DELIBERATE AND BOUNDED. Fail-closed here means npm's uptime decides whether
 * this company can ship a payroll fix, and the failure mode is silent — you cannot tell it from a
 * real vulnerability without opening the log. Fail-open costs at most one cycle of advisory
 * coverage, on a lockfile that did not change, and it is announced loudly in the job summary
 * rather than swallowed. Anything that is NOT recognisably a transport failure still fails.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** How many times to ask the registry before giving up on it. */
const ATTEMPTS = 3;

/** Backoff between attempts, ms. Deliberately short — pnpm already retries internally. */
const BACKOFF_MS = [0, 15_000, 45_000];

/**
 * Signatures of "the registry did not answer", as opposed to "the registry answered and the answer
 * was bad news". Matched case-insensitively against pnpm's combined stdout+stderr.
 *
 * Every one of these is a transport-layer symptom. None of them can be produced by an advisory:
 * a real finding prints a table of packages and severities and says nothing about sockets.
 */
const TRANSPORT_SIGNATURES = [
  "the operation was aborted",
  "timeouterror",
  "etimedout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "socket hang up",
  "network error",
  "request to https://registry.npmjs.org",
  "security/advisories/bulk error",
  "err_pnpm_registries_mismatch",
  "err_invalid_url",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway",
];

/**
 * Is this failure the registry being unreachable, rather than a vulnerability?
 *
 * Exported for `tests/ci-dependency-audit.test.ts`, which pins BOTH directions — the outage text
 * that actually took CI down, and a real advisory report, which must never be classified as a
 * transport failure no matter what words happen to appear in a package name.
 */
export function isTransportFailure(output) {
  if (typeof output !== "string" || output.trim() === "") return false;
  const haystack = output.toLowerCase();
  // A report that names advisories is a FINDING, whatever else it says. Checked first so a
  // package or advisory title containing e.g. "network error" cannot be read as an outage.
  if (/\b(critical|high|moderate|low)\b\s*\|/.test(haystack)) return false;
  if (haystack.includes("vulnerable versions")) return false;
  if (haystack.includes("advisories found")) return false;
  return TRANSPORT_SIGNATURES.some((signature) => haystack.includes(signature));
}

function runAudit() {
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["audit", "--audit-level=high", "--prod"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { output, status: result.status ?? 1, spawnError: result.error ?? null };
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  let last = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    sleep(BACKOFF_MS[attempt] ?? 0);
    last = runAudit();
    process.stdout.write(last.output);

    if (last.status === 0 && !last.spawnError) {
      console.log(`\nDependency audit passed${attempt > 0 ? ` on attempt ${attempt + 1}` : ""}.`);
      return 0;
    }

    if (!isTransportFailure(last.output)) {
      // A real finding, or a failure shape nobody has classified yet. Both stop the build: this
      // script exists to stop npm's uptime gating a merge, NOT to make the audit advisory.
      console.error(
        "\nDependency audit FAILED with high or critical advisories against production"
        + " dependencies (or with an unrecognised error). This is not a registry outage — read the"
        + " output above and fix the dependency.",
      );
      return 1;
    }

    console.error(
      `\nAttempt ${attempt + 1} of ${ATTEMPTS} could not reach the npm advisory service.`,
    );
  }

  const note =
    "npm's advisory service did not answer after "
    + `${ATTEMPTS} attempts, so the dependency audit could not run. This is an npm outage, not a`
    + " vulnerability — the step passes rather than blocking the merge. Re-run this job once"
    + " https://status.npmjs.org reports the registry healthy.";

  console.error(`\n${note}`);
  // Surfaced on the run summary, so a skipped audit is visible without opening the log.
  console.log(`::warning title=Dependency audit skipped (npm unreachable)::${note}`);
  return 0;
}

// Only when executed as the CI step — importing it from a test must not run pnpm.
// `pathToFileURL` rather than a hand-built `file://` string: on Windows the hand-built form is
// `file://F:/...` against an actual `file:///F:/...`, so the guard would never match and the test
// import would be the only thing that ever ran it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
