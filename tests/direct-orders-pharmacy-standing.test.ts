import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROBATION_WINDOW_DAYS,
  describeDirectOrderPharmacyStanding,
  normalizeDirectOrderTrustState,
  probationDayOf,
} from "../src/lib/direct-orders/pharmacy-standing.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Spec D2 — an empty sales table must explain ITSELF, in words.
//
// The retail table has existed since #1665; what it could not say is why it is empty. Zero rows is
// produced by two opposite situations — an established pharmacy that has not bought this quarter,
// and a pharmacy one Super Admin approved from a photo that has never been proved to exist. The
// owner's rule ("an empty table must never read as zero") is precisely about not letting the
// second hide behind the first.
//
// These also pin the footprint query's column name. `findFootprint` spent its whole life querying
// `customer_code` on the SoS import table, which has no such column — so the promotion half of
// probation could never fire once, while two live pharmacies had 23 matching rows between them.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrdersPharmacyStandingTests() {
  const probationSource = readFileSync(
    new URL("../src/lib/direct-orders/pharmacy-probation.ts", import.meta.url),
    "utf8",
  );
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const detailSource = readFileSync(
    new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url),
    "utf8",
  );

  // ── The window, and the one place it may disagree ──────────────────────────
  const sweepWindow = /export const PROBATION_DAYS = (\d+);/.exec(probationSource);
  assert.ok(sweepWindow, "the sweep must still declare its own probation window");
  assert.equal(
    Number(sweepWindow[1]),
    PROBATION_WINDOW_DAYS,
    "the window the approver is shown must equal the window the sweep enforces — a countdown that " +
      "disagrees with the job behind it is worse than no countdown",
  );

  // ── Provisional, clock running: the day must be named ──────────────────────
  const running = describeDirectOrderPharmacyStanding({
    trustState: "provisional",
    probationStartedAt: "2026-08-01T00:00:00.000Z",
    now: new Date("2026-08-06T00:00:00.000Z"),
  });
  assert.equal(running.probationDay, 6, "the day a pharmacy is approved is day 1, so five days later is day 6");
  assert.match(
    running.noHistoryNote,
    /probation day 6 of 90/,
    "a provisional pharmacy must state which day of the window it is on (spec D2)",
  );

  // ── Provisional, clock NEVER started: must not become day zero ─────────────
  // All 10 provisional pharmacies live today have a null clock — they predate it. Printing "day 0
  // of 90" would promise a countdown nothing is running.
  const noClock = describeDirectOrderPharmacyStanding({
    trustState: "provisional",
    probationStartedAt: null,
    now: new Date("2026-08-06T00:00:00.000Z"),
  });
  assert.equal(noClock.probationDay, null, "a null probation clock is not day zero — it is no clock at all");
  assert.doesNotMatch(
    noClock.noHistoryNote,
    /day 0|day -\d/,
    "a pharmacy whose clock never started must never be rendered as being on day zero of the window",
  );
  assert.match(
    noClock.noHistoryNote,
    /never started/,
    "it must say the clock was never started, so the approver does not wait for a promotion that cannot arrive",
  );

  // ── Trusted: absence means "has not bought", not "unknown" ─────────────────
  const trusted = describeDirectOrderPharmacyStanding({ trustState: "trusted", probationStartedAt: null });
  assert.match(
    trusted.noHistoryNote,
    /has not bought/,
    "an established pharmacy with no sales must read as not having bought, never as unverified",
  );
  assert.doesNotMatch(
    trusted.noHistoryNote,
    /probation/,
    "a trusted pharmacy is not on probation and must not be described as though it were",
  );

  // ── The NO-CODE branch must name the trust state too ──────────────────────
  // Found by opening a real order in production: `retailUnmatchable` is checked BEFORE the
  // empty-history branch, so a provisional pharmacy with no distributor code was told only that
  // paperwork was missing. Five of the ten live provisional pharmacies had no code, and every one
  // of them read as routine. Both branches were individually correct, which is why no test caught
  // it — the bug was in which one wins.
  const provisionalNoCode = describeDirectOrderPharmacyStanding({
    trustState: "provisional",
    probationStartedAt: "2026-08-01T00:00:00.000Z",
    now: new Date("2026-08-06T00:00:00.000Z"),
  });
  assert.match(
    provisionalNoCode.noCodeNote,
    /probation day 6 of 90/,
    "a provisional pharmacy with no distributor code must STILL state its probation standing — a " +
      "missing code is paperwork, an unproved pharmacy is the risk",
  );
  assert.match(
    provisionalNoCode.noCodeNote,
    /no distributor customer code on file/,
    "it must still say the code is missing — the trust state adds to that fact, it does not replace it",
  );
  assert.match(
    provisionalNoCode.noCodeNote,
    /Register it against the distributor/,
    "the remedy must survive: the approver still needs to know what to do about the missing code",
  );

  const trustedNoCode = describeDirectOrderPharmacyStanding({ trustState: "trusted", probationStartedAt: null });
  assert.match(
    trustedNoCode.noCodeNote,
    /^This venue has no distributor customer code on file/,
    "an established venue's no-code message must be unchanged — this fix must not make every " +
      "ordinary pharmacy look suspicious",
  );
  assert.doesNotMatch(
    trustedNoCode.noCodeNote,
    /probation|provisional|phantom/,
    "a trusted pharmacy must never be described in probation language",
  );

  const phantomNoCode = describeDirectOrderPharmacyStanding({
    trustState: "phantom_suspected",
    probationStartedAt: null,
  });
  assert.match(
    phantomNoCode.noCodeNote,
    /suspected phantom/,
    "a reported phantom with no code must still lead with the report, not with the missing code",
  );

  // ── Every branch is a sentence, never a bare count ─────────────────────────
  for (const state of ["trusted", "provisional", "phantom_suspected"]) {
    const standing = describeDirectOrderPharmacyStanding({ trustState: state, probationStartedAt: null });
    assert.ok(
      standing.noHistoryNote.trim().length > 40,
      `${state} must produce prose where the table would be — the owner's rule is that an empty table never reads as zero`,
    );
    assert.doesNotMatch(standing.noHistoryNote, /^0\b/, `${state} must not open with a zero`);
  }

  // ── The clamp, so a clock skew cannot print nonsense ───────────────────────
  assert.equal(
    probationDayOf({ probationStartedAt: "2020-01-01T00:00:00.000Z", now: new Date("2026-08-06T00:00:00.000Z") }),
    PROBATION_WINDOW_DAYS,
    "a long-overdue clock clamps to the last day of the window, never past it",
  );
  assert.equal(
    probationDayOf({ probationStartedAt: "2026-08-10T00:00:00.000Z", now: new Date("2026-08-06T00:00:00.000Z") }),
    1,
    "a clock stamped in the future clamps to day 1, never a negative day",
  );
  assert.equal(probationDayOf({ probationStartedAt: "not-a-date", now: new Date() }), null, "an unparseable clock is no clock");

  // ── Unknown trust states fail to `trusted`, never to an alarm ──────────────
  assert.equal(normalizeDirectOrderTrustState(null), "trusted", "the column default is trusted");
  assert.equal(normalizeDirectOrderTrustState("provisional"), "provisional", "provisional survives normalization");
  assert.equal(
    normalizeDirectOrderTrustState("phantom_suspected"),
    "phantom_suspected",
    "a reported phantom must not be normalized away into trusted",
  );

  // ── The payload carries it, computed server-side ───────────────────────────
  assert.match(
    serviceSource,
    /pharmacyStanding: pharmacy[\s\S]{0,160}describeDirectOrderPharmacyStanding\(/,
    "the approval detail must carry pharmacyStanding built by the domain, not leave the window to infer it",
  );

  // ── The window renders the domain's sentence, and hand-rolls nothing ───────
  assert.match(
    detailSource,
    /pharmacyStanding\?\.noHistoryNote/,
    "the empty retail state must render the domain's sentence",
  );
  assert.doesNotMatch(
    detailSource,
    /No distributor sales found for this pharmacy&apos;s customer codes\./,
    "the old bare empty-state string must be gone — leaving it is how the window drifts from the rule",
  );
  assert.match(
    detailSource,
    /pharmacyStanding\?\.noCodeNote/,
    "the no-code branch must render the domain's sentence too, or it silently outranks the trust state",
  );
  assert.doesNotMatch(
    detailSource,
    /This venue has no distributor customer code on file, so its retail sales cannot be\s*\n?\s*matched\. Register it/,
    "the hand-rolled no-code paragraph must be gone — it is the branch that hid the probation state",
  );

  // ── The footprint query must name the column SoS actually has ──────────────
  assert.match(
    probationSource,
    /\.eq\("client_code", pair\.customer_code\)/,
    "the footprint lookup must filter source_of_sales_import_rows on client_code — there is no customer_code column there, " +
      "and querying one silently returned 'no footprint' for every pharmacy that ever had sales",
  );
  assert.doesNotMatch(
    probationSource,
    /\.eq\("customer_code"/,
    "no direct-order code may filter the SoS import table on customer_code again",
  );
  // Scoped to findFootprint's own body, so an `if (error) throw error` belonging to some other
  // query in the file cannot stand in for this one. Sliced by index rather than matched by regex:
  // the signature's own multi-line parameter type closes with a `}` in column 0, which truncates
  // any non-greedy `[\s\S]*?\n\}` to the argument list.
  const footprintStart = probationSource.indexOf("async function findFootprint(");
  assert.notEqual(footprintStart, -1, "findFootprint must still exist — it is the whole promotion path");
  const afterFootprint = probationSource.indexOf("export async function runDirectOrderProbationSweep", footprintStart);
  assert.notEqual(afterFootprint, -1, "the sweep must still follow findFootprint");
  const footprintBody = probationSource.slice(footprintStart, afterFootprint);
  assert.match(
    footprintBody,
    /const \{ count, error \}/,
    "the footprint lookup must capture the error, not destructure the count alone",
  );
  assert.match(
    footprintBody,
    /if \(error\) throw error;/,
    "a failed footprint lookup must throw, not read as a confirmed absence — that difference decides " +
      "whether a real pharmacy is reported to the owner as a phantom",
  );
}
