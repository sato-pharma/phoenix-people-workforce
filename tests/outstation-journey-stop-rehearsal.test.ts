import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_ACCOUNT_READONLY_POSTS, testAccountMayRun } from "@/lib/auth/test-persona";

import { stripComments } from "./support/comment-strip.ts";

// A test account rehearses a journey stop end to end (owner, 2026-11-03: "log in as test account and
// try the process end to end … a trip to Sohag, then a stop from Sohag to Assiut, and from Assiut
// back home"). Its Submit saves no claim, so the real Add stop has no trip; the rehearsal measures and
// prices each stop exactly as a real one and keeps nothing. This suite pins the four promises:
//   1. the rehearsal route is open to a test account and the REAL stop route stays shut to it;
//   2. the rehearsal refuses anyone who is not a test account, first, and writes nothing;
//   3. the real stop and the rehearsal share ONE measurement and ONE pricing — no fork of the rule;
//   4. the test claim screen offers it for a car trip, and the photo itself is never sent.

const root = process.cwd();
const service = stripComments(readFileSync(join(root, "src/lib/outstation/service.ts"), "utf8"));
const wizard = readFileSync(join(root, "src/components/outstation/mobile-outstation-wizard.tsx"), "utf8");
const rehearsalPanel = stripComments(
  readFileSync(join(root, "src/components/outstation/journey-stop-rehearsal.tsx"), "utf8"),
);

// The body of a top-level function: from its declaration to the next top-level declaration.
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is still in service.ts`);
  const next = source.slice(start + declaration.length).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + declaration.length + next);
}

// Everything that would store something as the person a test account mirrors.
const WRITE_MARKERS = [
  /\.insert\(/,
  /\.update\(/,
  /\.upsert\(/,
  /\.delete\(/,
  /\.rpc\(/,
  /upload[A-Za-z]*\(/,
  /writeRequiredAuditLog/,
  /writeAuditLog/,
  /afterResponse\(/,
];

const REHEARSAL_PATH = "/api/outstation/rehearse-journey-stop";

export function runOutstationJourneyStopRehearsalTests(): void {
  // ── 1. The gate ─────────────────────────────────────────────────────────────────────────────────
  assert.ok(
    (TEST_ACCOUNT_READONLY_POSTS as readonly string[]).includes(REHEARSAL_PATH),
    "the rehearsal is a read-only POST for a test account",
  );
  assert.equal(testAccountMayRun("POST", REHEARSAL_PATH), true, "a test account may rehearse a stop");
  assert.equal(testAccountMayRun("POST", "/api/outstation/12/journey-stop"), false, "the real stop stays shut to a test account");

  // ── 2. Test accounts only, and nothing written ──────────────────────────────────────────────────
  const rehearse = functionBody(service, "export async function rehearseOutstationJourneyStop(");
  const refusal = rehearse.indexOf("if (!isTestAccount(access)) {");
  assert.ok(refusal > 0, "the rehearsal refuses anyone who is not a test account");
  assert.ok(
    refusal < rehearse.indexOf("await "),
    "the refusal comes before the rehearsal reads anything",
  );
  for (const marker of WRITE_MARKERS) {
    assert.ok(!marker.test(rehearse), `rehearseOutstationJourneyStop writes (${marker}) — a rehearsal keeps nothing`);
  }
  assert.match(
    rehearse,
    /getResidenceLocationForEmployee\(identity\.employeeHrId, \{ persist: false \}\)/,
    "the rehearsal never stores a geocoded home",
  );
  assert.match(rehearse, /isWithinDepartureWindow\(/, "the rehearsal keeps the real stop's trip window");
  assert.match(rehearse, /MAX_JOURNEY_STOPS/, "the rehearsal keeps the real stop's cap");

  // ── 3. One measurement, one pricing ─────────────────────────────────────────────────────────────
  const capture = functionBody(service, "export async function captureOutstationJourneyStop(");
  for (const [name, body] of [
    ["captureOutstationJourneyStop", capture],
    ["rehearseOutstationJourneyStop", rehearse],
  ] as const) {
    assert.match(body, /await measureJourneyStop\(\{/, `${name} measures the stop through measureJourneyStop`);
    assert.match(body, /await priceJourneyStops\(\{/, `${name} prices the journey through priceJourneyStops`);
    assert.ok(!/googleDirectionsRoute\(/.test(body), `${name} must not measure a road leg of its own`);
    assert.ok(!/priceChainedJourney\(/.test(body), `${name} must not price the chain on its own`);
  }
  for (const declaration of ["async function measureJourneyStop(", "async function priceJourneyStops("]) {
    const body = functionBody(service, declaration);
    for (const marker of WRITE_MARKERS) {
      assert.ok(!marker.test(body), `${declaration} writes (${marker}) — the rehearsal runs it`);
    }
  }

  // ── 4. The screen ───────────────────────────────────────────────────────────────────────────────
  assert.match(
    wizard,
    /rehearsal: !isNonTravel \? rehearsalTripFrom\(payload, carEvidence, employeeRole, transportationType\) : null/,
    "every trip is offered the rehearsal, under the rule of the person it mirrors",
  );
  assert.match(wizard, /<JourneyStopRehearsal employeeHrId=\{employeeHrId\} trip=\{rehearsal\} \/>/);
  assert.match(rehearsalPanel, /fetch\("\/api\/outstation\/rehearse-journey-stop"/);
  assert.ok(!/imageDataUrl/.test(rehearsalPanel), "the rehearsal never sends the photo — nothing is stored");
}
