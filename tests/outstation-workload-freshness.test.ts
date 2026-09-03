import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveWorkloadFreshness } from "../src/lib/outstation/workload-freshness.ts";

// An outstation request's workload verdict is stamped ONCE, at submission — the one moment the
// CRM is guaranteed to be emptiest, because visits are entered through and after the trip and the
// iReports360 mirror syncs after that. Nothing ever re-reads it.
//
// Measured on production 2026-09-03 across all 80 trips, counting what the live read counts
// (Regular + Campaign, rep as primary agent OR double-visit partner): 26 requests carry
// `no_activity`, 14 of them are contradicted by the live read over 135 visit rows, and 12 are
// genuinely empty. Of the 14, EIGHT arrived after the stamp (avg 8.6h later) and SIX were already
// visible when it was stamped — five of those six written by the retired `double_visit_import`
// path, which was blind to a rep's solo field days. Two causes, neither repaired today.
//
// The failure is quiet and money-adjacent: the admin request drawer printed "Workload match: No
// activity" as a plain fact twenty lines above a live panel listing the visits the traveller
// actually made. The stale line is the one shaped like a summary, so an approver reading it sees
// evidence that someone did nothing on a trip they were paid for.
//
// This file pins the comparison, and pins that both screens still carry it.

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/outstation/workload-freshness.ts", import.meta.url)),
  "utf8",
);
const PANEL_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/outstation/trip-workload-evidence.tsx", import.meta.url)),
  "utf8",
);
const DRAWER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/outstation/outstation-requests-admin.tsx", import.meta.url)),
  "utf8",
);

const base = {
  liveAmWorkload: 0,
  liveMatchStatus: "matched",
  livePmWorkload: 0,
  storedAmWorkload: 0,
  storedMatchedAt: "2026-08-05T08:00:00.000Z",
  storedMatchStatus: "no_activity",
  storedPmWorkload: 0,
} as const;

