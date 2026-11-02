import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TEST_ACCOUNT_DRY_RUN_POSTS,
  TEST_ACCOUNT_READONLY_POSTS,
  testAccountMayRun,
} from "@/lib/auth/test-persona";

// A test account submits an expense the way the real person does and NOTHING is kept (owner,
// 2026-10-28: "be able to submit expense", answered "Runs fully, saves nothing"). The gate lets four
// outstation POSTs through; this suite pins the promise that makes that safe:
//   1. exactly those paths run, and nothing else under /api/outstation/;
//   2. submitOutstationRequest returns `dryRun` for a test account BEFORE its first upload or row;
//   3. the location capture and pricing it runs first write nothing as her;
//   4. the form says "checked, not saved" instead of "Claim submitted".

const root = process.cwd();
const service = readFileSync(join(root, "src/lib/outstation/service.ts"), "utf8");
const wizard = readFileSync(join(root, "src/components/outstation/mobile-outstation-wizard.tsx"), "utf8");

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
  /notifyOutstation[A-Za-z]*\(/,
  /releaseOutstationRequest[A-Za-z]*\(/,
  /afterResponse\(/,
];

export function runTestAccountExpenseDryRunTests(): void {
  // ── 1. The gate ─────────────────────────────────────────────────────────────────────────────────
  for (const path of ["/api/outstation/capture-location", "/api/outstation/calculate"]) {
    assert.ok((TEST_ACCOUNT_READONLY_POSTS as readonly string[]).includes(path), `${path} runs for a test account`);
  }
  assert.deepEqual([...TEST_ACCOUNT_DRY_RUN_POSTS], ["/api/outstation/submit", "/api/outstation/sync-offline"]);
  for (const path of TEST_ACCOUNT_DRY_RUN_POSTS) {
    assert.equal(testAccountMayRun("POST", path), true, `a test account may submit through ${path}`);
    assert.equal(testAccountMayRun("PUT", path), false, `only a POST to ${path} is a dry run`);
    assert.equal(testAccountMayRun("POST", `${path}/x`), false, `an exact path, never a prefix (${path})`);
  }
  for (const path of [
    "/api/outstation/expenses",
    "/api/outstation/policy",
    "/api/outstation/medical-rep-expenses",
    "/api/outstation/12/ticket",
    "/api/outstation/12/departure-photo",
  ]) {
    assert.equal(testAccountMayRun("POST", path), false, `${path} still saves nothing for a test account`);
  }

  // ── 2. Submit stops before its first write ──────────────────────────────────────────────────────
  const submit = functionBody(service, "export async function submitOutstationRequest(");
  const stop = submit.indexOf("if (isTestAccount(access)) {");
  assert.ok(stop > 0, "submitOutstationRequest stops a test account");
  assert.match(
    submit.slice(stop, stop + 200),
    /return \{ \.\.\.calculation, dryRun: true as const, id: null \};/,
    "the stop returns the priced claim marked dryRun, with no claim id",
  );
  const beforeStop = submit.slice(0, stop);
  for (const marker of WRITE_MARKERS) {
    assert.ok(
      !marker.test(beforeStop),
      `submitOutstationRequest writes (${marker}) before a test account is stopped — move the stop above it`,
    );
  }
  // The residence lookup it runs before the stop must not store a geocoded home as her.
  assert.match(beforeStop, /getResidenceLocationForEmployee\([^)]*persist: !isReadOnlyViewer\(access\)/);
  // Both submit routes end in that one function.
  assert.match(functionBody(service, "export async function syncOfflineOutstationRequest("), /return submitOutstationRequest\(/);

  // ── 3. Capture and pricing write nothing ────────────────────────────────────────────────────────
  for (const declaration of [
    "export async function captureOutstationLocation(",
    "export async function calculateOutstationExpense(",
    "async function validateCapturedLocation(",
    "async function calculateNonTravelExpense(",
    "async function getEmployeeIdentity(",
    "async function assertNoDuplicateTrip(",
  ]) {
    const body = functionBody(service, declaration);
    for (const marker of WRITE_MARKERS) {
      assert.ok(!marker.test(body), `${declaration} writes (${marker}) — a test account runs it`);
    }
  }
  assert.match(
    functionBody(service, "async function validateCapturedLocation("),
    /getResidenceLocationForEmployee\(identity\.employeeHrId, \{ persist: !isReadOnlyViewer\(params\.access\) \}\)/,
    "the capture never stores a geocoded home for a test account",
  );

  // ── 4. The form says it was not saved ───────────────────────────────────────────────────────────
  assert.match(wizard, /const TEST_CLAIM_NOT_SAVED_TITLE = "Test claim — checked, not saved";/);
  assert.match(wizard, /payload\?\.dryRun === true/, "Submit reads the dry run");
  assert.match(wizard, /replayed\?\.dryRun === true/, "the offline replay reads the dry run");
  assert.match(wizard, /if \(claim\.dryRun\) \{\s*return \(\s*<TestClaimPanel/, "a dry run never shows 'Claim submitted'");
}
