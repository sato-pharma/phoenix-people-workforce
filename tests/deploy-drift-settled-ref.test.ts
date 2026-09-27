// The deploy drift check must never be able to cause the drift it measures.
//
// WHY THIS EXISTS. On 2026-09-27 this workflow withheld a production deploy. It compared
// production against main HEAD for equality with a 3-minute grace, and that grace was written
// 2026-08-13, when a merge deployed immediately. The deploy is now GATED on the commit's own CI
// (Railway "Wait for CI"), so it does not even START until CI concludes. Measured on cd9e0be03
// (#4579), all times UTC:
//
//     22:29:46  merge                    22:29:49  ci.yml starts
//     22:32:24  this check fires — production is legitimately still the older revision
//     22:35:13  ci.yml GREEN             22:35:35  this check concludes FAILURE
//     22:35:40  Railway marks the deployment SKIPPED — five seconds later
//
// ci.yml was 100% green. The only red check suite on that commit was this workflow's own
// scheduled run, and Railway withholds a deploy when ANY suite on the commit fails — so the
// false alarm made itself true. It went unnoticed because the next merge carries production
// forward, which is exactly why a test has to hold the invariant instead of a reader noticing.
//
// The counterfactual was measured, not argued: at 22:32:24 the settled ref would have been
// 287872eb7 (the newest commit older than 15 minutes), production was already serving b91bd8c0c
// (success at 22:26:03Z), and `compare 287872eb7...b91bd8c0c` returns `ahead` — in sync, exit 0,
// no failing suite, no withheld deploy.
//
// Each invariant is asserted SEPARATELY with its own message. A single combined regex would make
// every clause after the first unreachable, which is the defect that hid a dead assertion in
// tests/next-build-cpu-cap.test.ts on 2026-09-27.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW = resolve(".github/workflows/deploy-drift-check.yml");

/** The two comparison steps, split out so neither can be fixed while the other is left behind. */
function comparisonSteps(source: string): { label: string; body: string }[] {
  const steps: { label: string; body: string }[] = [];
  const re = /^ {6}- name: Compare (production|staging)'s deployed revision[^\n]*\n/gm;
  let match: RegExpExecArray | null;
  const starts: { label: string; at: number }[] = [];
  while ((match = re.exec(source)) !== null) starts.push({ label: match[1], at: match.index });
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : source.length;
    steps.push({ label: s.label, body: source.slice(s.at, end) });
  });
  return steps;
}

export function runDeployDriftSettledRefTests() {
  const source = readFileSync(WORKFLOW, "utf8");
  const steps = comparisonSteps(source);

  assert.equal(
    steps.length,
    2,
    "deploy-drift-check.yml must have exactly two comparison steps (production and staging); " +
      `found ${steps.length}. If a step was renamed, this test stops guarding it.`,
  );

  for (const { label, body } of steps) {
    // 1 — the defect itself: never compare the live revision against HEAD for equality.
    assert.ok(
      !/\[\s*"\$LIVE_SHA"\s*=\s*"\$(HEAD|MAIN|BRANCH)_SHA"\s*\]/.test(body),
      `${label}: compares the live revision against HEAD for equality. That is the 2026-09-27 ` +
        "defect: this repo merges every few minutes, so production is legitimately behind HEAD " +
        "almost always, and the deploy does not even start until the commit's CI concludes. " +
        "Compare against the SETTLED ref with ancestry instead.",
    );

    // 2 — a settled reference commit is resolved, by time, from a named window.
    assert.ok(
      /SETTLE_MINUTES/.test(body) && /until=\$\{UNTIL\}/.test(body),
      `${label}: does not resolve a settled reference commit (expected SETTLE_MINUTES and an ` +
        "`until=${UNTIL}` commits query). Without it the check fires against a commit that has " +
        "had no time to ship.",
    );

    // 3 — that window must exceed CI + build, or the false positive comes straight back.
    const minutes = Number(/SETTLE_MINUTES:\s*"(\d+)"/.exec(body)?.[1] ?? "0");
    assert.ok(
      minutes >= 10,
      `${label}: SETTLE_MINUTES is ${minutes}. It must be at least 10 — the deploy waits for the ` +
        "commit's own CI first (5m24s on cd9e0be03) and only then builds, so a shorter window " +
        "expires before production can possibly have shipped.",
    );

    // 4 — ancestry, via the compare API, with no checkout.
    assert.ok(
      /compare\/\$\{REF_SHA\}\.\.\.\$\{1\}/.test(body),
      `${label}: does not test ancestry through the compare API. Equality cannot express "is ` +
        'already contained in what is live".',
    );

    // 5 — and only the two statuses that mean "the live revision contains the ref" pass.
    const accept = /case "\$status" in ([^)]*)\)/.exec(body)?.[1] ?? "";
    const accepted = accept
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(
      accepted,
      ["ahead", "identical"],
      `${label}: the in-sync set is ${JSON.stringify(accepted)}. It must be exactly ` +
        '["ahead","identical"]. Verified live 2026-09-28: ahead = production is past the settled ' +
        "ref, identical = exactly on it, behind = real drift, diverged = a rewritten history.",
    );

    // 6 — the cheap second chance stays. It is what absorbs an ordinary in-flight build.
    assert.ok(
      /sleep 180/.test(body),
      `${label}: the 3-minute grace period is gone. It costs nothing on a healthy run (only a ` +
        "mismatching run ever sleeps) and it absorbs a build that lands moments later.",
    );
  }

  // 7 — the alarm must not send the reader to ci.yml alone, which was green during the incident.
  assert.ok(
    /ANY failed or cancelled check suite on main HEAD withholds the deploy/.test(source),
    "The production alert still implies a red ci.yml is the cause. ANY failed suite on the commit " +
      "withholds the deploy — during the 2026-09-27 incident ci.yml was fully green and the only " +
      "red suite was this workflow's own run.",
  );

  assert.ok(
    /CHECK WHETHER THIS ALARM IS ITS OWN CAUSE/.test(source),
    "The production alert does not warn that this workflow's own scheduled run attaches a check " +
      "suite to main HEAD, and so can withhold the very deploy it is measuring. That is the " +
      "first thing to rule out at 4am, and it is not derivable from the other lines.",
  );

  // 8 — the stale two-hour figure must not come back; Railway skips within MINUTES of a conclusion.
  assert.ok(
    !/after two hours Railway SKIPS it/.test(source),
    "The alert still says Railway skips the deploy after two hours. Measured 2026-09-27: it is " +
      "marked SKIPPED within minutes of the failing conclusion — five seconds, in the incident " +
      "this test exists for. The two-hour timeout is a separate, rarer path.",
  );
}