export async function runOutstationWorkloadFreshnessTests() {
  // 1. THE CASE THIS EXISTS FOR. Stored says nobody worked; the CRM has since disagreed.
  const stale = resolveWorkloadFreshness({ ...base, liveAmWorkload: 3, livePmWorkload: 5 });
  assert.equal(stale.verdict, "stale", "a stored 'no activity' with live visits must be reported as stale");
  assert.equal(stale.liveTotal, 8, "liveTotal is AM + PM from the live read");
  assert.equal(stale.storedTotal, 0, "storedTotal is AM + PM from the stamped snapshot");
  assert.equal(stale.missedVisits, 8, "every live visit the snapshot never saw counts as missed");
  assert.ok(stale.headline, "a stale verdict must carry a sentence a reviewer can act on");
  assert.match(
    String(stale.headline),
    /no activity/i,
    "the headline must name the stored verdict, because that is the line the approver read",
  );
  assert.match(
    String(stale.headline),
    /stamped 5 Aug 2026/,
    "the headline must date the stamp in Africa/Cairo, so 'out of date' is a claim the reader can check",
  );

  // 2. A GENUINE zero stays genuine. These are the 8 real cases, and turning them into warnings
  // would bury the signal the owner actually wants — a paid trip with no field work behind it.
  const genuine = resolveWorkloadFreshness(base);
  assert.equal(genuine.verdict, "fresh", "a stored 'no activity' the CRM still agrees with is not stale");
  assert.equal(genuine.headline, null, "nothing to say means say nothing — no warning on a correct verdict");

  // 3. An UNMAPPED traveller has no CRM identity, so a live zero is not evidence of anything.
  // Judging one would accuse someone on the strength of a missing mapping.
  const unmapped = resolveWorkloadFreshness({ ...base, liveMatchStatus: "unmapped" });
  assert.equal(unmapped.verdict, "unknown", "an unmapped traveller can never be judged against a live read");
  assert.equal(unmapped.headline, null, "an unmapped traveller gets no warning");

  // 4. A HUMAN override outranks this entirely. Someone already looked and decided.
  const overridden = resolveWorkloadFreshness({
    ...base,
    liveAmWorkload: 9,
    storedMatchStatus: "manual_override",
  });
  assert.equal(overridden.verdict, "unknown", "a manual override must never be contradicted by an automatic read");
  assert.equal(overridden.headline, null, "a manual override gets no warning");

  // 5. NEVER accuse in the other direction. Visits can be deleted or re-dated in the CRM, so
  // stored-higher-than-live is someone else's edit, not a traveller's dishonesty.
  const shrank = resolveWorkloadFreshness({
    ...base,
    liveAmWorkload: 1,
    livePmWorkload: 0,
    storedAmWorkload: 6,
    storedMatchStatus: "matched",
    storedPmWorkload: 4,
  });
  assert.equal(shrank.verdict, "fresh", "live LOWER than stored must not be reported — a CRM deletion is not evidence");
  assert.equal(shrank.missedVisits, 0, "missedVisits must never go negative");

  // 6. A 'matched' verdict that has since grown is still worth naming, because the counts the
  // reviewer reads in the fact grid are the stamped ones.
  const grew = resolveWorkloadFreshness({
    ...base,
    liveAmWorkload: 7,
    livePmWorkload: 3,
    storedAmWorkload: 2,
    storedMatchStatus: "matched",
    storedPmWorkload: 1,
  });
  assert.equal(grew.verdict, "stale", "a stamped count the CRM has since exceeded is stale");
  assert.equal(grew.missedVisits, 7, "missedVisits is live minus stored");

  // 7. A missing stored verdict is not a defect — imported expenses have none.
  for (const empty of [null, undefined, "", "   "]) {
    const none = resolveWorkloadFreshness({ ...base, liveAmWorkload: 4, storedMatchStatus: empty });
    assert.equal(none.verdict, "unknown", `a stored verdict of ${JSON.stringify(empty)} cannot be judged`);
  }

  // 8. An unparseable stamp must not reach a reviewer as "Invalid Date".
  const badStamp = resolveWorkloadFreshness({
    ...base,
    liveAmWorkload: 2,
    storedMatchedAt: "not-a-date",
  });
  assert.equal(badStamp.verdict, "stale", "a bad stamp must not suppress the warning itself");
  assert.doesNotMatch(String(badStamp.headline), /invalid date/i, "an unparseable stamp is omitted, never printed");

  // 9. THE WIRING. The comparison is worthless if the screen stops feeding it both sides — and
  // that is exactly the failure shape here, since a panel that silently gets no stored verdict
  // renders no warning and looks perfectly healthy.
  assert.match(
    PANEL_SOURCE,
    /resolveWorkloadFreshness\(\{/,
    "the evidence panel must run the comparison — it is the only place both sides exist at once",
  );
  assert.match(
    PANEL_SOURCE,
    /Stored verdict is out of date/,
    "the panel must render the staleness callout, not merely compute a verdict",
  );
  assert.match(
    DRAWER_SOURCE,
    /storedMatchStatus=\{request\.workloadMatchStatus \?\? null\}/,
    "the request drawer must pass its stamped verdict to the panel, or the warning can never fire",
  );
  assert.match(
    DRAWER_SOURCE,
    /storedMatchedAt=\{request\.workloadMatchedAt \?\? null\}/,
    "the request drawer must pass the stamp date, so the warning can date itself",
  );

  // 10. The fact that misled must stay dated. Undated, it reads as the current state of the world.
  assert.match(
    DRAWER_SOURCE,
    /label="Workload match \(at submission\)"/,
    "the stored workload fact must say when it was taken — undated it reads as live truth",
  );

  // 11. This module must stay DEPENDENCY-FREE. It is reached from a "use client" component, and
  // in this repo one server-only import inside a client graph does not fail that page alone — it
  // 500s every later request including /api/healthz, which reads as a broken dev server rather
  // than a bad import. Pinning "no imports at all" is stronger than listing forbidden ones, and
  // it cannot be defeated by a new transitive chain.
  const importLines = MODULE_SOURCE.split("\n").filter((line) => /^\s*import[\s{*]/.test(line));
  assert.deepEqual(
    importLines,
    [],
    "workload-freshness is client-reachable, so it must import nothing at all — not even a type",
  );

  // 12. It must stay a REPORTER. `workload_evidence_snapshot` is also the input to the
  // campaign-visit rejection rule in decision.ts, so anything here that wrote or re-stamped would
  // move outstation money with nobody asking. The owner's standing rule is that the system flags
  // an expense and a human decides — so the module's entire public surface is one pure function.
  const exportedValues = [...MODULE_SOURCE.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(
    exportedValues,
    ["resolveWorkloadFreshness"],
    "the module must export exactly one pure function — no writer, no re-stamp, no decision path",
  );
}
