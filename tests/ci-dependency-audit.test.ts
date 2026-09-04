import assert from "node:assert/strict";

import { isTransportFailure } from "../scripts/ci-dependency-audit.mjs";

/**
 * The classifier that decides whether a failing `pnpm audit` stops a merge.
 *
 * BOTH DIRECTIONS MATTER AND THEY FAIL DIFFERENTLY. Missing an outage costs a red required check
 * that never read the code — recoverable, visible, annoying. Misreading a REAL advisory as an
 * outage would wave a vulnerable production dependency into a payroll system and print a warning
 * nobody reads. So the advisory cases below are the load-bearing half, and they are written to be
 * hostile: reports whose text deliberately contains outage vocabulary.
 */
export function runCiDependencyAuditTests() {
  // ── The outage that actually happened, verbatim from run 33827928620 ──────────────────────────
  const realOutage = [
    "[WARN] POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23)."
    + " Will retry in 10 seconds. 2 retries left.",
    "[23] The operation was aborted due to timeout",
    "TimeoutError: The operation was aborted due to timeout",
    "    at new DOMException (node:internal/per_context/domexception:76:18)",
  ].join("\n");
  assert.equal(
    isTransportFailure(realOutage),
    true,
    "the npm advisory-endpoint timeout that took `validate` red twice on 2026-09-04 must read as an outage, not a vulnerability",
  );

  for (const transport of [
    "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed",
    "FetchError: getaddrinfo ENOTFOUND registry.npmjs.org",
    "Error: socket hang up",
    "read ECONNRESET",
    "connect ECONNREFUSED 104.16.0.35:443",
    "503 Service Unavailable",
  ]) {
    assert.equal(isTransportFailure(transport), true, `transport failure not recognised: ${transport}`);
  }

  // ── A real finding must NEVER be waved through ────────────────────────────────────────────────
  const realAdvisory = [
    "┌─────────────────────┬────────────────────────────────────────────────────────────┐",
    "│ critical            │ Prototype Pollution in lodash                              │",
    "├─────────────────────┼────────────────────────────────────────────────────────────┤",
    "│ Vulnerable versions │ <4.17.21                                                   │",
    "└─────────────────────┴────────────────────────────────────────────────────────────┘",
    "1 vulnerabilities found",
  ].join("\n");
  assert.equal(
    isTransportFailure(realAdvisory),
    false,
    "a critical advisory must fail the build, never be reported as an npm outage",
  );

  // Hostile: an advisory whose own text carries outage vocabulary. The finding must still win.
  const advisoryNamingNetworkWords = [
    "│ high                │ Denial of service via socket hang up in ws                 │",
    "│ Vulnerable versions │ <8.17.1                                                    │",
  ].join("\n");
  assert.equal(
    isTransportFailure(advisoryNamingNetworkWords),
    false,
    "an advisory whose TITLE contains transport wording is still an advisory — the finding wins over the signature list",
  );

  assert.equal(
    isTransportFailure("high | Some advisory | advisories found"),
    false,
    "'advisories found' marks a report, so it can never be classified as an outage",
  );

  // ── Nothing to classify is not an outage ─────────────────────────────────────────────────────
  for (const empty of ["", "   ", null, undefined, 42]) {
    assert.equal(
      isTransportFailure(empty as string),
      false,
      "an empty or non-string output fails closed — an unexplained failure must stop the build",
    );
  }

  assert.equal(
    isTransportFailure("ERR_PNPM_NO_LOCKFILE  Cannot audit without a lockfile"),
    false,
    "a pnpm usage error is not a network outage and must stop the build",
  );
}
